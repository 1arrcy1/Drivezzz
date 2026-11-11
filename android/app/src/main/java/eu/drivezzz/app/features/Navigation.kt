package eu.drivezzz.app.features

import android.content.Context
import android.location.Location
import android.speech.tts.TextToSpeech
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.LatLng
import eu.drivezzz.app.core.Prefs
import eu.drivezzz.app.core.speedOrNull
import eu.drivezzz.app.map.Router
import eu.drivezzz.app.ui.Sym
import eu.drivezzz.app.ui.T
import eu.drivezzz.app.ui.Theme
import eu.drivezzz.app.ui.bold
import eu.drivezzz.app.ui.digits
import eu.drivezzz.app.ui.lifted
import eu.drivezzz.app.ui.medium
import eu.drivezzz.app.ui.semibold
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

fun metresBetween(a: LatLng, b: LatLng): Double {
    val r = 6_371_000.0
    val dLat = (b.lat - a.lat) * PI / 180
    val dLng = (b.lng - a.lng) * PI / 180
    val h = sin(dLat / 2) * sin(dLat / 2) + cos(a.lat * PI / 180) * cos(b.lat * PI / 180) * sin(dLng / 2) * sin(dLng / 2)
    return 2 * r * asin(min(1.0, sqrt(h)))
}

fun bearingBetween(a: LatLng, b: LatLng): Double {
    val lat1 = a.lat * PI / 180
    val lat2 = b.lat * PI / 180
    val dLng = (b.lng - a.lng) * PI / 180
    return atan2(sin(dLng) * cos(lat2), cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)) * 180 / PI
}

enum class Turn {
    Straight, SlightLeft, Left, SharpLeft, SlightRight, Right, SharpRight, UTurn, Arrive;

    val symbol: ImageVector
        get() = when (this) {
            Straight -> Sym.straight
            SlightLeft -> Sym.slightLeft
            Left, SharpLeft -> Sym.turnLeft
            SlightRight -> Sym.slightRight
            Right, SharpRight -> Sym.turnRight
            UTurn -> Sym.uTurn
            Arrive -> Sym.flagCheckered
        }

    companion object {
        // From the road's direction before and after.
        fun between(incoming: Double, outgoing: Double): Turn {
            val angle = ((outgoing - incoming + 540) % 360 + 360) % 360 - 180
            return when {
                angle < -160 || angle >= 160 -> UTurn
                angle < -110 -> SharpLeft
                angle < -45 -> Left
                angle < -15 -> SlightLeft
                angle <= 15 -> Straight
                angle <= 45 -> SlightRight
                angle <= 110 -> Right
                else -> SharpRight
            }
        }
    }
}

// Turn-by-turn inside the app, on the routes behind map/Routing.kt, which don't touch our server.
// A route step means: drive along its line, then do what it says at the end of that line.
class DriveNavigator(private val context: Context) : TextToSpeech.OnInitListener {
    class Step(val text: String, val endsAt: Double, val turn: Turn) // endsAt: metres along the route

    var line by mutableStateOf<List<LatLng>>(emptyList())
        private set
    var steps by mutableStateOf<List<Step>>(emptyList())
        private set
    var index by mutableIntStateOf(0)
        private set
    var failed by mutableStateOf(false)
        private set
    var muted by mutableStateOf(Prefs.bool("navigationMuted"))
        private set
    private var along by mutableDoubleStateOf(0.0)
    private var total by mutableDoubleStateOf(0.0)
    private var seconds by mutableDoubleStateOf(0.0)

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var target: LatLng? = null
    private var cumulative: List<Double> = emptyList()
    private var routing = false
    private var lastRouted = 0L
    private var offRoute = 0
    private var routeNumber = 0
    private val spoken = mutableSetOf<String>()
    // Made when it first has to speak: nothing that isn't navigating should pay for it.
    private var voice: TextToSpeech? = null
    private var voiceReady = false
    private var saying: String? = null

    val current: Step? get() = steps.getOrNull(index)
    val next: Step? get() = steps.getOrNull(index + 1)
    val metresToTurn: Double? get() = current?.let { max(0.0, it.endsAt - along) }
    val metresLeft: Double? get() = if (line.isEmpty()) null else max(0.0, total - along)
    val secondsLeft: Double? get() = if (total > 0) seconds * (metresLeft ?: 0.0) / total else null

    fun go(place: LatLng, here: Location?) {
        target = place
        clear()
        if (here != null) update(here)
    }

    fun stop() {
        target = null
        clear()
        voice?.stop()
    }

    fun shutdown() {
        stop()
        voice?.shutdown()
        voice = null
    }

    fun toggleMuted() {
        muted = !muted
        Prefs.set("navigationMuted", muted)
        if (muted) voice?.stop()
    }

    fun update(here: Location) {
        if (target == null) return
        if (line.size <= 1) {
            if (System.currentTimeMillis() - lastRouted > 15_000) route(here)
            return
        }
        // The nearest spot on the route, just behind or ahead of where we were: roads can pass close to themselves.
        var nearest = Double.POSITIVE_INFINITY
        var spot = along
        val metresPerLng = 111_320 * cos(here.latitude * PI / 180)
        for (i in 0 until line.size - 1) {
            if (cumulative[i + 1] < along - 100 || cumulative[i] > along + 1500) continue
            val bx = (line[i + 1].lng - line[i].lng) * metresPerLng
            val by = (line[i + 1].lat - line[i].lat) * 111_320
            val px = (here.longitude - line[i].lng) * metresPerLng
            val py = (here.latitude - line[i].lat) * 111_320
            val squared = bx * bx + by * by
            val t = if (squared > 0) min(1.0, max(0.0, (px * bx + py * by) / squared)) else 0.0
            val off = hypot(px - t * bx, py - t * by)
            if (off < nearest) {
                nearest = off
                spot = cumulative[i] + t * (cumulative[i + 1] - cumulative[i])
            }
        }
        if (nearest > max(50.0, (if (here.hasAccuracy()) here.accuracy.toDouble() else 0.0) * 1.5)) {
            offRoute++
            if (offRoute >= 3 && System.currentTimeMillis() - lastRouted > 10_000) route(here)
            return
        }
        offRoute = 0
        along = spot
        while (index < steps.size - 1 && along > steps[index].endsAt - 5) index++
        announce(max(0.0, here.speedOrNull ?: 0.0))
    }

    private fun clear() {
        line = emptyList()
        steps = emptyList()
        cumulative = emptyList()
        index = 0
        along = 0.0
        total = 0.0
        seconds = 0.0
        failed = false
        offRoute = 0
        lastRouted = 0
        spoken.clear()
    }

    private fun route(here: Location) {
        val goal = target ?: return
        if (routing) return
        val from = LatLng(here.latitude, here.longitude)
        // Already there: there's no way left to show.
        if (metresBetween(from, goal) <= 30) return
        routing = true
        lastRouted = System.currentTimeMillis()
        offRoute = 0
        scope.launch {
            val found = Router.route(from, goal)
            routing = false
            // Still where we're going: the ride may have moved on while this was on its way.
            if (target != goal) return@launch
            if (found != null) use(found) else if (line.isEmpty()) failed = true
        }
    }

    private fun use(route: Router.Route) {
        val points = ArrayList<LatLng>()
        val metres = ArrayList<Double>()
        val ends = ArrayList<Double>()
        for (step in route.steps) {
            for (point in step.line) {
                val last = points.lastOrNull()
                if (last != null) {
                    val gap = metresBetween(last, point)
                    if (gap == 0.0) continue
                    metres.add((metres.lastOrNull() ?: 0.0) + gap)
                } else {
                    metres.add(0.0)
                }
                points.add(point)
            }
            ends.add(metres.lastOrNull() ?: 0.0)
        }
        val length = metres.lastOrNull()
        if (points.size <= 1 || length == null) {
            failed = line.isEmpty()
            return
        }
        cumulative = metres
        fun spot(at: Double): LatLng {
            val after = metres.indexOfFirst { it >= at }
            if (after <= 0) return if (at <= 0) points.first() else points.last()
            val start = metres[after - 1]
            val t = (at - start) / (metres[after] - start)
            return LatLng(points[after - 1].lat + t * (points[after].lat - points[after - 1].lat), points[after - 1].lng + t * (points[after].lng - points[after - 1].lng))
        }
        line = points
        steps = route.steps.mapIndexed { i, step ->
            // A step can end some way into its turn, so the road's direction is taken further back and further ahead.
            val end = ends[i]
            val turn = if (i == route.steps.lastIndex) Turn.Arrive else Turn.between(bearingBetween(spot(end - 50), spot(end - 15)), bearingBetween(spot(end), spot(end + 35)))
            Step(step.text.ifEmpty { "Continue" }, end, turn)
        }
        index = 0
        along = 0.0
        total = length
        seconds = route.seconds
        failed = false
        routeNumber++
    }

    // Once well before a turn, once just before it. Further ahead the faster you go.
    private fun announce(speed: Double) {
        if (muted) return
        val step = current ?: return
        val metres = metresToTurn ?: return
        val key = "$routeNumber-$index"
        if (metres <= max(50.0, speed * 4)) {
            if (key + "near" in spoken) return
            spoken.add(key + "near")
            spoken.add(key + "far")
            say(step.text)
        } else if (metres <= max(250.0, speed * 15)) {
            if (key + "far" in spoken) return
            spoken.add(key + "far")
            say(step.text)
        }
    }

    private fun say(text: String) {
        if (voice == null) {
            saying = text
            voice = TextToSpeech(context.applicationContext, this)
            return
        }
        if (voiceReady) voice?.speak(text, TextToSpeech.QUEUE_FLUSH, null, text.hashCode().toString()) else saying = text
    }

    override fun onInit(status: Int) {
        if (status != TextToSpeech.SUCCESS) return
        voiceReady = true
        // The words are in English for now: docs/android.md.
        voice?.language = Locale.ENGLISH
        saying?.let { voice?.speak(it, TextToSpeech.QUEUE_FLUSH, null, it.hashCode().toString()) }
        saying = null
    }

    companion object {
        fun spoken(metres: Double): String {
            if (metres >= 1000) return String.format(Locale.US, "%.1f km", metres / 1000)
            return "${(metres / 10).roundToInt() * 10} m"
        }
    }
}

// The next turn, along the top of the map.
@Composable
fun NavigationBanner(nav: DriveNavigator) {
    val step = nav.current ?: return
    val toTurn = nav.metresToTurn ?: 0.0
    Column(
        Modifier.fillMaxWidth().lifted(1f, 24.dp).background(Theme.night, RoundedCornerShape(24.dp)).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(step.turn.symbol, null, tint = Color.White, modifier = Modifier.size(44.dp))
            Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
                Text(DriveNavigator.spoken(toTurn), style = T.title2.bold.digits, color = Color.White)
                Text(step.text, style = T.subheadline.medium, color = Color.White, maxLines = 2)
            }
        }
        val then = nav.next
        if (then != null && toTurn < 300) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Then", style = T.caption.semibold, color = Color.White.copy(alpha = 0.85f))
                Icon(then.turn.symbol, null, tint = Color.White.copy(alpha = 0.85f), modifier = Modifier.size(16.dp))
            }
        }
    }
}

// A driver's car as a rider sees it, from the positions the server passes on: GPS wobbles, and a car standing still mustn't creep or
// jump (Pieter, 8 November 2026). The server keeps a position within 15 m as no move (`sameSpotWithin`); this holds the car still
// for what's still about a fix's accuracy, and the map glides it to a real move (MapAnnotation's `glide`). Asked while composing:
// the same position gives the same answer. As SteadyCar in Navigation.swift.
class SteadyCar {
    private var spot: LatLng? = null
    private var ride: String? = null

    companion object {
        const val HOLD = 30.0 // metres: twice the server's 15, as a phone standing still wanders about that far
    }

    // `ride`: whose ride, so another ride's car starts where it is.
    fun follow(at: LatLng?, ride: String?): LatLng? {
        val shown = spot
        if (at == null || shown == null || ride != this.ride || metresBetween(shown, at) >= HOLD) {
            spot = at
            this.ride = ride
        }
        return spot
    }
}

// Which way your vehicle on the map points, and where it stands. GPS wobbles, also standing still, so only a real move counts: it
// points the way it's really moving, whichever way the map is turned, and standing still it stays put. Read only by the vehicle where
// it can be (its turn in drawing, its spot in placing): it changes with every fix and every frame of turning the map, and the screen
// around it, with its map, needn't know. As DriveHeading in Navigation.swift.
class DriveHeading {
    var angle by androidx.compose.runtime.mutableFloatStateOf(0f) // never jumps: from 359 to 1 it turns the short way round
        private set
    var parked by mutableStateOf<LatLng?>(null) // standing still: here, rather than wherever GPS wanders to
        private set
    var course = 0.0 // the way it's moving, from north
        private set
    private var mapHeading = 0.0
    private var lastSpot: Location? = null
    private var stillSpot: Location? = null
    // Following on a drive the map itself turns with the car, so it just points up.
    var pinned = false
        set(value) {
            if (value == field) return
            field = value
            refresh()
        }

    companion object {
        const val REAL_MOVE = 15.0 // metres; as on the server (`sameSpotWithin`)
        const val REAL_SPEED = 3.0 // metres a second: about 10 km/h. Under that a phone's own course is mostly noise
        const val STANDING = 0.5 // metres a second: under this, by the phone's own speed, it stands still
        const val CREEPING = 1.0 // metres a second: from this it's moving, if slowly, as in a queue
        const val WOBBLE_UP_TO = 50.0 // metres: how much of a fix's own accuracy counts, at most

        // Whether `here` is only GPS wandering around `spot`, not a move (Pieter, 8 November 2026: the car crept and jumped while
        // standing still). Within 15 m it never is, as on the server. Not moving by the phone's own speed, or when it doesn't say, the
        // fix's own accuracy counts too, up to 50 m, and the phone saying it stands still allows twice that around a spot no worse
        // than this fix. Faster than a walk is always a move, and a queue's creeping keeps to the 15 m. As in Navigation.swift.
        fun wobble(here: Location, spot: Location): Boolean {
            val v = here.speedOrNull
            if (v != null && v > REAL_SPEED) return false
            val d = here.distanceTo(spot).toDouble()
            if (v != null && v >= CREEPING) return d < REAL_MOVE
            val accuracy = if (here.hasAccuracy()) here.accuracy.toDouble() else 0.0
            val radius = max(REAL_MOVE, min(accuracy, WOBBLE_UP_TO))
            if (d < radius) return true
            val still = v != null && v < STANDING
            return still && spot.hasAccuracy() && spot.accuracy <= max(accuracy, REAL_MOVE) && d < 2 * radius
        }
    }

    fun moved(here: Location) {
        val c = if (here.hasBearing()) here.bearing.toDouble() else null
        val v = here.speedOrNull ?: 0.0
        val last = lastSpot
        val wobbling = stillSpot?.let { wobble(here, it) } ?: false
        if (c != null && v > REAL_SPEED) {
            course = c
            lastSpot = here
        } else if (last != null) {
            // Slowly, or when the phone doesn't say: from two spots, once they're far enough apart to mean something. Never from
            // wobbling, or a car standing still would turn on the spot.
            val accuracy = if (here.hasAccuracy()) here.accuracy.toDouble() else 0.0
            if (!wobbling && here.distanceTo(last) >= max(REAL_MOVE, accuracy)) {
                course = (bearingBetween(LatLng(last.latitude, last.longitude), LatLng(here.latitude, here.longitude)) + 360) % 360
                lastSpot = here
            }
        } else {
            lastSpot = here
        }
        val spot = stillSpot
        if (wobbling && spot != null) {
            // Parked at once when the phone says it stands still; otherwise after 4 seconds without a real move.
            val stopped = here.speedOrNull?.let { it < STANDING } ?: false
            if (parked == null && (stopped || here.time - spot.time >= 4000)) parked = LatLng(spot.latitude, spot.longitude)
        } else {
            stillSpot = here
            if (parked != null) parked = null
        }
        refresh()
    }

    fun mapTurned(bearing: Double) {
        if (kotlin.math.abs(bearing - mapHeading) <= 0.5) return
        mapHeading = bearing
        refresh()
    }

    private fun refresh() {
        val wanted = if (pinned) 0.0 else course - mapHeading
        val turn = (wanted - angle) % 360
        val shortest = if (turn > 180) turn - 360 else if (turn < -180) turn + 360 else turn
        if (kotlin.math.abs(shortest) > 0.5) angle += shortest.toFloat()
    }
}
