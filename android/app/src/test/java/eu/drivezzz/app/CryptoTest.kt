package eu.drivezzz.app

import eu.drivezzz.app.core.Base58
import eu.drivezzz.app.core.E2ECrypto
import eu.drivezzz.app.core.ECIES
import eu.drivezzz.app.core.NaCl
import eu.drivezzz.app.core.Secp256k1
import eu.drivezzz.app.core.WalletConnectClient
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File
import java.security.MessageDigest
import java.util.Base64

// Against what the iPhone's own code produces: Core/E2E.swift, NaCl.swift, MetaMaskConnect.swift and CryptoKit. ios-vectors.txt comes
// from compiling those files and running them; see docs/android.md. What a wallet or the other person's phone reads has to match byte for byte.
class CryptoTest {
    private val v: Map<String, String> = javaClass.classLoader!!.getResource("ios-vectors.txt")!!.readText().lines()
        .filter { it.contains('=') }
        .associate { it.substringBefore('=') to it.substringAfter('=') }

    private fun unhex(t: String) = ByteArray(t.length / 2) { t.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private val a = unhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
    private val b = unhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")

    @Test fun publicKeys() {
        assertEquals(v["aPub"], hex(NaCl.KeyPair(a).publicKey))
        assertEquals(v["bPub"], hex(NaCl.KeyPair(b).publicKey))
    }

    @Test fun base58() {
        for ((k, value) in v) {
            if (!k.startsWith("b58 ")) continue
            val data = unhex(k.removePrefix("b58 "))
            assertEquals(value, Base58.encode(data))
            assertArrayEquals(data, Base58.decode(value))
        }
        assertNull(Base58.decode("0OIl"))
    }

    @Test fun naclBox() {
        val shared = NaCl.sharedKey(a, unhex(v["bPub"]!!))
        assertEquals(v["box.shared"], hex(shared))
        val sealed = NaCl.seal(unhex(v["box.msg"]!!), unhex(v["box.nonce"]!!), shared)
        assertEquals(v["box.sealed"], hex(sealed))
        assertArrayEquals(unhex(v["box.msg"]!!), NaCl.open(unhex(v["box.sealed"]!!), unhex(v["box.nonce"]!!), shared))
        // The other side gets the same key, and a changed byte doesn't open.
        assertEquals(hex(shared), hex(NaCl.sharedKey(b, unhex(v["aPub"]!!))))
        val broken = sealed.copyOf().also { it[20] = (it[20] + 1).toByte() }
        assertNull(NaCl.open(broken, unhex(v["box.nonce"]!!), shared))
    }

    @Test fun e2eMatchesIos() {
        val key = E2ECrypto.chatKey(a, v["e2e.mine"]!!, v["e2e.theirs"]!!)
        assertEquals(v["e2e.key"], Base64.getEncoder().encodeToString(key))
        // Either side gets the same key.
        assertArrayEquals(key, E2ECrypto.chatKey(b, v["e2e.theirs"]!!, v["e2e.mine"]!!))
        val msg = unhex(v["box.msg"]!!)
        assertEquals(v["e2e.sealed"], E2ECrypto.seal(msg, key, unhex(v["e2e.nonce"]!!)))
        assertArrayEquals(msg, E2ECrypto.open(v["e2e.sealed"]!!, key))
        assertNull(E2ECrypto.open(v["e2e.sealed"]!!, ByteArray(32)))
    }

    @Test fun walletConnectMatchesIos() {
        val shared = NaCl.x25519(a, NaCl.KeyPair(b).publicKey)
        val session = E2ECrypto.hkdf(shared, null, null)
        assertEquals(v["wc.session"], Base64.getEncoder().encodeToString(session))
        assertEquals(v["wc.topic"], hex(MessageDigest.getInstance("SHA-256").digest(session)))
        val nonce = unhex(v["wc.nonce"]!!)
        val msg = unhex(v["box.msg"]!!)
        val box = WalletConnectClient.chacha(true, msg, session, nonce)
        assertEquals(v["wc.sealed"], hex(nonce + box))
        assertArrayEquals(msg, WalletConnectClient.chacha(false, box, session, nonce))
        val signing = Ed25519PrivateKeyParameters(a, 0).generatePublicKey().encoded
        assertEquals(v["wc.signPub"], hex(signing))
        assertEquals(v["wc.did"], "did:key:z" + Base58.encode(byteArrayOf(0xed.toByte(), 0x01) + signing))
    }

    @Test fun eciesOpensWhatIosSealed() {
        val secret = unhex(v["ec.secret"]!!)
        assertEquals(v["ec.pubCompressed"], hex(Secp256k1.publicKey(secret, true)))
        assertEquals(v["ec.pubFull"], hex(Secp256k1.publicKey(secret, false)))
        assertArrayEquals(unhex(v["ec.msg"]!!), ECIES.open(unhex(v["ec.sealed"]!!), secret))
    }

    @Test fun eciesRoundTrip() {
        val secret = Secp256k1.newSecret()
        val plain = "hello metamask".toByteArray()
        assertArrayEquals(plain, ECIES.open(ECIES.seal(plain, Secp256k1.publicKey(secret, true)), secret))
    }

    // Leaves what this code sealed for the iPhone's code to open, the other way round. The Swift generator reads it when given the file.
    @Test fun writeForSwift() {
        val out = System.getProperty("drivezzz.vectorsOut") ?: File("build/kotlin-vectors.txt").path
        val msg = "sealed on Android"
        val pub = Secp256k1.publicKey(unhex(v["ec.secret"]!!), true)
        val chat = Base64.getDecoder().decode(v["e2e.key"]!!)
        val shared = unhex(v["box.shared"]!!)
        File(out).writeText(
            "kotlin.ecies=${hex(ECIES.seal(msg.toByteArray(), pub))}\n" +
                "kotlin.e2e=${E2ECrypto.seal(msg.toByteArray(), chat)}\n" +
                "kotlin.box=${hex(NaCl.seal(msg.toByteArray(), unhex(v["box.nonce"]!!), shared))}\n",
        )
    }
}
