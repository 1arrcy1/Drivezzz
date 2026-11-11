package eu.drivezzz.app.core

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

// Where this phone is, from the platform's own location providers, so it needs no Google services. Drive mode and a ride under way
// keep it running in the background through DriveService: that's what shows the notification, and nothing outside the app can stop
// it. A driver only goes offline by sliding back or closing the app.
object LocationService : LocationListener {
    private lateinit var context: Context
    private lateinit var manager: LocationManager
    private var updating = false
    private var everyMs = 2000L
    private val fixes = MutableSharedFlow<Location>(replay = 0, extraBufferCapacity = 1)

    // Not state: a screen that read this in composition would be redone with every fix, map and all. Use `hasFix`, or OnLocation.
    @Volatile var location: Location? = null
        private set
    // Changes once, not with every GPS fix.
    var hasFix by mutableStateOf(false)
        private set
    private var fine by mutableStateOf(false)
    private var coarse by mutableStateOf(false)
    private var asked by mutableStateOf(false)
    var inBackgroundMode = false
        private set

    val locationUpdates: SharedFlow<Location> get() = fixes.asSharedFlow()

    val denied: Boolean get() = asked && !fine && !coarse
    // Rough location can't tell if you're within 100 m of a car.
    val imprecise: Boolean get() = coarse && !fine
    val allowed: Boolean get() = fine || coarse

    fun init(context: Context) {
        this.context = context.applicationContext
        manager = context.getSystemService(LocationManager::class.java)
        asked = Prefs.bool("locationAsked")
        refresh()
        if (allowed) lastKnown()
    }

    // Permissions can change in Settings while the app is away.
    fun refresh() {
        fine = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        coarse = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (allowed) {
            if (updating) return
            startUpdates()
        } else if (updating) {
            manager.removeUpdates(this)
            updating = false
        }
    }

    fun start() {
        if (!allowed && !asked) {
            Permissions.askLocation()
            return
        }
        refresh()
    }

    fun answered() {
        asked = true
        Prefs.set("locationAsked", true)
        refresh()
    }

    @SuppressLint("MissingPermission")
    private fun lastKnown() {
        val best = providers().mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time }
        if (best != null) accept(best)
    }

    private fun providers(): List<String> {
        val wanted = buildList {
            add(LocationManager.GPS_PROVIDER)
            add(LocationManager.NETWORK_PROVIDER)
            add(LocationManager.FUSED_PROVIDER)
        }
        val present = manager.allProviders
        return wanted.filter { it in present }
    }

    @SuppressLint("MissingPermission")
    private fun startUpdates() {
        updating = true
        lastKnown()
        for (provider in providers()) {
            runCatching { manager.requestLocationUpdates(provider, everyMs, 0f, this, Looper.getMainLooper()) }
        }
    }

    // A navigation screen follows the road as closely as the phone can.
    fun setNavigating(on: Boolean) {
        val wanted = if (on) 1000L else 2000L
        if (wanted == everyMs) return
        everyMs = wanted
        if (updating) {
            manager.removeUpdates(this)
            startUpdates()
        }
    }

    fun setBackground(on: Boolean) {
        if (on == inBackgroundMode) return
        inBackgroundMode = on
        val intent = Intent(context, DriveService::class.java)
        if (on) {
            if (allowed) runCatching { ContextCompat.startForegroundService(context, intent) }
        } else {
            context.stopService(intent)
        }
    }

    private fun accept(fix: Location) {
        val old = location
        // Several providers answer at once: a rough one doesn't replace a sharp one, unless that went quiet.
        if (old != null && fix.provider != old.provider) {
            val quiet = fix.time - old.time > 10_000
            if (!quiet && fix.hasAccuracy() && old.hasAccuracy() && fix.accuracy > old.accuracy + 15) return
        }
        location = fix
        if (!hasFix) hasFix = true
        fixes.tryEmit(fix)
    }

    override fun onLocationChanged(location: Location) = accept(location)
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}
    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
}

val Location.course: Double? get() = if (hasBearing()) bearing.toDouble() else null
val Location.speedOrNull: Double? get() = if (hasSpeed()) speed.toDouble() else null
val Location.place: LatLng get() = LatLng(latitude, longitude)

// For what must follow every GPS fix: this only calls `action`, it doesn't redo the screen around it with its map.
@Composable
fun OnLocation(action: (Location) -> Unit) {
    val current by rememberUpdatedState(action)
    LaunchedEffect(Unit) {
        LocationService.locationUpdates.collect { current(it) }
    }
}
