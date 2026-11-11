package eu.drivezzz.app.map

import android.annotation.SuppressLint
import android.graphics.PointF
import android.os.SystemClock
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.launch
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onPlaced
import kotlin.math.hypot
import kotlin.math.max
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.LatLng
import eu.drivezzz.app.core.LocationService
import eu.drivezzz.app.core.OnLocation
import eu.drivezzz.app.core.place
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapLibreMapOptions
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.layers.BackgroundLayer
import org.maplibre.android.style.layers.FillExtrusionLayer
import org.maplibre.android.style.layers.FillLayer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.layers.SymbolLayer
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.LineString
import org.maplibre.geojson.Point
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.roundToInt

// The map, behind this one seam: every screen says what's on it in the terms below, and only this file knows it's MapLibre with
// OpenFreeMap's tiles, which need no key and no account. To use Google Maps instead, this is the file to change: docs/android.md.
object MapConfig {
    // Calm, without shops and the like, so that a route and its pins stand out. Dark goes with the app's own dark mode.
    fun styleUrl(dark: Boolean) = if (dark) "https://tiles.openfreemap.org/styles/dark" else "https://tiles.openfreemap.org/styles/liberty"
}

data class MapLine(val points: List<LatLng>, val color: Color, val width: Float, val dash: List<Float>? = null)

enum class MapAnchor { Center, Bottom }

// Something on the map that's drawn by the app: a pin, a price, a car. It keeps to its spot on the map by itself.
// A tap or a hold on it goes through the map, never a gesture on the pin itself: a finger that lands on a pin to pan the map
// must still pan it, and lifting it there mustn't count as a tap.
// `glide`: a new spot is reached in a second rather than at once, for a car that moves (a driver's car, as the rider sees it).
data class MapAnnotation(
    val key: String,
    val at: LatLng,
    val anchor: MapAnchor = MapAnchor.Bottom,
    val onTap: (() -> Unit)? = null,
    val onHold: (() -> Unit)? = null,
    val glide: Boolean = false,
    val content: @Composable () -> Unit,
)

// A spot on the map that glides to where it goes next rather than jumping: a car between GPS fixes, or a driver's car between the
// positions the server passes on (Pieter, 8 November 2026). Read in placing only, so only the pin moves, frame by frame.
private class Glide(start: LatLng?) {
    private var from: LatLng? = start
    private var to: LatLng? = start
    private val t = Animatable(1f)

    val now: LatLng?
        get() {
            val a = from
            val b = to
            if (a == null || b == null) return b
            val f = t.value.toDouble()
            return LatLng(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f)
        }

    suspend fun go(next: LatLng?, ms: Int) {
        if (next == to) return
        if (next == null || to == null) {
            from = next
            to = next
            t.snapTo(1f)
            return
        }
        from = now
        to = next
        t.snapTo(0f)
        t.animateTo(1f, tween(ms, easing = LinearEasing))
    }
}

// The part of a pin a finger can tap, when it isn't all of it (a pin centred on its spot has room under it that's not the pin).
private val LocalTapArea = staticCompositionLocalOf<((LayoutCoordinates) -> Unit)?> { null }

@Composable
fun Modifier.mapTapArea(): Modifier {
    val report = LocalTapArea.current ?: return this
    return onPlaced(report)
}

// What a screen can ask of its map.
class MapController {
    internal var map: MapLibreMap? = null
    private var pending: ((MapLibreMap) -> Unit)? = null
    // Which way is up now, for what must not turn with the map.
    var bearing by mutableFloatStateOf(0f)
        internal set
    internal var tick by mutableIntStateOf(0)
    // Counts each time the map comes to rest: what takes working out waits for that.
    var rested by mutableIntStateOf(0)
        internal set
    private var viewWidthDp = 360f
    // What covers the map now, in pixels: fitting something on it keeps clear of that.
    internal var coverTop = 0
    internal var coverBottom = 0

    internal fun attach(map: MapLibreMap, widthDp: Float) {
        this.map = map
        viewWidthDp = widthDp
        pending?.invoke(map)
        pending = null
    }

    private fun act(block: (MapLibreMap) -> Unit) {
        val m = map
        if (m != null) block(m) else pending = block
    }

    // How many km across the map is now. Read it with `moved`, so that it's asked again when the map moves.
    val moved: Int get() = tick
    val widthKm: Double
        get() {
            val c = map?.cameraPosition ?: return 0.0
            val lat = c.target?.latitude ?: 0.0
            return 40075.016686 * cos(lat * PI / 180) / 2.0.pow(c.zoom) / 512 * viewWidthDp
        }

    fun toScreen(at: LatLng): PointF? = map?.projection?.toScreenLocation(org.maplibre.android.geometry.LatLng(at.lat, at.lng))

    private fun zoomFor(metres: Double, lat: Double): Double {
        val perDp = metres / viewWidthDp
        return ln(40075016.686 * cos(lat * PI / 180) / (512 * perDp)) / ln(2.0)
    }

    // Where the camera goes, in the part of the map a panel doesn't cover. Said every time: any camera move cancels the panel's own
    // easing to it, which left the middle of the map, your position and the drivers around you under the panel.
    private fun clearOfCover(at: LatLng, zoom: Double, bearing: Double = 0.0, tilt: Double = 0.0) = CameraUpdateFactory.newCameraPosition(
        CameraPosition.Builder()
            .target(org.maplibre.android.geometry.LatLng(at.lat, at.lng))
            .zoom(zoom)
            .bearing(bearing)
            .tilt(tilt)
            .padding(0.0, coverTop.toDouble(), 0.0, coverBottom.toDouble())
            .build(),
    )

    // A square of so many metres around a spot, as far as the width goes.
    fun centre(at: LatLng, metres: Double, animated: Boolean = true) = act { m ->
        val update = clearOfCover(at, zoomFor(metres, at.lat))
        if (animated) m.animateCamera(update, 500) else m.moveCamera(update)
    }

    // All of these points on screen, keeping clear of what covers the map. As on iOS (`regionFitting`), the box around them is made
    // 1.6 times as big, and at least 0.008 degrees, so the margin grows with the room there is. A fixed margin in pixels left a
    // small phone's strip of map above the panel almost nothing, and the map zoomed out to half the country.
    fun fit(points: List<LatLng>, animated: Boolean = true) = act { m ->
        if (points.isEmpty()) return@act
        val update = if (points.size == 1 || points.distinct().size == 1) {
            clearOfCover(points.first(), 14.5)
        } else {
            val midLat = (points.minOf { it.lat } + points.maxOf { it.lat }) / 2
            val midLng = (points.minOf { it.lng } + points.maxOf { it.lng }) / 2
            val halfLat = max(0.008, (points.maxOf { it.lat } - points.minOf { it.lat }) * 1.6) / 2
            val halfLng = max(0.008, (points.maxOf { it.lng } - points.minOf { it.lng }) * 1.6) / 2
            val bounds = LatLngBounds.from(midLat + halfLat, midLng + halfLng, midLat - halfLat, midLng - halfLng)
            val dp = android.content.res.Resources.getSystem().displayMetrics.density
            val edge = (8 * dp).roundToInt()
            // A pin stands above its spot: a little room for its head. The box is already 1.6 times the route, so no more than this,
            // or the route shrinks next to iOS.
            val head = (12 * dp).roundToInt()
            CameraUpdateFactory.newLatLngBounds(bounds, edge, coverTop + head, edge, coverBottom + edge)
        }
        if (animated) m.animateCamera(update, 500) else m.moveCamera(update)
    }

    // Behind the car while navigating: which way it's going is up, and it goes further out the faster you go.
    fun follow(at: LatLng, zoom: Double, bearing: Double, tilt: Double) = act { m ->
        m.animateCamera(clearOfCover(at, zoom, bearing, tilt), 1000)
    }

    fun north() = act { m ->
        m.animateCamera(CameraUpdateFactory.bearingTo(0.0), 300)
    }
}

@Composable
fun rememberMapController() = remember { MapController() }

// What a finger did on the map, as the map only says "a tap" after it lifted, and its idea of one is wide: anything under Android's
// touch slop, however long it took, also a touch that only stopped the map gliding. Moving the map must never pick a driver or a
// drop-off (Pieter, 6 November 2026), so a tap is a quick touch that stays put, on a map lying still. Not a tap for the map to act on
// otherwise: it's swallowed, not passed on.
internal class FingerWatch(private val stayWithinPx: Float) {
    private var downX = 0f
    private var downY = 0f
    private var downAt = 0L
    // It moved, a second finger came, or the map was still gliding when it landed. A hold only counts without this.
    var strayed = false
        private set
    private var tapped = false
    private var isDown = false

    fun heard(e: MotionEvent, mapGliding: Boolean) {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> down(e.x, e.y, e.eventTime, mapGliding)
            MotionEvent.ACTION_POINTER_DOWN -> secondFinger()
            MotionEvent.ACTION_CANCEL -> {
                strayed = true
                isDown = false
            }
            MotionEvent.ACTION_MOVE -> {
                for (i in 0 until e.historySize) moved(e.getHistoricalX(i), e.getHistoricalY(i))
                moved(e.x, e.y)
            }
            MotionEvent.ACTION_UP -> up(e.x, e.y, e.eventTime)
        }
    }

    fun down(x: Float, y: Float, at: Long, mapGliding: Boolean) {
        downX = x
        downY = y
        downAt = at
        strayed = mapGliding
        tapped = false
        isDown = true
    }

    fun secondFinger() {
        strayed = true
    }

    fun moved(x: Float, y: Float) {
        if (hypot(x - downX, y - downY) > stayWithinPx) strayed = true
    }

    fun up(x: Float, y: Float, at: Long) {
        moved(x, y)
        tapped = !strayed && at - downAt <= TAP_AT_MOST_MS
        isDown = false
    }

    val stillHolding: Boolean get() = isDown && !strayed

    fun untilHeld(now: Long): Long = maxOf(0L, downAt + HOLD_FOR_MS - now)

    // Once: the map asks a little after the finger lifted.
    fun takeTap(): Boolean = tapped.also { tapped = false }

    companion object {
        const val TAP_AT_MOST_MS = 350L
        const val HOLD_FOR_MS = 500L // as on iOS
        const val STAY_WITHIN_DP = 6f
        // A touch this soon after a finger's move, or its glide, is still part of moving the map.
        const val GLIDE_ENDS_AFTER_MS = 250L
    }
}

// The map as calm as Apple's: these colours are read off iOS's own Standard map, not chosen. Pale land, white streets, grey main
// roads and no yellow. OpenFreeMap's layers are named per style, so each style has its own list. Keep to these rather than to its
// defaults: docs/android.md, One look.
private class MapColours(
    val land: Int, val green: Int, val water: Int, val building: Int,
    val street: Int, val streetEdge: Int, val arterial: Int, val arterialEdge: Int, val main: Int, val mainEdge: Int,
    val label: Int, val halo: Int,
)

private val day = MapColours(
    land = 0xFFF8F8F0.toInt(), green = 0xFFB8E098.toInt(), water = 0xFF90D8F4.toInt(), building = 0xFFF0F0EC.toInt(),
    street = 0xFFFFFFFF.toInt(), streetEdge = 0xFFE0E3E6.toInt(),
    arterial = 0xFFE2E5E8.toInt(), arterialEdge = 0xFFD6DADE.toInt(),
    main = 0xFFA8B0B4.toInt(), mainEdge = 0xFF9AA2A6.toInt(),
    label = 0xFF4A5056.toInt(), halo = 0xFFFFFFFF.toInt(),
)

private val night = MapColours(
    land = 0xFF34485C.toInt(), green = 0xFF005C5C.toInt(), water = 0xFF1C3884.toInt(), building = 0xFF3C5064.toInt(),
    street = 0xFF4C5C70.toInt(), streetEdge = 0xFF445468.toInt(),
    arterial = 0xFF5C6C80.toInt(), arterialEdge = 0xFF546474.toInt(),
    main = 0xFF849CBC.toInt(), mainEdge = 0xFF738AA8.toInt(),
    label = 0xFFD5DEE8.toInt(), halo = 0xFF1E2A38.toInt(),
)

private fun calm(style: Style, c: MapColours) {
    fun isRail(id: String) = "rail" in id
    style.layers.forEach { layer ->
        val id = layer.id
        when (layer) {
            is BackgroundLayer -> layer.setProperties(PropertyFactory.backgroundColor(c.land))
            is FillLayer -> when {
                id == "water" -> layer.setProperties(PropertyFactory.fillColor(c.water))
                id == "building" -> layer.setProperties(PropertyFactory.fillColor(c.building))
                id == "park" || id == "landuse_park" || id.startsWith("landcover_wood") || id.startsWith("landcover_grass") ->
                    layer.setProperties(PropertyFactory.fillColor(c.green), PropertyFactory.fillOpacity(0.75f))
                id == "landuse_pitch" || id == "landuse_track" || id == "landuse_cemetery" ->
                    layer.setProperties(PropertyFactory.fillColor(c.green), PropertyFactory.fillOpacity(0.5f))
                id == "landuse_residential" || id == "landuse_hospital" || id == "landuse_school" || id == "landcover_sand" ->
                    layer.setProperties(PropertyFactory.fillColor(c.land))
            }
            is LineLayer -> when {
                id.startsWith("waterway") -> layer.setProperties(PropertyFactory.lineColor(c.water))
                id == "park_outline" -> layer.setProperties(PropertyFactory.lineColor(c.green))
                isRail(id) || id.startsWith("boundary") || id.startsWith("aeroway") -> {}
                !(id.startsWith("road_") || id.startsWith("bridge_") || id.startsWith("tunnel_") || id.startsWith("highway_")) -> {}
                "motorway" in id || "trunk" in id ->
                    layer.setProperties(PropertyFactory.lineColor(if ("casing" in id) c.mainEdge else c.main))
                "link" in id || "secondary" in id || "major" in id ->
                    layer.setProperties(PropertyFactory.lineColor(if ("casing" in id) c.arterialEdge else c.arterial))
                else -> layer.setProperties(PropertyFactory.lineColor(if ("casing" in id) c.streetEdge else c.street))
            }
            is SymbolLayer -> {
                // The city's name in big letters sits right where the pins go. Close in, iOS names neighbourhoods instead.
                if (id == "label_city" || id == "label_city_capital" || id == "place_city" || id == "place_city_large") layer.maxZoom = 10.5f
                if (id.startsWith("label_") || id.startsWith("place_") || id.startsWith("highway-name") || id.startsWith("highway_name")) {
                    layer.setProperties(PropertyFactory.textColor(c.label), PropertyFactory.textHaloColor(c.halo))
                }
            }
        }
    }
}

private fun lineFeature(points: List<LatLng>): Feature =
    Feature.fromGeometry(LineString.fromLngLats(points.map { Point.fromLngLat(it.lng, it.lat) }))

@SuppressLint("ClickableViewAccessibility")
@Composable
fun DzMap(
    modifier: Modifier = Modifier,
    controller: MapController = rememberMapController(),
    lines: List<MapLine> = emptyList(),
    annotations: List<MapAnnotation> = emptyList(),
    showUser: Boolean = false, // the blue dot of where you are
    user: (@Composable () -> Unit)? = null, // or something else there
    userParked: () -> LatLng? = { null }, // standing still: where it stays, whatever GPS wanders to (DriveHeading)
    gestures: Boolean = true,
    bottomCover: Dp = 0.dp, // keeps what matters clear of a panel over the bottom of the map
    topCover: Dp = 0.dp,
    onTap: ((LatLng) -> Unit)? = null,
    onHold: ((LatLng) -> Unit)? = null, // a long press on the map, not on a pin
    onUserMoved: (() -> Unit)? = null,
) {
    val context = LocalContext.current
    val density = LocalDensity.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val dark = AppState.isDark
    val currentTap by rememberUpdatedState(onTap)
    val currentHold by rememberUpdatedState(onHold)
    val currentMoved by rememberUpdatedState(onUserMoved)
    val currentAnnotations by rememberUpdatedState(annotations)
    // Where each pin is, to find the one under a tap or a hold. Live coordinates: they're only read when a finger asks.
    val frame = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val wholes = remember { HashMap<String, LayoutCoordinates>() }
    val areas = remember { HashMap<String, LayoutCoordinates>() }

    // The pin under a finger, the closest if there are more. At least 44 dp to aim at: a finger is wider than a little circle.
    fun pinAt(point: PointF, hold: Boolean): MapAnnotation? {
        val root = frame[0]?.takeIf { it.isAttached } ?: return null
        val least = 44 * density.density
        var best: MapAnnotation? = null
        var bestAway = Float.MAX_VALUE
        for (a in currentAnnotations) {
            if ((if (hold) a.onHold else a.onTap) == null) continue
            val c = areas[a.key]?.takeIf { it.isAttached } ?: wholes[a.key]?.takeIf { it.isAttached } ?: continue
            val r = root.localBoundingBoxOf(c, clipBounds = false)
            val padX = max(0f, (least - r.width) / 2)
            val padY = max(0f, (least - r.height) / 2)
            if (point.x < r.left - padX || point.x > r.right + padX || point.y < r.top - padY || point.y > r.bottom + padY) continue
            val away = hypot(point.x - r.center.x, point.y - r.center.y)
            if (away < bestAway) {
                best = a
                bestAway = away
            }
        }
        return best
    }
    var styleReady by remember { mutableStateOf(false) }
    var mapReady by remember { mutableStateOf<MapLibreMap?>(null) }
    var loadedDark by remember { mutableStateOf<Boolean?>(null) }

    val mapView = remember {
        MapLibre.getInstance(context)
        val options = MapLibreMapOptions.createFromAttributes(context)
            .textureMode(true)
            .logoEnabled(false)
            .compassEnabled(false)
            .attributionEnabled(true)
            .attributionTintColor(0xFF9AA0A6.toInt())
        val finger = FingerWatch(FingerWatch.STAY_WITHIN_DP * density.density)
        var byFinger = false
        var fingerMovedAt = 0L
        MapView(context, options).apply {
            onCreate(null)
            setOnTouchListener { v, e ->
                // Inside a page that scrolls, a finger on the map moves the map.
                v.parent?.requestDisallowInterceptTouchEvent(true)
                finger.heard(e, mapGliding = SystemClock.uptimeMillis() - fingerMovedAt < FingerWatch.GLIDE_ENDS_AFTER_MS)
                false
            }
            getMapAsync { map ->
                map.uiSettings.isAttributionEnabled = true
                map.addOnCameraMoveListener {
                    if (byFinger) fingerMovedAt = SystemClock.uptimeMillis()
                    controller.tick++
                    controller.bearing = map.cameraPosition.bearing.toFloat()
                }
                map.addOnCameraIdleListener {
                    byFinger = false
                    controller.tick++
                    controller.rested++
                }
                map.addOnCameraMoveStartedListener { reason ->
                    byFinger = reason == MapLibreMap.OnCameraMoveStartedListener.REASON_API_GESTURE
                    if (byFinger) {
                        fingerMovedAt = SystemClock.uptimeMillis()
                        currentMoved?.invoke()
                    }
                }
                map.addOnMapClickListener { point ->
                    if (!finger.takeTap()) return@addOnMapClickListener true
                    pinAt(map.projection.toScreenLocation(point), hold = false)?.let { pin ->
                        pin.onTap?.invoke()
                        return@addOnMapClickListener true
                    }
                    val tap = currentTap ?: return@addOnMapClickListener false
                    tap(LatLng(point.latitude, point.longitude))
                    true
                }
                map.addOnMapLongClickListener { point ->
                    if (finger.strayed) return@addOnMapLongClickListener true
                    val pin = pinAt(map.projection.toScreenLocation(point), hold = true)
                    val hold = currentHold
                    if (pin == null && hold == null) return@addOnMapLongClickListener false
                    // Android says "long" sooner than iOS does, and a finger resting before it moves the map must not move the pickup.
                    postDelayed({
                        if (finger.stillHolding) {
                            performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
                            if (pin != null) pin.onHold?.invoke() else hold?.invoke(LatLng(point.latitude, point.longitude))
                        }
                    }, finger.untilHeld(SystemClock.uptimeMillis()))
                    true
                }
                map.setOnMarkerClickListener { false }
                controller.attach(map, width / resources.displayMetrics.density)
                mapReady = map
            }
        }
    }

    // MapView wants to be told what the app is doing.
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> mapView.onStart()
                Lifecycle.Event.ON_RESUME -> mapView.onResume()
                Lifecycle.Event.ON_PAUSE -> mapView.onPause()
                Lifecycle.Event.ON_STOP -> mapView.onStop()
                else -> {}
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            mapView.onStop()
            mapView.onDestroy()
            controller.map = null
        }
    }

    // The style for this appearance, and what's calm about it.
    LaunchedEffect(mapReady, dark) {
        val map = mapReady ?: return@LaunchedEffect
        if (loadedDark == dark) return@LaunchedEffect
        styleReady = false
        loadedDark = dark
        map.setStyle(Style.Builder().fromUri(MapConfig.styleUrl(dark))) { style ->
            // Flat, and without shops and the like: raised buildings hide the route, as on iOS.
            style.layers.filter { it.id.startsWith("poi") || it.id.contains("poi_") || it is FillExtrusionLayer }.forEach { style.removeLayer(it) }
            calm(style, if (dark) night else day)
            styleReady = true
        }
    }

    // The route and whatever else is drawn on the map itself.
    LaunchedEffect(mapReady, styleReady, lines) {
        val map = mapReady ?: return@LaunchedEffect
        if (!styleReady) return@LaunchedEffect
        val style = map.style ?: return@LaunchedEffect
        style.layers.filter { it.id.startsWith("dz-") }.forEach { style.removeLayer(it) }
        style.sources.filter { it.id.startsWith("dz-") }.forEach { style.removeSource(it) }
        lines.forEachIndexed { i, line ->
            if (line.points.size < 2) return@forEachIndexed
            val source = GeoJsonSource("dz-source-$i", lineFeature(line.points))
            style.addSource(source)
            val layer = LineLayer("dz-line-$i", "dz-source-$i").withProperties(
                PropertyFactory.lineColor(line.color.toArgb()),
                PropertyFactory.lineWidth(line.width),
                PropertyFactory.lineCap(Property.LINE_CAP_ROUND),
                PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND),
            )
            line.dash?.let { layer.setProperties(PropertyFactory.lineDasharray(it.toTypedArray())) }
            style.addLayer(layer)
        }
    }

    // Keeps a route clear of the panel and the clock. Where the panel came to rest, once: not while it moves.
    LaunchedEffect(mapReady, bottomCover, topCover) {
        val map = mapReady ?: return@LaunchedEffect
        val bottom = with(density) { bottomCover.toPx() }.roundToInt()
        val top = with(density) { topCover.toPx() }.roundToInt()
        controller.coverTop = top
        controller.coverBottom = bottom
        map.easeCamera(CameraUpdateFactory.paddingTo(0.0, top.toDouble(), 0.0, bottom.toDouble()), 300)
        map.uiSettings.setAttributionMargins(with(density) { 8.dp.roundToPx() }, 0, 0, bottom + with(density) { 8.dp.roundToPx() })
    }

    LaunchedEffect(mapReady, gestures) {
        val map = mapReady ?: return@LaunchedEffect
        map.uiSettings.setAllGesturesEnabled(gestures)
    }

    Box(modifier.clipToBounds().onPlaced { frame[0] = it }) {
        AndroidView(factory = { mapView }, modifier = Modifier.fillMaxSize())
        if (user != null) UserMarker(controller, userParked, user) else if (showUser) UserMarker(controller, userParked) { UserDot() }
        annotations.forEach { a ->
            key(a.key) {
                val glide = remember { Glide(a.at) }
                if (a.glide) LaunchedEffect(a.at) { glide.go(a.at, 1000) }
                DisposableEffect(Unit) {
                    onDispose {
                        wholes.remove(a.key)
                        areas.remove(a.key)
                    }
                }
                Box(
                    Modifier.layout { measurable, constraints ->
                        val p = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
                        layout(p.width, p.height) {
                            controller.tick // In placing only: a moving map moves its pins without redoing anything.
                            val s = controller.toScreen(if (a.glide) glide.now ?: a.at else a.at)
                            if (s != null) {
                                val x = s.x.roundToInt() - p.width / 2
                                val y = s.y.roundToInt() - if (a.anchor == MapAnchor.Center) p.height / 2 else p.height
                                p.place(x, y)
                            }
                        }
                    // Where the pin was put, so after the placing above: before it, this was the map's top left corner, and a pin
                    // without a tap area of its own (an order's price) couldn't be tapped at all.
                    }.onPlaced { wholes[a.key] = it },
                ) {
                    CompositionLocalProvider(LocalTapArea provides { c -> areas[a.key] = c }) { a.content() }
                }
            }
        }
    }
}

// Where you are. A view of its own, as it moves with every GPS fix: the screen around it, with its map, isn't redone. Moving, it
// glides from fix to fix, as Apple's own does, rather than jumping a car's length every second; standing still it stays parked.
@Composable
private fun UserMarker(controller: MapController, parked: () -> LatLng?, content: @Composable () -> Unit) {
    val here = remember { Glide(LocationService.location?.place) }
    val scope = rememberCoroutineScope()
    OnLocation { scope.launch { here.go(it.place, 900) } }
    Box(
        Modifier.layout { measurable, constraints ->
            val p = measurable.measure(constraints.copy(minWidth = 0, minHeight = 0))
            layout(p.width, p.height) {
                controller.tick
                val s = (parked() ?: here.now)?.let { controller.toScreen(it) }
                if (s != null) p.place(s.x.roundToInt() - p.width / 2, s.y.roundToInt() - p.height / 2)
            }
        },
    ) { content() }
}

@Composable
private fun UserDot() {
    Box(
        Modifier
            .size(20.dp)
            .dropShadow(CircleShape, Shadow(radius = 4.dp, color = Color.Black.copy(alpha = 0.3f), offset = DpOffset(0.dp, 1.dp)))
            .background(Color.White, CircleShape)
            .padding(3.dp)
            .background(Color(0xFF2F7BFF), CircleShape),
    )
}
