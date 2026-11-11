package eu.drivezzz.app.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
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
import org.bouncycastle.crypto.ec.CustomNamedCurves
import java.io.ByteArrayOutputStream
import java.math.BigInteger
import java.net.URLEncoder
import java.util.Base64
import java.util.UUID
import java.util.zip.Deflater

// MetaMask's phone app gives other apps Solana only through its own protocol, MetaMask Connect: over WalletConnect it offers
// Ethereum and Tron, and a Solana request ends in a silent failure, with no answer and no way back. So this speaks that protocol
// itself, the same as Core/MetaMaskConnect.swift. Tried against their own wallet client and encryption library on their real relay:
// `server/test/reference/mm-wallet.mjs`.
//
// A link hands MetaMask our public key and the first request. MetaMask answers on the relay, encrypted to that key, with its own
// key and a channel. Everything after goes over that channel, and waits there while either app is in the background. MetaMask
// doesn't come back by itself on this protocol: it says "Return to the app".

// secp256k1, with the keys made per connection.
object Secp256k1 {
    private val curve = CustomNamedCurves.getByName("secp256k1")

    fun newSecret(): ByteArray {
        while (true) {
            val bytes = NaCl.randomBytes(32)
            val value = BigInteger(1, bytes)
            if (value.signum() > 0 && value < curve.n) return bytes
        }
    }

    fun publicKey(secret: ByteArray, compressed: Boolean): ByteArray =
        curve.g.multiply(BigInteger(1, secret)).normalize().getEncoded(compressed)

    // The shared point of a secret and someone's public key, uncompressed. Refuses what isn't on the curve.
    fun shared(secret: ByteArray, publicKey: ByteArray): ByteArray =
        curve.curve.decodePoint(publicKey).multiply(BigInteger(1, secret)).normalize().getEncoded(false)
}

// Encryption to a public key, byte for byte what the eciesjs library does by default, which is what MetaMask uses: a new key
// per message, HKDF-SHA256 over its public key and the shared point, AES-256-GCM with a 16-byte nonce. On the wire: that
// public key (65 bytes), the nonce, the tag, the ciphertext.
object ECIES {
    class Unreadable : Exception("Unreadable")

    private fun key(ephemeral: ByteArray, shared: ByteArray): ByteArray = E2ECrypto.hkdf(ephemeral + shared, null, null)

    fun seal(plain: ByteArray, publicKey: ByteArray): ByteArray {
        val secret = Secp256k1.newSecret()
        val ephemeral = Secp256k1.publicKey(secret, false)
        val shared = Secp256k1.shared(secret, publicKey)
        val nonce = NaCl.randomBytes(16)
        val box = E2ECrypto.aesGcm(true, plain, key(ephemeral, shared), nonce)
        val cipher = box.copyOfRange(0, box.size - 16)
        val tag = box.copyOfRange(box.size - 16, box.size)
        return ephemeral + nonce + tag + cipher
    }

    fun open(sealed: ByteArray, secret: ByteArray): ByteArray {
        if (sealed.size < 65 + 16 + 16) throw Unreadable()
        val ephemeral = sealed.copyOfRange(0, 65)
        val shared = Secp256k1.shared(secret, ephemeral)
        val nonce = sealed.copyOfRange(65, 81)
        val tag = sealed.copyOfRange(81, 97)
        val cipher = sealed.copyOfRange(97, sealed.size)
        return E2ECrypto.aesGcm(false, cipher + tag, key(ephemeral, shared), nonce)
    }
}

class MetaMaskConnect {
    // Kept so a payment needs one approval, and no second connecting.
    @Serializable
    data class Session(
        val id: String,
        val secret: String, // base64
        val theirKey: String, // base64
        val channel: String,
        val address: String,
        val expiresAt: Double,
    )

    companion object {
        var relayURL = "wss://mm-sdk-relay.api.cx.metamask.io/connection/websocket"
        // MetaMask's phone app has Solana's real network only; a test network needs its developer version.
        const val SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
        private const val STREAM = "metamask-multichain-provider"
        private const val ANSWER_TIMEOUT = 300_000L

        private fun envelope(data: Map<String, Any?>): Map<String, Any?> = mapOf("name" to STREAM, "data" to data)

        // The way their own library builds it: JSON, zlib-compressed, base64.
        fun connectLink(request: Map<String, Any?>): String {
            val json = request.toJsonElement().toString().toByteArray()
            val deflater = Deflater(Deflater.DEFAULT_COMPRESSION)
            deflater.setInput(json)
            deflater.finish()
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(4096)
            while (!deflater.finished()) out.write(buffer, 0, deflater.deflate(buffer))
            deflater.end()
            val encoded = URLEncoder.encode(Base64.getEncoder().encodeToString(out.toByteArray()), "UTF-8")
            return "metamask://connect/mwp?p=$encoded&c=1"
        }

        private fun result(answer: JsonObject): JsonObject {
            val error = answer["error"] as? JsonObject
            if (error != null) {
                val code = (error["code"] as? JsonPrimitive)?.intOrNull ?: 0
                val text = (error["message"] as? JsonPrimitive)?.contentOrNull ?: ""
                WalletLog.note("MetaMask said no: $code $text")
                // 4001 and 5000 are saying no, and a Solana no can lose its code on the way.
                if (code == 4001 || code == 5000 || text.lowercase().contains("rejected")) throw WalletFailure.Declined()
                throw WalletFailure.Refused(text.ifEmpty { null })
            }
            return answer["result"] as? JsonObject ?: JsonObject(emptyMap())
        }
    }

    private class RelayError(val code: Int, text: String) : Exception("MetaMask’s connection said: $text")

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var socket: WebSocket? = null
    private var ready = false
    private var connecting: CompletableDeferred<Unit>? = null
    private var lastCommand = 0
    private val replies = mutableMapOf<Int, CompletableDeferred<JsonObject>>()
    private val clientId = UUID.randomUUID().toString().lowercase()
    private var lastNonce = 0L
    private val seen = mutableMapOf<String, Long>()
    private val channels = mutableListOf<String>()
    private var secret: ByteArray? = null
    private var theirKey: ByteArray? = null
    private var theirChannel: String? = null
    private val waiting = mutableMapOf<String, CompletableDeferred<JsonObject>>()
    private var creatingSession: String? = null

    // A new session: `open` gets the link for MetaMask. Comes back when the person approved and came back here.
    suspend fun connect(open: (String) -> Unit): Session {
        start()
        try {
            val id = UUID.randomUUID().toString().lowercase()
            val secret = Secp256k1.newSecret()
            this.secret = secret
            val requestId = newRequestId()
            creatingSession = requestId
            val handshake = "handshake:$id"
            val link = connectLink(
                mapOf(
                    "sessionRequest" to mapOf(
                        "id" to id, "mode" to "trusted", "channel" to handshake,
                        "publicKeyB64" to Base64.getEncoder().encodeToString(Secp256k1.publicKey(secret, true)),
                        // Longer than their own app's 60 seconds: MetaMask may ask to be unlocked first, and the wallet only checks it hasn't passed.
                        "expiresAt" to System.currentTimeMillis() + ANSWER_TIMEOUT,
                        "initialMessage" to mapOf(
                            "type" to "message",
                            "payload" to envelope(
                                mapOf(
                                    "jsonrpc" to "2.0", "id" to requestId, "method" to "wallet_createSession",
                                    "params" to mapOf(
                                        "optionalScopes" to mapOf(SOLANA to mapOf("methods" to emptyList<String>(), "notifications" to emptyList<String>(), "accounts" to emptyList<String>())),
                                        // Tells the wallet this is Solana's kind of app; their own Solana library sends it too.
                                        "sessionProperties" to mapOf("solana_accountChanged_notifications" to true),
                                    ),
                                )
                            ),
                        ),
                    ),
                    "metadata" to mapOf(
                        "dapp" to mapOf("name" to "Drivezzz", "url" to "https://drivezzz.s3rver.nl", "icon" to "https://drivezzz.s3rver.nl/logo.png"),
                        "sdk" to mapOf("version" to "1.0.0", "platform" to "android"),
                    ),
                )
            )
            val answer = ask(requestId) {
                ensureSocket()
                listen(handshake)
                WalletLog.note("asked MetaMask for Solana")
                open(link)
            }
            val scopes = result(answer)["sessionScopes"] as? JsonObject ?: JsonObject(emptyMap())
            WalletLog.note("MetaMask's session came, with: ${scopes.keys.sorted().joinToString(", ")}")
            val accounts = ((scopes[SOLANA] as? JsonObject)?.get("accounts") as? JsonArray)?.mapNotNull { it.jsonPrimitive.contentOrNull } ?: emptyList()
            val address = accounts.firstOrNull()?.substringAfterLast(':')
            val key = theirKey
            val channel = theirChannel
            if (address == null || key == null || channel == null) throw WalletFailure.NoSolanaAccount("MetaMask")
            val b64 = Base64.getEncoder()
            return Session(id, b64.encodeToString(secret), b64.encodeToString(key), channel, address, System.currentTimeMillis() / 1000.0 + 30 * 86400)
        } finally {
            finish()
        }
    }

    // MetaMask signs a transaction and hands it back, to send on from our server.
    suspend fun signTransaction(transaction: ByteArray, session: Session, open: (String) -> Unit): ByteArray {
        start()
        try {
            val b64 = Base64.getDecoder()
            secret = b64.decode(session.secret)
            theirKey = b64.decode(session.theirKey)
            val requestId = newRequestId()
            val request = envelope(
                mapOf(
                    "jsonrpc" to "2.0", "id" to requestId, "method" to "wallet_invokeMethod",
                    "params" to mapOf(
                        "scope" to SOLANA,
                        "request" to mapOf(
                            "method" to "signTransaction",
                            "params" to mapOf("account" to mapOf("address" to session.address), "transaction" to Base64.getEncoder().encodeToString(transaction), "scope" to SOLANA),
                        ),
                    ),
                )
            )
            val answer = ask(requestId) {
                ensureSocket()
                listen(session.channel)
                publish(mapOf("type" to "message", "payload" to request), session.channel)
                WalletLog.note("asked MetaMask to sign")
                open("metamask://connect/mwp?id=${session.id}")
            }
            val signed = (result(answer)["signedTransaction"] as? JsonPrimitive)?.contentOrNull
                ?.let { runCatching { b64.decode(it) }.getOrNull() } ?: throw WalletFailure.Unreadable()
            return signed
        } finally {
            finish()
        }
    }

    // Back from MetaMask: Android may have cut the socket while we were away. A new one finds what came in the meantime.
    fun resume() {
        if (waiting.isEmpty()) return
        dropSocket()
        scope.launch { runCatching { ensureSocket() } }
    }

    // `reason` is what the person waiting gets; nothing means they stopped it themselves.
    fun cancelWaiting(reason: Exception = WalletFailure.Stopped()) {
        waiting.values.forEach { it.completeExceptionally(reason) }
        waiting.clear()
    }

    private fun start() {
        cancelWaiting()
        finish()
    }

    private fun finish() {
        dropSocket()
        channels.clear()
        seen.clear()
        secret = null
        theirKey = null
        theirChannel = null
        creatingSession = null
    }

    private fun newRequestId(): String = "${System.currentTimeMillis()}${(100..999).random()}"

    // Asks, and waits for the answer with this id. Registered before `begin` runs, so an answer can't come too early.
    private suspend fun ask(id: String, begin: suspend () -> Unit): JsonObject {
        val answer = CompletableDeferred<JsonObject>()
        waiting[id] = answer
        scope.launch {
            try {
                begin()
            } catch (e: Exception) {
                waiting.remove(id)?.completeExceptionally(e)
            }
        }
        scope.launch {
            delay(ANSWER_TIMEOUT)
            waiting.remove(id)?.completeExceptionally(WalletFailure.Refused("MetaMask didn’t answer in time. Try again."))
        }
        return answer.await()
    }

    private suspend fun publish(message: Map<String, Any?>, channel: String) {
        val key = theirKey ?: throw WalletFailure.Unreadable()
        val sealed = ECIES.seal(message.toJsonElement().toString().toByteArray(), key)
        lastNonce = maxOf(lastNonce + 1, System.currentTimeMillis())
        val outer = mapOf("clientId" to clientId, "nonce" to lastNonce, "payload" to Base64.getEncoder().encodeToString(sealed)).toJsonElement().toString()
        command(mapOf("publish" to mapOf("channel" to channel, "data" to outer)))
    }

    private suspend fun listen(channel: String) {
        if (channel !in channels) channels.add(channel)
        subscribe(channel)
    }

    private suspend fun subscribe(channel: String) {
        try {
            command(mapOf("subscribe" to mapOf("channel" to channel, "recoverable" to true, "positioned" to true)))
        } catch (e: RelayError) {
            // Already subscribed: a new socket and a new channel crossed each other.
            if (e.code != 105) throw e
        }
        // What came while we weren't there, MetaMask's answer most of all.
        val history = command(mapOf("history" to mapOf("channel" to channel, "limit" to 50)))
        (history["publications"] as? JsonArray)?.forEach { publication ->
            val data = ((publication as? JsonObject)?.get("data") as? JsonPrimitive)?.contentOrNull
            if (data != null) incoming(data, channel)
        }
    }

    private suspend fun incoming(raw: String, channel: String) {
        val outer = runCatching { JsonFormat.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        val sender = (outer["clientId"] as? JsonPrimitive)?.contentOrNull ?: return
        if (sender == clientId) return
        val nonce = (outer["nonce"] as? JsonPrimitive)?.longOrNull ?: return
        val payload = (outer["payload"] as? JsonPrimitive)?.contentOrNull?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } ?: return
        // A new connection reads the history again.
        val from = "$channel|$sender"
        if (nonce <= (seen[from] ?: 0)) return
        seen[from] = nonce
        val secret = secret ?: return
        val plain = runCatching { ECIES.open(payload, secret) }.getOrNull() ?: return
        val message = runCatching { JsonFormat.parseToJsonElement(plain.toString(Charsets.UTF_8)).jsonObject }.getOrNull() ?: return
        when ((message["type"] as? JsonPrimitive)?.contentOrNull) {
            "handshake-offer" -> {
                val offer = message["payload"] as? JsonObject ?: return
                val channelId = (offer["channelId"] as? JsonPrimitive)?.contentOrNull ?: return
                val key = (offer["publicKeyB64"] as? JsonPrimitive)?.contentOrNull?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } ?: return
                if (runCatching { Secp256k1.shared(secret, key) }.isFailure) return
                WalletLog.note("MetaMask opened the connection")
                theirKey = key
                theirChannel = "session:$channelId"
                runCatching { listen("session:$channelId") }
            }
            "message" -> {
                val body = message["payload"] as? JsonObject ?: return
                val data = body["data"] as? JsonObject ?: return
                answered(data)
            }
        }
    }

    private fun answered(data: JsonObject) {
        val id = (data["id"] as? JsonPrimitive)?.contentOrNull
        if (id != null) {
            val answer = waiting.remove(id)
            if (answer != null) {
                answer.complete(data)
                return
            }
        }
        // Their library counts this as the answer to creating a session too, in case it's the first to arrive.
        val creating = creatingSession ?: return
        if ((data["method"] as? JsonPrimitive)?.contentOrNull != "wallet_sessionChanged") return
        val params = data["params"] as? JsonObject ?: return
        val scopes = params["sessionScopes"] as? JsonObject ?: return
        val accounts = (scopes[SOLANA] as? JsonObject)?.get("accounts") as? JsonArray ?: return
        if (accounts.isEmpty()) return
        waiting.remove(creating)?.complete(JsonObject(mapOf("result" to params)))
    }

    // The relay, a Centrifugo server: JSON commands with an id, and messages it pushes.

    private suspend fun ensureSocket() {
        // One that's under way may just have been cut, by coming back from MetaMask: then it's this one's turn.
        while (true) {
            val under = connecting ?: break
            runCatching { under.await() }
        }
        if (ready && socket != null) return
        val attempt = CompletableDeferred<Unit>()
        connecting = attempt
        try {
            socket = ApiClient.http.newWebSocket(Request.Builder().url(relayURL).build(), object : WebSocketListener() {
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
            command(mapOf("connect" to mapOf("name" to "drivezzz")))
            ready = true
            for (channel in channels.toList()) subscribe(channel)
            attempt.complete(Unit)
        } catch (e: Exception) {
            attempt.completeExceptionally(e)
            throw e
        } finally {
            connecting = null
        }
    }

    private suspend fun cut(webSocket: WebSocket) {
        if (socket !== webSocket) return
        WalletLog.note("the connection to MetaMask’s relay was cut")
        dropSocket()
        // Someone is waiting: try again now, and resume() does when the app is back in front.
        if (waiting.isNotEmpty()) {
            delay(1000)
            runCatching { ensureSocket() }
        }
    }

    private fun dropSocket() {
        socket?.cancel()
        socket = null
        ready = false
        val failure = RelayError(0, "The connection was cut.")
        replies.values.forEach { it.completeExceptionally(failure) }
        replies.clear()
    }

    private suspend fun command(body: Map<String, Any?>): JsonObject {
        lastCommand++
        val id = lastCommand
        val text = (body + ("id" to id)).toJsonElement().toString()
        val socket = socket ?: throw RelayError(0, "The connection was cut.")
        val reply = CompletableDeferred<JsonObject>()
        replies[id] = reply
        socket.send(text)
        scope.launch {
            delay(20_000)
            replies.remove(id)?.completeExceptionally(RelayError(0, "No answer."))
        }
        return reply.await()
    }

    // One frame can hold several messages, a line each.
    private suspend fun handle(text: String, webSocket: WebSocket) {
        if (socket !== webSocket) return
        for (line in text.split("\n")) {
            if (line.isBlank()) continue
            val json = runCatching { JsonFormat.parseToJsonElement(line).jsonObject }.getOrNull() ?: continue
            // An empty message is the relay's ping.
            if (json.isEmpty()) {
                webSocket.send("{}")
                continue
            }
            val id = (json["id"] as? JsonPrimitive)?.intOrNull
            if (id != null && id != 0) {
                val reply = replies.remove(id) ?: continue
                val error = json["error"] as? JsonObject
                if (error != null) {
                    reply.completeExceptionally(RelayError((error["code"] as? JsonPrimitive)?.intOrNull ?: 0, (error["message"] as? JsonPrimitive)?.contentOrNull ?: ""))
                } else {
                    // The one key that isn't the id holds the answer.
                    val answer: JsonElement? = json.entries.firstOrNull { it.key != "id" }?.value
                    reply.complete(answer as? JsonObject ?: JsonObject(emptyMap()))
                }
                continue
            }
            val push = json["push"] as? JsonObject ?: continue
            val channel = (push["channel"] as? JsonPrimitive)?.contentOrNull ?: continue
            val data = ((push["pub"] as? JsonObject)?.get("data") as? JsonPrimitive)?.contentOrNull ?: continue
            incoming(data, channel)
        }
    }
}
