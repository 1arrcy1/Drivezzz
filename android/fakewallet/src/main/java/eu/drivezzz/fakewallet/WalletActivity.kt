package eu.drivezzz.fakewallet

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import eu.drivezzz.app.core.Base58
import eu.drivezzz.app.core.NaCl
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.json.JSONObject

// A stand-in for Phantom on an emulator: it answers Phantom's deeplink protocol (docs.phantom.com/phantom-deeplinks) the way that document
// says, so the app's way out through an intent and back through drivezzz:// can be tried for real. It's no proof of what Phantom itself does.
class WalletActivity : Activity() {
    private val seed = ByteArray(32) { (it + 1).toByte() }
    private val signing = Ed25519PrivateKeyParameters(seed, 0)
    private val address: String get() = Base58.encode(signing.generatePublicKey().encoded)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        show(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        show(intent)
    }

    private fun show(intent: Intent?) {
        val url = intent?.data
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(60, 240, 60, 60)
        }
        val words = TextView(this).apply {
            textSize = 20f
            text = if (url == null) "Fake wallet\n$address" else "Fake wallet asked: ${url.lastPathSegment}\ncluster: ${url.getQueryParameter("cluster") ?: "-"}"
        }
        layout.addView(words)
        if (url != null) {
            layout.addView(Button(this).apply {
                text = "Approve"
                setOnClickListener { answer(url) }
            })
            layout.addView(Button(this).apply {
                text = "Decline"
                setOnClickListener { decline(url) }
            })
        }
        setContentView(layout)
    }

    private fun back(url: Uri, params: Map<String, String>) {
        val builder = Uri.parse(url.getQueryParameter("redirect_link")).buildUpon()
        params.forEach { (k, v) -> builder.appendQueryParameter(k, v) }
        startActivity(Intent(Intent.ACTION_VIEW, builder.build()).setPackage(url.getQueryParameter("back") ?: "eu.drivezzz.app").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private fun decline(url: Uri) = back(url, mapOf("errorCode" to "4001", "errorMessage" to "User rejected the request."))

    private fun answer(url: Uri) {
        val dapp = Base58.decode(url.getQueryParameter("dapp_encryption_public_key")!!)!!
        val prefs = getSharedPreferences("wallet", MODE_PRIVATE)
        val nonce = NaCl.randomBytes(24)
        when (url.lastPathSegment) {
            "connect" -> {
                val me = NaCl.newKeyPair()
                val shared = NaCl.sharedKey(me.secret, dapp)
                prefs.edit().putString(Base58.encode(dapp), Base58.encode(shared)).commit()
                val plain = JSONObject().put("public_key", address).put("session", "fake-session").toString().toByteArray()
                back(url, mapOf(
                    "phantom_encryption_public_key" to Base58.encode(me.publicKey),
                    "nonce" to Base58.encode(nonce),
                    "data" to Base58.encode(NaCl.seal(plain, nonce, shared)),
                ))
            }
            "signTransaction" -> {
                val shared = Base58.decode(prefs.getString(Base58.encode(dapp), null) ?: "")
                val asked = shared?.let { NaCl.open(Base58.decode(url.getQueryParameter("payload")!!)!!, Base58.decode(url.getQueryParameter("nonce")!!)!!, it) }
                if (asked == null) {
                    // A session it doesn't know: what a wallet that was reinstalled says.
                    back(url, mapOf("errorCode" to "-32603", "errorMessage" to "Unknown session"))
                    return
                }
                val json = JSONObject(String(asked))
                val tx = Base58.decode(json.getString("transaction"))!!
                // A pretend chain's "transaction" is only a few bytes, with nothing to sign: it goes back as it came.
                val count = tx[0].toInt() and 0xFF
                if (tx.size > 1 + 64 * count) {
                    val signer = Ed25519Signer()
                    signer.init(true, signing)
                    signer.update(tx, 1 + 64 * count, tx.size - 1 - 64 * count)
                    signer.generateSignature().copyInto(tx, 1)
                }
                val plain = JSONObject().put("transaction", Base58.encode(tx)).toString().toByteArray()
                back(url, mapOf("nonce" to Base58.encode(nonce), "data" to Base58.encode(NaCl.seal(plain, nonce, shared))))
            }
            else -> decline(url)
        }
    }
}
