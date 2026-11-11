package eu.drivezzz.app.features.checks

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import android.util.Log
import eu.drivezzz.app.BuildConfig
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.Empty
import eu.drivezzz.app.core.Secure
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import java.nio.ByteBuffer
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec

// Android's Key Attestation, doing what AppAttest.swift does with Apple's App Attest (server/src/attest.js): lets the server know
// the face match and what was read from a photo came from this app, unchanged, on a phone with a locked bootloader. A key in the
// phone's secure hardware (StrongBox where there is one), certified once per account and server by the phone's attestation
// certificates, which chain to Google; then used to sign what's sent. Where that can't be (an emulator, an unlocked bootloader)
// nothing is signed, and the server asks a person instead, as before.
object AppAttest {
    @Serializable private data class Challenge(val id: String, val challenge: String)

    private const val STORE = "AndroidKeyStore"
    private val lock = Mutex()
    private fun alias(userId: String) = "drivezzz-attest-$userId"
    private fun store() = KeyStore.getInstance(STORE).apply { load(null) }

    // The key's id for this account: made and certified the first time. Null when this phone can't (then a person looks).
    suspend fun keyId(userId: String): String? = lock.withLock {
        Secure.read("attestKey.$userId")?.let { id ->
            if (withContext(Dispatchers.IO) { store().containsAlias(alias(userId)) }) return@withLock id
        }
        // A phone the server turned down once (an unlocked bootloader, say) isn't asked again for a day, unless this is another build
        // of the app: the server may take that one (8 November 2026: a release APK's key wasn't taken, and an update had to wait a day).
        val refused = Secure.read("attestRefused.$userId")?.split(":")
        val refusedAt = refused?.getOrNull(0)?.toLongOrNull()
        val sameBuild = refused?.getOrNull(1) == BuildConfig.VERSION_CODE.toString()
        if (refusedAt != null && sameBuild && System.currentTimeMillis() - refusedAt < 86_400_000) return@withLock null
        try {
            val c: Challenge = ApiClient.post("/api/attest/challenge")
            val (id, chain) = withContext(Dispatchers.IO) { makeKey(alias(userId), sha256(c.challenge.toByteArray())) }
            ApiClient.post<Empty>("/api/attest/key", mapOf("platform" to "android", "keyId" to id, "chain" to chain, "challengeId" to c.id))
            Secure.write("attestKey.$userId", id)
            Secure.write("attestCounter.$userId", "0")
            Secure.write("attestRefused.$userId", null)
            id
        } catch (e: Exception) {
            Log.w("AppAttest", "This phone's key couldn't be certified", e)
            if (e.message?.contains("real Drivezzz app") == true) Secure.write("attestRefused.$userId", "${System.currentTimeMillis()}:${BuildConfig.VERSION_CODE}")
            null
        }
    }

    // A new key in secure hardware, attested for this challenge: its id (as the server works it out) and the certificate chain
    // (DER, base64, the key's own first). Blocking.
    fun makeKey(alias: String, challenge: ByteArray): Pair<String, List<String>> {
        val ks = store()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
        fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setAttestationChallenge(challenge)
            .setIsStrongBoxBacked(strongBox)
            .build()
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE)
        try {
            generator.initialize(spec(strongBox = true))
            generator.generateKeyPair()
        } catch (_: StrongBoxUnavailableException) {
            generator.initialize(spec(strongBox = false))
            generator.generateKeyPair()
        }
        val chain = ks.getCertificateChain(alias).map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
        val spki = ks.getCertificate(alias).publicKey.encoded
        // As Apple's: the SHA-256 of the public key's point (the last 65 bytes of its SubjectPublicKeyInfo).
        val id = Base64.encodeToString(sha256(spki.copyOfRange(spki.size - 65, spki.size)), Base64.NO_WRAP)
        return id to chain
    }

    // For sending a photo with what was read from it. The lines are signed with the photo's hash after them, as signedByApp in
    // server/src/checks.js does. Empty where the phone can't: the server then asks a person.
    suspend fun headers(lines: List<String>, photo: ByteArray, userId: String?): Map<String, String> {
        if (userId == null) return emptyMap()
        val keyId = keyId(userId) ?: return emptyMap()
        val text = (lines + hash(photo)).joinToString("\n")
        val assertion = sign(text.toByteArray(), keyId, userId) ?: return emptyMap()
        return mapOf("X-Attest-Key" to keyId, "X-Attest-Assertion" to assertion)
    }

    fun hash(bytes: ByteArray): String = sha256(bytes).joinToString("") { "%02x".format(it) }

    // Signs exactly these bytes: "drivezzz-android-1", a counter that only goes up (so nothing signed can be sent twice) and their
    // SHA-256. The assertion is the counter and the signature. Null when it can't (the server then asks a person).
    suspend fun sign(payload: ByteArray, keyId: String, userId: String): String? = lock.withLock {
        withContext(Dispatchers.IO) {
            try {
                val key = store().getKey(alias(userId), null) as? PrivateKey ?: return@withContext null
                val counter = (Secure.read("attestCounter.$userId")?.toIntOrNull() ?: 0) + 1
                Secure.write("attestCounter.$userId", counter.toString())
                val n = ByteBuffer.allocate(4).putInt(counter).array()
                val signature = Signature.getInstance("SHA256withECDSA").run {
                    initSign(key)
                    update("drivezzz-android-1".toByteArray())
                    update(n)
                    update(sha256(payload))
                    sign()
                }
                Base64.encodeToString(n + signature, Base64.NO_WRAP)
            } catch (e: Exception) {
                // A key the phone lost (restored from a backup, say): start again next time.
                Log.w("AppAttest", "Couldn't sign", e)
                Secure.write("attestKey.$userId", null)
                null
            }
        }
    }

    private fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
}
