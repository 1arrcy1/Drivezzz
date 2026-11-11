package eu.drivezzz.app.core

import android.content.Context
import android.content.SharedPreferences
import androidx.activity.result.ActivityResultLauncher

// What iOS keeps in UserDefaults.
object Prefs {
    private lateinit var prefs: SharedPreferences

    fun init(context: Context) {
        prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    }

    fun string(key: String): String? = prefs.getString(key, null)
    fun bool(key: String): Boolean = prefs.getBoolean(key, false)
    fun double(key: String): Double? = if (prefs.contains(key)) prefs.getFloat(key, 0f).toDouble() else null
    fun stringSet(key: String): Set<String>? = prefs.getStringSet(key, null)
    fun set(key: String, value: String?) = prefs.edit().putString(key, value).apply()
    fun set(key: String, value: Boolean) = prefs.edit().putBoolean(key, value).apply()
    fun set(key: String, value: Double) = prefs.edit().putFloat(key, value.toFloat()).apply()
    fun set(key: String, value: Set<String>) = prefs.edit().putStringSet(key, value).apply()
    // On disk before this returns: for when the app is about to be gone.
    fun setNow(key: String, value: Boolean) { prefs.edit().putBoolean(key, value).commit() }
}

// Asking for permissions goes through the one Activity. Asked before it's there, it waits for it.
object Permissions {
    var launcher: ActivityResultLauncher<Array<String>>? = null
        set(value) {
            field = value
            if (value == null) open = false
            next()
        }

    // Android shows one request at a time and drops one made while another is open, which lost the notifications question to the
    // location one on every first start. So they wait in line, and MainActivity says when an answer came.
    private val line = ArrayDeque<List<String>>()
    private var open = false

    fun ask(vararg permissions: String) {
        val wanted = permissions.toList()
        if (wanted !in line) line.addLast(wanted)
        next()
    }

    fun answered() {
        open = false
        next()
    }

    private fun next() {
        val l = launcher ?: return
        if (open) return
        val wanted = line.removeFirstOrNull() ?: return
        open = true
        l.launch(wanted.toTypedArray())
    }

    fun askLocation() = ask(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION)
}
