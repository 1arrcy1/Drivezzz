package eu.drivezzz.app.core

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.engines.XSalsa20Engine
import org.bouncycastle.crypto.macs.Poly1305
import org.bouncycastle.crypto.params.KeyParameter
import org.bouncycastle.crypto.params.ParametersWithIV
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.security.SecureRandom

// Base58 (Solana's addresses and signatures) and NaCl's box: what Phantom-style wallet links encrypt with
// (X25519, then XSalsa20 and Poly1305). The same as Core/NaCl.swift, with the tests in Crypto tests against that file's output.
object Base58 {
    private const val ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

    fun encode(data: ByteArray): String {
        val digits = ArrayList<Int>()
        for (byte in data) {
            var carry = byte.toInt() and 0xFF
            for (i in digits.indices) {
                carry += digits[i] shl 8
                digits[i] = carry % 58
                carry /= 58
            }
            while (carry > 0) {
                digits.add(carry % 58)
                carry /= 58
            }
        }
        val zeros = data.takeWhile { it == 0.toByte() }.size
        return "1".repeat(zeros) + digits.reversed().joinToString("") { ALPHABET[it].toString() }
    }

    fun decode(text: String): ByteArray? {
        val bytes = ArrayList<Int>()
        for (char in text) {
            val value = ALPHABET.indexOf(char)
            if (value < 0) return null
            var carry = value
            for (i in bytes.indices) {
                carry += bytes[i] * 58
                bytes[i] = carry and 0xFF
                carry = carry shr 8
            }
            while (carry > 0) {
                bytes.add(carry and 0xFF)
                carry = carry shr 8
            }
        }
        val zeros = text.takeWhile { it == ALPHABET[0] }.length
        return ByteArray(zeros) + bytes.reversed().map { it.toByte() }.toByteArray()
    }
}

object NaCl {
    class KeyPair(val secret: ByteArray) {
        val publicKey: ByteArray = X25519PrivateKeyParameters(secret, 0).generatePublicKey().encoded
    }

    fun newKeyPair(): KeyPair = KeyPair(randomBytes(32))

    // crypto_box_beforenm: the key two sides share, from one's secret key and the other's public key.
    fun sharedKey(secret: ByteArray, publicKey: ByteArray): ByteArray {
        val shared = x25519(secret, publicKey)
        return hsalsa20(shared, ByteArray(16))
    }

    fun x25519(secret: ByteArray, publicKey: ByteArray): ByteArray {
        val agreement = X25519Agreement()
        agreement.init(X25519PrivateKeyParameters(secret, 0))
        val out = ByteArray(32)
        agreement.calculateAgreement(X25519PublicKeyParameters(publicKey, 0), out, 0)
        return out
    }

    // crypto_box_afternm: tag, then ciphertext.
    fun seal(message: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray {
        val (polyKey, cipher) = xsalsa(message, nonce, key)
        return poly1305(cipher, polyKey) + cipher
    }

    fun open(box: ByteArray, nonce: ByteArray, key: ByteArray): ByteArray? {
        if (box.size < 16 || nonce.size != 24) return null
        val tag = box.copyOfRange(0, 16)
        val cipher = box.copyOfRange(16, box.size)
        val (polyKey, plain) = xsalsa(cipher, nonce, key)
        // Constant time, as for any tag.
        val expected = poly1305(cipher, polyKey)
        var differ = 0
        for (i in 0 until 16) differ = differ or (expected[i].toInt() xor tag[i].toInt())
        return if (differ == 0) plain else null
    }

    private fun xsalsa(input: ByteArray, nonce: ByteArray, key: ByteArray): Pair<ByteArray, ByteArray> {
        val engine = XSalsa20Engine()
        engine.init(true, ParametersWithIV(KeyParameter(key), nonce))
        val polyKey = ByteArray(32)
        engine.processBytes(ByteArray(32), 0, 32, polyKey, 0)
        val out = ByteArray(input.size)
        engine.processBytes(input, 0, input.size, out, 0)
        return polyKey to out
    }

    private fun poly1305(message: ByteArray, key: ByteArray): ByteArray {
        val mac = Poly1305()
        mac.init(KeyParameter(key))
        mac.update(message, 0, message.size)
        val out = ByteArray(16)
        mac.doFinal(out, 0)
        return out
    }

    private fun load32(b: ByteArray, i: Int): Int =
        (b[i].toInt() and 0xFF) or ((b[i + 1].toInt() and 0xFF) shl 8) or ((b[i + 2].toInt() and 0xFF) shl 16) or ((b[i + 3].toInt() and 0xFF) shl 24)

    private val SIGMA = "expand 32-byte k".toByteArray()

    private fun hsalsa20(key: ByteArray, input: ByteArray): ByteArray {
        val x = intArrayOf(
            load32(SIGMA, 0), load32(key, 0), load32(key, 4), load32(key, 8), load32(key, 12), load32(SIGMA, 4),
            load32(input, 0), load32(input, 4), load32(input, 8), load32(input, 12), load32(SIGMA, 8),
            load32(key, 16), load32(key, 20), load32(key, 24), load32(key, 28), load32(SIGMA, 12),
        )
        fun r(a: Int, b: Int, c: Int, s: Int) { x[a] = x[a] xor (x[b] + x[c]).rotateLeft(s) }
        repeat(10) {
            r(4, 0, 12, 7); r(8, 4, 0, 9); r(12, 8, 4, 13); r(0, 12, 8, 18)
            r(9, 5, 1, 7); r(13, 9, 5, 9); r(1, 13, 9, 13); r(5, 1, 13, 18)
            r(14, 10, 6, 7); r(2, 14, 10, 9); r(6, 2, 14, 13); r(10, 6, 2, 18)
            r(3, 15, 11, 7); r(7, 3, 15, 9); r(11, 7, 3, 13); r(15, 11, 7, 18)
            r(1, 0, 3, 7); r(2, 1, 0, 9); r(3, 2, 1, 13); r(0, 3, 2, 18)
            r(6, 5, 4, 7); r(7, 6, 5, 9); r(4, 7, 6, 13); r(5, 4, 7, 18)
            r(11, 10, 9, 7); r(8, 11, 10, 9); r(9, 8, 11, 13); r(10, 9, 8, 18)
            r(12, 15, 14, 7); r(13, 12, 15, 9); r(14, 13, 12, 13); r(15, 14, 13, 18)
        }
        val out = ByteArray(32)
        intArrayOf(x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]).forEachIndexed { i, w ->
            out[i * 4] = w.toByte()
            out[i * 4 + 1] = (w ushr 8).toByte()
            out[i * 4 + 2] = (w ushr 16).toByte()
            out[i * 4 + 3] = (w ushr 24).toByte()
        }
        return out
    }

    private val random = SecureRandom()
    fun randomBytes(count: Int): ByteArray = ByteArray(count).also { random.nextBytes(it) }
}
