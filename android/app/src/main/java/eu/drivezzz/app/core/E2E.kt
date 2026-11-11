package eu.drivezzz.app.core

import kotlinx.serialization.Serializable
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.engines.AESEngine
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.modes.GCMBlockCipher
import org.bouncycastle.crypto.params.AEADParameters
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.KeyParameter
import java.util.Base64

// Sealing and opening, apart from where keys are kept, so tests can run them against what E2E.swift and e2e.js produce.
object E2ECrypto {
    private val salt = "drivezzz-e2e-v1".toByteArray()

    // HKDF-SHA256(X25519(mine, theirs), salt "drivezzz-e2e-v1", info "chat|<lower key>|<higher key>")
    fun chatKey(secret: ByteArray, mine: String, theirs: String): ByteArray {
        val shared = NaCl.x25519(secret, Base64.getDecoder().decode(theirs))
        val info = "chat|" + listOf(mine, theirs).sorted().joinToString("|")
        return hkdf(shared, salt, info.toByteArray())
    }

    fun hkdf(ikm: ByteArray, salt: ByteArray?, info: ByteArray?, length: Int = 32): ByteArray {
        val generator = HKDFBytesGenerator(SHA256Digest())
        generator.init(HKDFParameters(ikm, salt, info))
        return ByteArray(length).also { generator.generateBytes(it, 0, length) }
    }

    // AES-256-GCM: nonce | ciphertext | tag, base64.
    fun seal(plain: ByteArray, key: ByteArray, nonce: ByteArray = NaCl.randomBytes(12)): String =
        Base64.getEncoder().encodeToString(nonce + aesGcm(true, plain, key, nonce))

    fun open(sealed: String, key: ByteArray): ByteArray? = try {
        val raw = Base64.getDecoder().decode(sealed)
        if (raw.size < 28) null else aesGcm(false, raw.copyOfRange(12, raw.size), key, raw.copyOfRange(0, 12))
    } catch (_: Exception) {
        null
    }

    // By hand rather than through javax.crypto: MetaMask's encryption needs a 16-byte nonce, which Android's own AES-GCM refuses.
    fun aesGcm(encrypt: Boolean, input: ByteArray, key: ByteArray, nonce: ByteArray): ByteArray {
        val cipher = GCMBlockCipher.newInstance(AESEngine.newInstance())
        cipher.init(encrypt, AEADParameters(KeyParameter(key), 128, nonce))
        val out = ByteArray(cipher.getOutputSize(input.size))
        val n = cipher.processBytes(input, 0, input.size, out, 0)
        val total = n + cipher.doFinal(out, n)
        return out.copyOf(total)
    }
}

// End-to-end encryption of messages, the same as the server's src/e2e.js and the iPhone's Core/E2E.swift: keep them byte-compatible.
//   - every account has an X25519 key pair on its phone: the private key stays there, the public key goes to the server
//   - a message is sealed under what two people share, so the server only stores what it can't read
// Reporting someone hands over the keys to that one chat, so the report can be read.
// iPhones keep keys in iCloud Keychain, so a new iPhone reads old messages. Here they're on this phone only: see docs/android.md.
object E2E {
    class NotReady : Exception("Encryption isn’t set up on this phone yet. Try again in a moment.")

    @Serializable
    private data class Stored(val current: String, val keys: Map<String, String>)

    private var accountId: String? = null
    private var keys = mutableMapOf<String, ByteArray>()
    private var current: String? = null
    private var registered = false

    private val account: String get() = "e2e.account-${accountId ?: ""}"

    // Loads this account's key on this phone, makes one the first time, and tells the server.
    suspend fun prepare(accountId: String) {
        if (this.accountId != accountId) reset()
        this.accountId = accountId
        if (keys.isEmpty()) load()
        if (current == null) {
            val pair = NaCl.newKeyPair()
            val id = Base64.getEncoder().encodeToString(pair.publicKey)
            keys[id] = pair.secret
            current = id
            save()
        }
        val mine = current ?: return
        if (registered) return
        if (attempt { ApiClient.call("POST", "/api/me/key", mapOf("publicKey" to mine)) } != null) registered = true
    }

    fun reset() {
        accountId = null
        keys = mutableMapOf()
        current = null
        registered = false
    }

    fun seal(text: String, theirs: String): Pair<String, String> {
        val mine = current ?: throw NotReady()
        val secret = keys[mine] ?: throw NotReady()
        val key = try { E2ECrypto.chatKey(secret, mine, theirs) } catch (_: Exception) { throw NotReady() }
        return E2ECrypto.seal(text.toByteArray(), key) to mine
    }

    // The words of a message, or null if this phone doesn't have the key to them.
    fun open(message: ChatMessage): String? {
        val key = keyFor(message) ?: return null
        return E2ECrypto.open(message.body, key)?.toString(Charsets.UTF_8)
    }

    // What a report hands over, so that this one chat can be read.
    fun reportKeys(messages: List<ChatMessage>): List<String> =
        messages.mapNotNull { keyFor(it)?.let { k -> Base64.getEncoder().encodeToString(k) } }.distinct()

    private fun keyFor(message: ChatMessage): ByteArray? = try {
        when {
            keys[message.senderKey] != null -> E2ECrypto.chatKey(keys[message.senderKey]!!, message.senderKey, message.toKey)
            keys[message.toKey] != null -> E2ECrypto.chatKey(keys[message.toKey]!!, message.toKey, message.senderKey)
            else -> null
        }
    } catch (_: Exception) {
        null
    }

    private fun load() {
        val text = Secure.read(account) ?: return
        val stored = runCatching { JsonFormat.decodeFromString(Stored.serializer(), text) }.getOrNull() ?: return
        for ((id, raw) in stored.keys) keys[id] = Base64.getDecoder().decode(raw)
        current = stored.current.takeIf { keys[it] != null }
    }

    private fun save() {
        val mine = current ?: return
        val stored = Stored(mine, keys.mapValues { Base64.getEncoder().encodeToString(it.value) })
        Secure.write(account, JsonFormat.encodeToString(Stored.serializer(), stored))
    }
}

// The words that aren't allowed, from the server, the same rules as for names and reviews.
// Nobody else can check a sealed message for abuse, so it's done on the phone.
object MessageFilter {
    private var words: Set<String> = emptySet()
    private val lookalikes = mapOf('0' to 'o', '1' to 'i', '3' to 'e', '4' to 'a', '5' to 's', '7' to 't', '@' to 'a', '$' to 's', '!' to 'i')
    private const val PREF = "filterWords"

    fun init(saved: Set<String>?) { words = saved ?: emptySet() }

    suspend fun load(save: (Set<String>) -> Unit) {
        val r = attempt { ApiClient.get<FilterResponse>("/api/filter") } ?: return
        val list = r.words ?: return
        words = list.toSet()
        save(words)
    }

    fun isBlocked(text: String, list: Set<String> = words): Boolean {
        val folded = java.text.Normalizer.normalize(text.lowercase(), java.text.Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "")
        val plain = folded.map { lookalikes[it] ?: it }.joinToString("")
        val parts = plain.split(Regex("[^a-z]+")).filter { it.isNotEmpty() }
        if (parts.any { it in list }) return true
        val squashed = parts.joinToString("")
        return squashed.length >= 6 && squashed in list
    }
}
