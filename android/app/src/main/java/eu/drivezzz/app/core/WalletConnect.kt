package eu.drivezzz.app.core

import android.content.Context
import eu.drivezzz.app.BuildConfig
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.bouncycastle.crypto.modes.ChaCha20Poly1305
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest
import java.time.LocalTime
import java.util.Base64
import kotlin.math.max

// A debug build notes what happens with wallets in a file, to read from the Mac: real wallet apps can only be tried on a
// phone, and this says what they actually answered. Never the wc: link or an address.
//   adb pull /sdcard/Android/data/eu.drivezzz.app/files/wallet-log.txt
object WalletLog {
    private var file: File? = null
    fun init(context: Context) {
        if (BuildConfig.DEBUG) file = context.getExternalFilesDir(null)?.resolve("wallet-log.txt")
    }
    fun note(line: String) {
        if (!BuildConfig.DEBUG) return
        runCatching { file?.appendText("${LocalTime.now().withNano(0)}  $line\n") }
    }
}

internal fun hex(data: ByteArray): String = data.joinToString("") { "%02x".format(it) }
internal fun unhex(text: String): ByteArray? {
    if (text.length % 2 != 0) return null
    return runCatching { ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() } }.getOrNull()
}

// WalletConnect v2's Sign protocol, for an app asking wallets to sign, the same as Core/WalletConnect.swift: pairing through a
// wc: link, the relay (irn_ messages, encrypted so only the two sides can read them), a session, and requests over it.
// See specs.walletconnect.com. Drivezzz asks wallets for their address and to sign a ride's payment.
class WalletConnectClient {
    @Serializable
    data class Session(
        val topic: String,
        val symKey: String,
        val address: String,
        val chain: String,
        val expiry: Long,
        // Every account the wallet shared (chain:address, CAIP-10), on every chain asked for.
        val accounts: List<String>? = null,
    )

    class Failure(message: String, val rejected: Boolean = false) : Exception(message)

    companion object {
        private const val RELAY_HOST = "relay.walletconnect.org"
        // The relay (another one only for testing).
        var relayURL = "wss://relay.walletconnect.org"
        private val methods = mapOf("solana" to listOf("solana_signTransaction", "solana_signMessage"))

        private fun topic(key: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(key))

        // The proposal's namespaces: per kind of chain, its chains and what may be asked there.
        private fun namespaces(chains: List<String>): Map<String, Any?> =
            chains.groupBy { it.substringBefore(':') }.mapValues { (kind, list) ->
                mapOf("chains" to list, "methods" to (methods[kind] ?: emptyList()), "events" to emptyList<String>())
            }

        fun chacha(encrypt: Boolean, input: ByteArray, key: ByteArray, nonce: ByteArray): ByteArray {
            val cipher = ChaCha20Poly1305()
            cipher.init(encrypt, AEADParameters(KeyParameter(key), 128, nonce))
            val out = ByteArray(cipher.getOutputSize(input.size))
            val n = cipher.processBytes(input, 0, input.size, out, 0)
            return out.copyOf(n + cipher.doFinal(out, n))
        }

        fun b64url(data: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(data)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var projectId = ""
    private var socket: WebSocket? = null
    // The key per topic we listen on.
    private val keys = mutableMapOf<String, ByteArray>()
    private val relayWaiting = mutableMapOf<Long, CompletableDeferred<Unit>>()
    private val responses = mutableMapOf<Long, CompletableDeferred<JsonObject>>()
    private var settle: CompletableDeferred<JsonObject>? = null
    private var settleTopic: String? = null
    private var lastId = 0L

    // A new session: `open` gets the wc: link to hand to the wallet. Comes back when the wallet approved. `chain` is
    // the one that matters most; `also` are others the wallet may have instead.
    suspend fun connect(projectId: String, chain: String, also: List<String> = emptyList(), open: (String) -> Unit): Session {
        this.projectId = projectId
        ensureSocket()
        val symKey = NaCl.randomBytes(32)
        val pairing = topic(symKey)
        val me = NaCl.newKeyPair()
        keys[pairing] = symKey
        subscribe(pairing)
        val id = nextId()
        val expiry = System.currentTimeMillis() / 1000 + 300
        val proposal = mapOf(
            "id" to id, "jsonrpc" to "2.0", "method" to "wc_sessionPropose",
            "params" to mapOf(
                "requiredNamespaces" to emptyMap<String, Any?>(),
                "optionalNamespaces" to namespaces(listOf(chain) + also),
                "relays" to listOf(mapOf("protocol" to "irn")),
                "proposer" to mapOf(
                    "publicKey" to hex(me.publicKey),
                    "metadata" to mapOf(
                        "name" to "Drivezzz", "description" to "Rides, paid in crypto", "url" to "https://drivezzz.s3rver.nl",
                        "icons" to listOf("https://drivezzz.s3rver.nl/logo.png"),
                        "redirect" to mapOf("native" to "drivezzz://wallet/wc", "universal" to "https://drivezzz.s3rver.nl"),
                    ),
                ),
                "expiryTimestamp" to expiry,
            ),
        )
        // Listen first: the answer can come as soon as the wallet sees the proposal.
        val answer = waitForResponse(id, 300)
        try {
            publish(pairing, proposal, tag = 1100, ttl = 300, prompt = true)
        } catch (e: Exception) {
            responses.remove(id)?.completeExceptionally(e)
            throw e
        }
        WalletLog.note("asked for ${(listOf(chain) + also).joinToString(", ")}")
        open("wc:$pairing@2?relay-protocol=irn&symKey=${hex(symKey)}&expiryTimestamp=$expiry")
        val result = answer.await()
        WalletLog.note("the wallet answered the proposal")
        val theirs = (result["responderPublicKey"] as? JsonPrimitive)?.contentOrNull?.let { unhex(it) }
            ?: throw Failure("The wallet answered with something Drivezzz can’t read.")
        val sessionKey = E2ECrypto.hkdf(NaCl.x25519(me.secret, theirs), null, null)
        val sessionTopic = topic(sessionKey)
        keys[sessionTopic] = sessionKey
        keys.remove(pairing)
        val settled = waitForSettle(sessionTopic)
        val all = (settled["namespaces"] as? JsonObject)?.values?.flatMap { ns ->
            ((ns as? JsonObject)?.get("accounts") as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
        } ?: emptyList()
        // Chains only: an account's last part is its address.
        WalletLog.note("the session came, with accounts on: ${all.map { it.split(":").take(2).joinToString(":") }.toSet().sorted().joinToString(", ")}")
        val wanted = (listOf(chain) + also).toSet()
        val accounts = all.filter { account -> wanted.any { account.startsWith("$it:") } }
        val account = accounts.firstOrNull { it.startsWith("$chain:") } ?: accounts.firstOrNull()
            ?: throw Failure("This wallet didn’t share an address for any of our coins. Turn them on in the wallet, or pick another wallet.")
        return Session(
            sessionTopic, hex(sessionKey), account.substringAfterLast(':'), account.split(":").take(2).joinToString(":"),
            (settled["expiry"] as? JsonPrimitive)?.longOrNull ?: expiry, accounts,
        )
    }

    // Asks the wallet; `open` brings it to the front once the request is on its way.
    suspend fun request(session: Session, projectId: String, method: String, params: Map<String, Any?>, open: () -> Unit): JsonObject {
        this.projectId = projectId
        val key = unhex(session.symKey) ?: throw Failure("Connect your wallet again.")
        keys[session.topic] = key
        ensureSocket()
        subscribe(session.topic)
        val id = nextId()
        val payload = mapOf(
            "id" to id, "jsonrpc" to "2.0", "method" to "wc_sessionRequest",
            "params" to mapOf("request" to mapOf("method" to method, "params" to params), "chainId" to session.chain),
        )
        val answer = waitForResponse(id, 300)
        try {
            publish(session.topic, payload, tag = 1108, ttl = 300, prompt = true)
        } catch (e: Exception) {
            responses.remove(id)?.completeExceptionally(e)
            throw e
        }
        open()
        return answer.await()
    }

    // Back from the wallet: Android may have cut the socket while we were away. Messages wait for us at the relay.
    fun resume() {
        if (keys.isEmpty()) return
        scope.launch { runCatching { ensureSocket() } }
    }

    fun cancelWaiting(reason: String = "Stopped.") {
        val failure = Failure(reason, rejected = true)
        responses.values.forEach { it.completeExceptionally(failure) }
        responses.clear()
        settle?.completeExceptionally(failure)
        settle = null
    }

    private fun nextId(): Long {
        val id = max(lastId + 1, System.currentTimeMillis() * 1000 + (0 until 1000).random())
        lastId = id
        return id
    }

    private fun waitForResponse(id: Long, timeout: Long): Deferred<JsonObject> {
        val waiting = CompletableDeferred<JsonObject>()
        responses[id] = waiting
        scope.launch {
            delay(timeout * 1000)
            responses.remove(id)?.completeExceptionally(Failure("The wallet didn’t answer in time. Try again."))
        }
        return waiting
    }

    private suspend fun waitForSettle(topic: String): JsonObject {
        settleTopic = topic
        val waiting = CompletableDeferred<JsonObject>()
        settle = waiting
        scope.launch {
            runCatching { subscribe(topic) }
            delay(60_000)
            if (settle === waiting && settleTopic == topic) {
                settle = null
                waiting.completeExceptionally(Failure("The wallet didn’t finish connecting. Try again."))
            }
        }
        return waiting.await()
    }

    private suspend fun ensureSocket() {
        if (socket != null) return
        if (projectId.isEmpty()) throw Failure("WalletConnect isn’t set up yet. Use Phantom or Solflare for now.")
        val auth = relayToken()
        val ua = URLEncoder.encode("wc-2/kotlin-Drivezzz-1/android/Drivezzz", "UTF-8")
        val request = Request.Builder().url("$relayURL/?auth=$auth&projectId=$projectId&ua=$ua").build()
        socket = ApiClient.http.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                scope.launch { handle(text, webSocket) }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                scope.launch { handle(bytes.utf8(), webSocket) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scope.launch { cut(webSocket) }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                scope.launch { cut(webSocket) }
            }
        })
        for (topic in keys.keys.toList()) runCatching { subscribe(topic) }
    }

    private suspend fun cut(webSocket: WebSocket) {
        if (socket !== webSocket) return
        WalletLog.note("the connection to the relay was cut")
        socket = null
        // Someone is waiting for an answer: reconnect when the app is in front (resume() does too).
        if (responses.isNotEmpty() || settle != null) {
            delay(1000)
            runCatching { ensureSocket() }
        }
    }

    // The relay wants a signed token from a key of this app's (not a wallet's, and worth nothing else).
    private fun relayToken(): String {
        val saved = Secure.read("wc.clientKey")?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() }
        val seed = saved ?: NaCl.randomBytes(32).also { Secure.write("wc.clientKey", Base64.getEncoder().encodeToString(it)) }
        val key = Ed25519PrivateKeyParameters(seed, 0)
        val did = "did:key:z" + Base58.encode(byteArrayOf(0xed.toByte(), 0x01) + key.generatePublicKey().encoded)
        val now = System.currentTimeMillis() / 1000
        val header = """{"alg":"EdDSA","typ":"JWT"}""".toByteArray()
        val claims = linkedMapOf<String, Any?>(
            "aud" to "wss://$RELAY_HOST", "exp" to now + 86400, "iat" to now, "iss" to did, "sub" to hex(NaCl.randomBytes(32)),
        ).toJsonElement().toString().toByteArray()
        val body = "${b64url(header)}.${b64url(claims)}"
        val signer = Ed25519Signer()
        signer.init(true, key)
        val bytes = body.toByteArray()
        signer.update(bytes, 0, bytes.size)
        return "$body.${b64url(signer.generateSignature())}"
    }

    private suspend fun relay(method: String, params: Map<String, Any?>) {
        val id = nextId()
        val text = mapOf("id" to id, "jsonrpc" to "2.0", "method" to method, "params" to params).toJsonElement().toString()
        val waiting = CompletableDeferred<Unit>()
        relayWaiting[id] = waiting
        if (socket?.send(text) != true) {
            relayWaiting.remove(id)
            throw Failure("WalletConnect doesn’t answer. Try again.")
        }
        scope.launch {
            delay(20_000)
            relayWaiting.remove(id)?.completeExceptionally(Failure("WalletConnect doesn’t answer. Try again."))
        }
        waiting.await()
    }

    private suspend fun subscribe(topic: String) = relay("irn_subscribe", mapOf("topic" to topic))

    private suspend fun publish(topic: String, payload: Map<String, Any?>, tag: Int, ttl: Int, prompt: Boolean = false) {
        val key = keys[topic] ?: return
        val nonce = NaCl.randomBytes(12)
        val box = chacha(true, payload.toJsonElement().toString().toByteArray(), key, nonce)
        val envelope = byteArrayOf(0) + nonce + box
        relay("irn_publish", mapOf("topic" to topic, "message" to Base64.getEncoder().encodeToString(envelope), "ttl" to ttl, "tag" to tag, "prompt" to prompt))
    }

    private suspend fun handle(text: String, webSocket: WebSocket) {
        val json = runCatching { JsonFormat.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
        if ((json["method"] as? JsonPrimitive)?.contentOrNull == "irn_subscription") {
            val data = (json["params"] as? JsonObject)?.get("data") as? JsonObject ?: return
            val topic = (data["topic"] as? JsonPrimitive)?.contentOrNull ?: return
            val message = (data["message"] as? JsonPrimitive)?.contentOrNull ?: return
            webSocket.send(mapOf("id" to json["id"], "jsonrpc" to "2.0", "result" to true).toJsonElement().toString())
            incoming(topic, message, (data["tag"] as? JsonPrimitive)?.intOrNull ?: 0)
            return
        }
        // An answer from the relay itself.
        val id = (json["id"] as? JsonPrimitive)?.longOrNull ?: return
        val waiting = relayWaiting.remove(id) ?: return
        val error = json["error"] as? JsonObject
        if (error != null) {
            waiting.completeExceptionally(Failure((error["message"] as? JsonPrimitive)?.contentOrNull ?: "WalletConnect refused that."))
        } else {
            waiting.complete(Unit)
        }
    }

    private suspend fun incoming(topic: String, message: String, tag: Int) {
        val key = keys[topic] ?: return
        val envelope = runCatching { Base64.getDecoder().decode(message) }.getOrNull() ?: return
        if (envelope.size <= 29 || envelope[0] != 0.toByte()) return
        val plain = runCatching { chacha(false, envelope.copyOfRange(13, envelope.size), key, envelope.copyOfRange(1, 13)) }.getOrNull() ?: return
        val json = runCatching { JsonFormat.parseToJsonElement(plain.toString(Charsets.UTF_8)).jsonObject }.getOrNull() ?: return
        val method = (json["method"] as? JsonPrimitive)?.contentOrNull
        if (method != null) {
            val reply = mapOf("id" to json["id"], "jsonrpc" to "2.0", "result" to true)
            if (method == "wc_sessionSettle" && json["params"] is JsonObject) {
                runCatching { publish(topic, reply, tag = 1103, ttl = 300) }
                if (settleTopic == topic) {
                    settle?.complete(json["params"] as JsonObject)
                    settle = null
                }
            } else {
                // A ping, an event, an extension: yes, with the tag after theirs.
                runCatching { publish(topic, reply, tag = tag + 1, ttl = 300) }
            }
            return
        }
        val id = (json["id"] as? JsonPrimitive)?.longOrNull ?: return
        val waiting = responses.remove(id) ?: return
        val error = json["error"] as? JsonObject
        val result = json["result"]
        when {
            error != null -> {
                val words = (error["message"] as? JsonPrimitive)?.contentOrNull
                WalletLog.note("the wallet said no: ${error["code"]} $words")
                waiting.completeExceptionally(Failure("The wallet said no: ${words ?: "rejected"}.", rejected = true))
            }
            result is JsonObject -> waiting.complete(result)
            else -> waiting.complete(JsonObject(emptyMap()))
        }
    }
}
