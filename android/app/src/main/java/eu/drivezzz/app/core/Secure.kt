package eu.drivezzz.app.core

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// The login and the keys: encrypted with a key that never leaves this phone's Keystore. What iOS keeps in its Keychain, but it
// doesn't survive reinstalling; the phone's id does, see ServerConfig.deviceId. A test server has its own login and chat keys,
// so trying it leaves this phone's real account alone.
object Secure {
    private const val ALIAS = "drivezzz.secure"
    private lateinit var prefs: SharedPreferences
    private var prefix = ""
    // In tests off the phone, where there's no Keystore.
    private var memory: MutableMap<String, String>? = null

    fun useMemory() {
        memory = mutableMapOf()
    }

    fun init(context: Context, testServer: Boolean) {
        prefs = context.getSharedPreferences("secure", Context.MODE_PRIVATE)
        prefix = if (testServer) "test." else ""
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    fun read(name: String): String? {
        memory?.let { return it[name] }
        val stored = prefs.getString(prefix + name, null) ?: return null
        return try {
            val raw = Base64.decode(stored, Base64.NO_WRAP)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
            String(cipher.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
        } catch (_: Exception) {
            null
        }
    }

    fun write(name: String, value: String?) {
        memory?.let { m ->
            if (value == null) m.remove(name) else m[name] = value
            return
        }
        if (value == null) {
            prefs.edit().remove(prefix + name).apply()
            return
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        prefs.edit().putString(prefix + name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
    }
}
