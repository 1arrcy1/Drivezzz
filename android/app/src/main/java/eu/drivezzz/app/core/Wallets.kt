package eu.drivezzz.app.core

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import eu.drivezzz.app.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import java.net.URLEncoder
import java.util.Base64

sealed class WalletFailure(message: String) : Exception(message) {
    class Declined : WalletFailure("You declined in your wallet.")
    class Unreadable : WalletFailure("The wallet answered with something Drivezzz can’t read.")
    class NotInstalled(name: String) : WalletFailure("$name isn’t on this phone.")
    class Refused(why: String?) : WalletFailure("The wallet refused${why?.let { ": $it" } ?: "."}")
    class NoSolanaAccount(name: String) : WalletFailure("$name didn’t share a Solana account. Choose one when it asks, add one there if you have none, or pick another wallet.")
    class Stopped : WalletFailure("Stopped.")
}

// Connecting and paying with a wallet app. The wallet opens, you approve there, and it comes back: nobody types or pastes
// an address, so it can't be the wrong one, and Drivezzz never sees your keys. Three ways in: wallets with their own link
// (Phantom, Solflare), MetaMask's own protocol (MetaMaskConnect.kt) and WalletConnect (Trust Wallet and the others).
// Solana only: that's where the ride escrow is.
object Wallets {
    sealed class Kind {
        data class Link(val base: String) : Kind()
        data class WalletConnect(val deep: String) : Kind()
        data object MetaMask : Kind()
    }

    // `pkg` is the app on Android, which is also what opens: a link is never left to whichever app the phone picks.
    data class App(val id: String, val name: String, val kind: Kind, val pkg: String? = null) {
        val store: String? get() = pkg?.let { "https://play.google.com/store/apps/details?id=$it" }
    }

    val apps = listOf(
        App("trust", "Trust Wallet", Kind.WalletConnect("trust://"), "com.wallet.crypto.trustapp"),
        App("phantom", "Phantom", Kind.Link("https://phantom.app/ul/v1/"), "app.phantom"),
        App("solflare", "Solflare", Kind.Link("https://solflare.com/ul/v1/"), "com.solflare.mobile"),
        App("metamask", "MetaMask", Kind.MetaMask, "io.metamask"),
        App("other", "Another wallet", Kind.WalletConnect("wc://")),
    )

    // Solana on WalletConnect. USDC lives at the same address.
    private const val MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    private const val DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    private const val METAMASK_KEY = "wallet.metamask"

    // A wallet with its own link, connected: what asking it to sign takes, kept so a payment needs one approval.
    @Serializable
    private data class LinkSession(val address: String, val token: String, val shared: String, val publicKey: String, val cluster: String)

    var waitingFor by mutableStateOf<String?>(null)
        private set
    var manualLink by mutableStateOf<String?>(null)
        private set

    private lateinit var context: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val wc = WalletConnectClient()
    private val metaMask = MetaMaskConnect()
    private var linkWaiting: CompletableDeferred<Map<String, String>>? = null

    fun init(context: Context) {
        this.context = context.applicationContext
    }

    fun isInstalled(app: App): Boolean = app.pkg == null || context.packageManager.getLaunchIntentForPackage(app.pkg) != null

    private fun open(url: String, pkg: String? = null): Boolean = try {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (pkg != null) intent.setPackage(pkg)
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    } catch (_: SecurityException) {
        false
    }

    // drivezzz://…: a wallet with its own link coming back with its answer.
    fun handle(url: Uri) {
        if (url.scheme != "drivezzz") return
        WalletLog.note("came back through ${url.host ?: ""}${url.path ?: ""}")
        val path = url.path ?: ""
        val waiting = linkWaiting
        if (!(path.endsWith("link") || path.endsWith("signed")) || waiting == null) return
        val values = url.queryParameterNames.associateWith { url.getQueryParameter(it) ?: "" }
        linkWaiting = null
        val code = values["errorCode"]
        if (code != null) {
            // 4001 is the person saying no; anything else is the wallet itself.
            waiting.completeExceptionally(if (code == "4001") WalletFailure.Declined() else WalletFailure.Refused(values["errorMessage"]))
        } else {
            waiting.complete(values)
        }
    }

    // Back in the app: a socket that was cut comes back.
    fun resume() {
        if (waitingFor != null) WalletLog.note("back in Drivezzz, still waiting for $waitingFor")
        wc.resume()
        metaMask.resume()
    }

    fun stopWaiting() {
        if (waitingFor != null) WalletLog.note("stopped waiting for $waitingFor")
        wc.cancelWaiting()
        metaMask.cancelWaiting()
        linkWaiting?.completeExceptionally(WalletFailure.Stopped())
        linkWaiting = null
        waitingFor = null
        manualLink = null
    }

    // What the wallet shared: its Solana address, for both our coins.
    suspend fun connect(app: App, network: String?): Map<String, String> {
        waitingFor = app.name
        try {
            WalletLog.note("connect ${app.name}")
            val address = when (val kind = app.kind) {
                is Kind.Link -> connectLink(app, kind.base, network).address
                is Kind.WalletConnect -> walletConnect(app, kind.deep, MAINNET).address
                Kind.MetaMask -> connectMetaMask(app).address
            }
            WalletLog.note("connected ${app.name}")
            return mapOf("sol" to address, "usdc-sol" to address)
        } catch (e: Exception) {
            WalletLog.note("connect ${app.name} failed: ${e.message}")
            throw e
        } finally {
            waitingFor = null
            manualLink = null
        }
    }

    // Paying a ride: the server builds the payment for this wallet's address, the wallet signs it, the server sends it on.
    // Asking per wallet, because a solana: link opens whichever wallet the phone picks, not the one with the money.
    suspend fun pay(rideId: String, app: App, network: String?) {
        waitingFor = app.name
        try {
            val signed: ByteArray = when (val kind = app.kind) {
                is Kind.Link -> {
                    val cluster = cluster(network)
                    val saved = Secure.read(linkKey(app))?.let { runCatching { JsonFormat.decodeFromString(LinkSession.serializer(), it) }.getOrNull() }
                    val session = if (saved?.cluster == cluster) saved else connectLink(app, kind.base, network)
                    try {
                        signLink(app, kind.base, session, payment(rideId, session.address))
                    } catch (_: WalletFailure.Refused) {
                        // Most likely a session it no longer knows: connect again and ask once more.
                        val fresh = connectLink(app, kind.base, network)
                        signLink(app, kind.base, fresh, payment(rideId, fresh.address))
                    }
                }
                is Kind.WalletConnect -> {
                    // On a test network, a wallet that only has the real one still signs: the server sends it, not the wallet.
                    val chain = if (network == "mainnet") MAINNET else DEVNET
                    val session = walletConnect(app, kind.deep, chain, if (network == "mainnet") emptyList() else listOf(MAINNET))
                    val transaction = payment(rideId, session.address)
                    val answer = wc.request(session, BuildConfig.WC_PROJECT_ID, "solana_signTransaction", mapOf("transaction" to Base64.getEncoder().encodeToString(transaction))) {
                        open("${kind.deep}wc?sessionTopic=${session.topic}", app.pkg)
                    }
                    wholeOrSignature(answer, transaction)
                }
                Kind.MetaMask -> payWithMetaMask(app, rideId)
            }
            ApiClient.call("POST", "/api/rides/$rideId/pay/send", mapOf("transaction" to Base64.getEncoder().encodeToString(signed)))
        } finally {
            waitingFor = null
            manualLink = null
        }
    }

    // The whole transaction, or only its signature: the first one in it, ours being the only signer.
    fun wholeOrSignature(answer: JsonObject, transaction: ByteArray): ByteArray {
        (answer["transaction"] as? JsonPrimitive)?.contentOrNull?.let { text ->
            runCatching { Base64.getDecoder().decode(text) }.getOrNull()?.let { return it }
        }
        val signature = (answer["signature"] as? JsonPrimitive)?.contentOrNull?.let { Base58.decode(it) }
        if (signature != null && signature.size == 64) {
            val out = transaction.copyOf()
            signature.copyInto(out, 1)
            return out
        }
        throw WalletFailure.Unreadable()
    }

    private suspend fun payment(rideId: String, account: String): ByteArray {
        val r: PayResponse = ApiClient.post("/api/rides/$rideId/pay", mapOf("account" to account))
        return r.transaction?.let { runCatching { Base64.getDecoder().decode(it) }.getOrNull() } ?: throw WalletFailure.Unreadable()
    }

    private suspend fun walletConnect(app: App, deep: String, chain: String, also: List<String> = emptyList()): WalletConnectClient.Session =
        wc.connect(BuildConfig.WC_PROJECT_ID, chain, also) { uri ->
            // Another wallet: a plain wc: link opens whichever app the phone gives those links to (often MetaMask),
            // so it isn't opened by itself. The sheet shows it to scan, copy, or open on purpose.
            if (app.id == "other") {
                manualLink = uri
            } else {
                val opened = open("${deep}wc?uri=${URLEncoder.encode(uri, "UTF-8")}", app.pkg)
                WalletLog.note("opening ${app.name}: ${if (opened) "opened" else "didn't open"}")
                if (!opened) wc.cancelWaiting(WalletFailure.NotInstalled(app.name).message ?: "")
            }
        }

    private suspend fun connectMetaMask(app: App): MetaMaskConnect.Session {
        val session = metaMask.connect { link -> openMetaMask(app, link) }
        Secure.write(METAMASK_KEY, JsonFormat.encodeToString(MetaMaskConnect.Session.serializer(), session))
        return session
    }

    private fun openMetaMask(app: App, link: String) {
        val opened = open(link, app.pkg)
        WalletLog.note("opening ${app.name}: ${if (opened) "opened" else "didn't open"}")
        if (!opened) metaMask.cancelWaiting(WalletFailure.NotInstalled(app.name))
    }

    // With the connection from last time if there is one, so it's one approval. MetaMask can't sign for Solana's test
    // networks on a phone, so a test server can only get as far as that wallet saying so.
    private suspend fun payWithMetaMask(app: App, rideId: String): ByteArray {
        val saved = Secure.read(METAMASK_KEY)?.let { runCatching { JsonFormat.decodeFromString(MetaMaskConnect.Session.serializer(), it) }.getOrNull() }
        val known = saved?.takeIf { it.expiresAt > System.currentTimeMillis() / 1000.0 }
        suspend fun sign(session: MetaMaskConnect.Session): ByteArray {
            val transaction = payment(rideId, session.address)
            return metaMask.signTransaction(transaction, session) { link -> openMetaMask(app, link) }
        }
        if (known == null) return sign(connectMetaMask(app))
        return try {
            sign(known)
        } catch (_: WalletFailure.Refused) {
            // Most likely a connection it no longer has: connect again and ask once more.
            sign(connectMetaMask(app))
        } catch (e: WalletFailure.Stopped) {
            // If it no longer has the connection it only says so on its own screen, and this is how that ends: next time, a new one.
            Secure.write(METAMASK_KEY, null)
            throw e
        }
    }

    private fun cluster(network: String?) = if (network == "mainnet") "mainnet-beta" else "devnet"
    private fun linkKey(app: App) = "wallet.link.${app.id}"

    // Opens a wallet's link and waits for it to come back. It goes to that wallet's own app, not the phone's browser: without
    // the app it would open the website and never come back.
    private suspend fun askLink(app: App, url: Uri): Map<String, String> {
        val answer = CompletableDeferred<Map<String, String>>()
        linkWaiting = answer
        val opened = app.pkg != null && isInstalled(app) && open(url.toString(), app.pkg)
        WalletLog.note("opening ${app.name}: ${if (opened) "opened" else "didn't open"}")
        if (!opened) {
            linkWaiting = null
            throw WalletFailure.NotInstalled(app.name)
        }
        return answer.await()
    }

    private suspend fun signLink(app: App, base: String, session: LinkSession, transaction: ByteArray): ByteArray {
        val b64 = Base64.getDecoder()
        val shared = b64.decode(session.shared)
        val nonce = NaCl.randomBytes(24)
        val payload = mapOf("transaction" to Base58.encode(transaction), "session" to session.token).toJsonElement().toString().toByteArray()
        val url = Uri.parse("${base}signTransaction").buildUpon()
            .appendQueryParameter("dapp_encryption_public_key", Base58.encode(b64.decode(session.publicKey)))
            .appendQueryParameter("nonce", Base58.encode(nonce))
            .appendQueryParameter("redirect_link", "drivezzz://wallet/signed")
            .appendQueryParameter("payload", Base58.encode(NaCl.seal(payload, nonce, shared)))
            .build()
        val values = askLink(app, url)
        val answerNonce = values["nonce"]?.let { Base58.decode(it) } ?: throw WalletFailure.Unreadable()
        val box = values["data"]?.let { Base58.decode(it) } ?: throw WalletFailure.Unreadable()
        val plain = NaCl.open(box, answerNonce, shared) ?: throw WalletFailure.Unreadable()
        val json = runCatching { JsonFormat.parseToJsonElement(plain.toString(Charsets.UTF_8)).jsonObject }.getOrNull() ?: throw WalletFailure.Unreadable()
        return (json["transaction"] as? JsonPrimitive)?.contentOrNull?.let { Base58.decode(it) } ?: throw WalletFailure.Unreadable()
    }

    private suspend fun connectLink(app: App, base: String, network: String?): LinkSession {
        val me = NaCl.newKeyPair()
        val url = Uri.parse("${base}connect").buildUpon()
            .appendQueryParameter("app_url", "https://drivezzz.s3rver.nl")
            .appendQueryParameter("dapp_encryption_public_key", Base58.encode(me.publicKey))
            .appendQueryParameter("redirect_link", "drivezzz://wallet/link")
            .appendQueryParameter("cluster", cluster(network))
            .build()
        val values = askLink(app, url)
        val theirs = values.entries.firstOrNull { it.key.endsWith("_encryption_public_key") }?.value?.let { Base58.decode(it) } ?: throw WalletFailure.Unreadable()
        val nonce = values["nonce"]?.let { Base58.decode(it) } ?: throw WalletFailure.Unreadable()
        val box = values["data"]?.let { Base58.decode(it) } ?: throw WalletFailure.Unreadable()
        val shared = runCatching { NaCl.sharedKey(me.secret, theirs) }.getOrNull() ?: throw WalletFailure.Unreadable()
        val plain = NaCl.open(box, nonce, shared) ?: throw WalletFailure.Unreadable()
        val json = runCatching { JsonFormat.parseToJsonElement(plain.toString(Charsets.UTF_8)).jsonObject }.getOrNull() ?: throw WalletFailure.Unreadable()
        val address = (json["public_key"] as? JsonPrimitive)?.contentOrNull ?: throw WalletFailure.Unreadable()
        val b64 = Base64.getEncoder()
        val session = LinkSession(address, (json["session"] as? JsonPrimitive)?.contentOrNull ?: "", b64.encodeToString(shared), b64.encodeToString(me.publicKey), cluster(network))
        Secure.write(linkKey(app), JsonFormat.encodeToString(LinkSession.serializer(), session))
        return session
    }

    fun openLink(url: String): Boolean = open(url)

    // What tells a person what went wrong with a wallet, or null when they stopped it themselves.
    fun problem(e: Throwable): String? = when {
        e is CancellationException -> throw e
        e is WalletFailure.Stopped -> null
        e is WalletConnectClient.Failure && e.message == "Stopped." -> null
        else -> e.shown
    }

    fun isMissingApp(e: Throwable): Boolean = e is WalletFailure.NotInstalled || (e.message?.contains("isn’t on this phone") == true)
}
