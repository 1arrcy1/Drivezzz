package eu.drivezzz.app.core

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import java.util.UUID
import kotlin.math.abs

// A route someone keeps, with a name of their own, so they needn't pick the same two spots again.
@Serializable
data class SavedRoute(val id: String = UUID.randomUUID().toString(), val name: String, val pickup: Place, val dropoff: Place)

// They stay on this phone, per account: the server never sees them. Privacy says so. The same as iOS's SavedRoutes.
object SavedRoutes {
    var routes by mutableStateOf<List<SavedRoute>>(emptyList())
        private set
    private var account: String? = null

    private fun key(account: String) = "savedRoutes.$account"

    fun use(account: String?) {
        if (account == this.account) return
        this.account = account
        val text = account?.let { Prefs.string(key(it)) }
        routes = text?.let { runCatching { JsonFormat.decodeFromString(ListSerializer(SavedRoute.serializer()), it) }.getOrNull() } ?: emptyList()
    }

    private fun save() {
        val a = account ?: return
        Prefs.set(key(a), JsonFormat.encodeToString(ListSerializer(SavedRoute.serializer()), routes))
    }

    // Without what the server added: it looks for the nearest road again each time.
    fun add(name: String, pickup: Place, dropoff: Place) {
        val shown = name.trim()
        routes = routes + SavedRoute(
            name = shown.ifEmpty { dropoff.label ?: "My route" },
            pickup = Place(pickup.lat, pickup.lng, pickup.label),
            dropoff = Place(dropoff.lat, dropoff.lng, dropoff.label),
        )
        save()
    }

    fun rename(route: SavedRoute, to: String) {
        val shown = to.trim()
        if (shown.isEmpty() || routes.none { it.id == route.id }) return
        routes = routes.map { if (it.id == route.id) it.copy(name = shown) else it }
        save()
    }

    fun remove(route: SavedRoute) {
        routes = routes.filter { it.id != route.id }
        save()
    }

    // The same two spots, give or take where the road was found: about 50 m.
    fun has(pickup: Place?, dropoff: Place?): Boolean {
        if (pickup == null || dropoff == null) return false
        fun close(a: Place, b: Place) = abs(a.lat - b.lat) < 0.0005 && abs(a.lng - b.lng) < 0.0008
        return routes.any { close(it.pickup, pickup) && close(it.dropoff, dropoff) }
    }

    fun forget(account: String?) {
        if (account == null) return
        Prefs.set(key(account), null)
        if (account == this.account) routes = emptyList()
    }
}
