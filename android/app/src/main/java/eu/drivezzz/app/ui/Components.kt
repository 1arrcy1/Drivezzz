package eu.drivezzz.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.snapping.rememberSnapFlingBehavior
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropUp
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.Car
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.Place
import eu.drivezzz.app.core.Ride
import eu.drivezzz.app.core.ServerClock
import eu.drivezzz.app.core.Vehicle
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

fun hexColor(value: Long): Color = Color(0xFF000000L or value)

fun colorOf(hex: String?): Color? {
    val text = hex?.trim('#') ?: return null
    return text.toLongOrNull(16)?.let { hexColor(it) }
}

@Composable
fun ErrorText(text: String?) {
    if (text != null) {
        Text(text, style = T.footnote.medium, color = Theme.danger, modifier = Modifier.fillMaxWidth())
    }
}

@Composable
fun ScreenTitle(title: String, subtitle: String? = null, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = T.size(30).bold.kern(-0.6f), color = Theme.ink)
        if (subtitle != null) Text(subtitle, style = T.subheadline, color = Theme.muted)
    }
}

@Composable
fun SectionLabel(text: String) {
    Text(text, style = T.subheadline.semibold, color = Theme.muted, modifier = Modifier.fillMaxWidth())
}

// An icon with its words, in your colour.
@Composable
fun LabelRow(icon: ImageVector, text: String, style: TextStyle = T.subheadline, color: Color = Theme.ink, iconTint: Color = color, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = iconTint, modifier = Modifier.size(with(LocalDensity.current) { (style.fontSize.value + 2).dp }))
        Text(text, style = style, color = color)
    }
}

// Left a word, right a value: what iOS calls LabeledContent.
@Composable
fun LabeledRow(label: String, value: String? = null, style: TextStyle = T.subheadline, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = style, color = Theme.ink, modifier = Modifier.weight(1f))
        Spacer(Modifier.width(8.dp))
        if (value != null) Text(value, style = style, color = Theme.muted, textAlign = TextAlign.End)
        trailing?.invoke()
    }
}

// The way a Dutch number plate looks.
@Composable
fun PlateView(plate: String, size: Dp = 20.dp) {
    val shape = RoundedCornerShape(size * 0.2f)
    Row(
        Modifier
            .height(size * 1.7f)
            .clip(shape)
            .background(Theme.plate)
            .border(1.dp, Color.Black.copy(alpha = 0.65f), shape)
            .semantics { contentDescription = "Number plate $plate" },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.width(size * 1.05f).fillMaxHeight().background(Theme.plateBand), contentAlignment = Alignment.Center) {
            Text("NL", color = Color.White, style = TextStyle(fontSize = (size.value * 0.5f).sp, fontWeight = FontWeight.Bold))
        }
        Text(
            plate,
            color = Color.Black,
            maxLines = 1,
            style = TextStyle(fontSize = size.value.sp, fontWeight = FontWeight.Bold).mono,
            modifier = Modifier.padding(horizontal = size * 0.45f),
        )
    }
}

// A small picture of a car, in its colour.
@Composable
fun CarTile(car: Car?, size: Dp = 44.dp) {
    val hex = car?.colorHex?.uppercase()
    var tint = Theme.ink
    if (hex != null && hex !in listOf("#F4F4F2", "#E8E0C8")) {
        val color = colorOf(hex)
        if (color != null) {
            // A black car on a dark tile wouldn't show.
            val brightness = 0.3f * color.red * 255 + 0.59f * color.green * 255 + 0.11f * color.blue * 255
            tint = if (AppState.isDark && brightness < 70) Theme.ink else color
        }
    }
    Box(
        Modifier.size(size).background(Theme.soft, RoundedCornerShape(size * 0.3f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Sym.vehicle(car?.kind), null, tint = tint, modifier = Modifier.size(size * 0.56f))
    }
}

@Composable
fun Stars(rating: Int, size: Dp = 13.dp) {
    Row(horizontalArrangement = Arrangement.spacedBy(1.dp)) {
        for (i in 1..5) {
            Icon(Sym.star, null, tint = if (i <= rating) Theme.route else Theme.line, modifier = Modifier.size(size))
        }
    }
}

@Composable
fun RatingLabel(rating: Double?, count: Int?) {
    Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Sym.star, null, tint = Theme.route, modifier = Modifier.size(12.dp))
        Text(Fmt.rating(rating, count), style = T.footnote.semibold, color = Theme.ink)
    }
}

@Composable
fun StatusPill(text: String, color: Color = Theme.accentInk, background: Color = Theme.accentSoft) {
    Row(
        Modifier.background(background, CircleShape).padding(horizontal = 9.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(6.dp).background(color, CircleShape))
        Text(text, style = T.caption.semibold, color = color, maxLines = 1)
    }
}

// The same colours everywhere, also in the admin panel: completed green, under way yellow, cancelled red.
@Composable
fun RideStatusPill(text: String, ride: Ride) {
    when (ride.status) {
        "completed" -> StatusPill(text, Theme.ok, Theme.okSoft)
        "cancelled" -> StatusPill(text, Theme.danger, Theme.dangerSoft)
        else -> StatusPill(text, Theme.ongoing, Theme.ongoingSoft)
    }
}

// Seconds left until a time on the server's clock, ticking.
@Composable
fun secondsUntil(until: Double): Int {
    val left by produceState(max(0L, ServerClock.secondsUntil(until)).toInt(), until) {
        while (true) {
            value = max(0L, ServerClock.secondsUntil(until)).toInt()
            delay(1000)
        }
    }
    return left
}

// The time now, every second: for what counts up.
@Composable
fun tickingNow(): Long {
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            value = System.currentTimeMillis()
            delay(1000)
        }
    }
    return now
}

// Time left, on the server's clock: minutes and seconds, red near the end.
@Composable
fun Countdown(until: Double, redBelow: Int = 60) {
    val left = secondsUntil(until)
    val red = left < redBelow
    Row(
        Modifier.background(if (red) Theme.dangerSoft else Theme.soft, CircleShape).padding(horizontal = 10.dp, vertical = 5.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Sym.timer, null, tint = if (red) Theme.danger else Theme.ink, modifier = Modifier.size(14.dp))
        Text(Fmt.clock(left), style = T.subheadline.semibold.digits, color = if (red) Theme.danger else Theme.ink)
    }
}

// The same time left, as a ring that runs out: for a choice that has to be made in time.
@Composable
fun CountdownRing(until: Double, total: Double = 300.0, size: Dp = 66.dp, redBelow: Int = 60) {
    val left = secondsUntil(until)
    val color = if (left < redBelow) Theme.danger else Theme.accent
    val line = Theme.line
    val share by animateFloatAsState(min(1f, (left / total).toFloat()), tween(1000, easing = LinearEasing), label = "ring")
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize().padding(3.dp)) {
            drawArc(line, 0f, 360f, false, style = Stroke(5.dp.toPx()))
            drawArc(color, -90f, 360f * share, false, style = Stroke(5.dp.toPx(), cap = StrokeCap.Round))
        }
        Text(Fmt.clock(left), style = TextStyle(fontSize = (size.value * 0.25f).sp, fontWeight = FontWeight.Bold).digits, color = if (left < redBelow) Theme.danger else Theme.ink)
    }
}

// Dashes that run along a line, at 30 frames a second: on screen for hours in a car, they shouldn't take the battery to 120.
@Composable
fun rememberDashPhase(seconds: Float): androidx.compose.runtime.State<Float> =
    produceState(0f, seconds) {
        while (true) {
            value = ((System.currentTimeMillis() % (seconds * 1000).toLong()) / (seconds * 1000)).toFloat()
            delay(33)
        }
    }

// How far along a ride is, on Drivezzz's own road, the one from the logo: a car drives along it while the dashes run.
@Composable
fun RideSteps(ride: Ride) {
    // Cash is paid in the car, so there's no step for it.
    val labels = if (ride.isCash) listOf("Driver", "Pickup", "Ride") else listOf("Driver", "Pay", "Pickup", "Ride")
    val reached = when (ride.status) {
        "searching", "offered", "open" -> 0
        "awaiting_payment" -> 1
        "accepted", "arrived", "scheduled" -> 2
        "riding" -> 3
        else -> 4
    }
    val step = if (ride.isCash && reached > 1) reached - 1 else reached
    // How far along the part that's under way: halfway, or while the driver comes and on the ride, as far as they've got, so the car on
    // the road moves with every position (Pieter, 8 November 2026). As RideSteps in Components.swift.
    fun share(left: Int?, all: Int?): Float? = if (left == null || all == null || all <= 0) null else (1f - left.toFloat() / all).coerceIn(0.1f, 0.9f)
    val along = when (ride.status) {
        "accepted" -> share(ride.driverToPickupM, ride.pickupM) ?: 0.5f
        "riding" -> share(ride.driverToDropoffM, ride.distanceM) ?: 0.5f
        else -> 0.5f
    }
    val progress = min(1f, (step + along) / labels.size)
    val phase by rememberDashPhase(0.8f)
    val road = Theme.road
    val accent = Theme.accent
    val night = Theme.night
    Column(Modifier.semantics { contentDescription = "Step ${min(step + 1, labels.size)} of ${labels.size}" }, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        BoxWithConstraints(Modifier.fillMaxWidth().height(26.dp)) {
            val full = maxWidth
            val at by animateDpAsState(min(full.value - 26, max(0f, full.value * progress - 13)).dp, spring(dampingRatio = 0.75f, stiffness = 180f), label = "car")
            val fill by animateDpAsState(max(16f, full.value * progress).dp, spring(dampingRatio = 0.75f, stiffness = 180f), label = "fill")
            Canvas(Modifier.fillMaxSize()) {
                val h = 16.dp.toPx()
                val y = (size.height - h) / 2
                drawRoundRect(road, Offset(0f, y), androidx.compose.ui.geometry.Size(size.width, h), CornerRadius(h / 2))
                drawRoundRect(accent, Offset(0f, y), androidx.compose.ui.geometry.Size(fill.toPx(), h), CornerRadius(h / 2))
                val dash = 5.dp.toPx()
                val gap = 6.dp.toPx()
                drawLine(
                    Color.White.copy(alpha = 0.65f), Offset(8.dp.toPx(), size.height / 2), Offset(size.width - 8.dp.toPx(), size.height / 2),
                    strokeWidth = 1.5.dp.toPx(), cap = StrokeCap.Round,
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, gap), -(dash + gap) * phase),
                )
            }
            Box(
                Modifier
                    .offset(x = at)
                    .size(26.dp)
                    .dropShadow(CircleShape, Shadow(radius = 3.dp, color = Color.Black.copy(alpha = 0.3f), offset = DpOffset(0.dp, 1.dp)))
                    .background(Color.White, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                Icon(Sym.vehicle(ride.driver?.car?.kind), null, tint = night, modifier = Modifier.size(14.dp))
            }
        }
        Row(Modifier.fillMaxWidth()) {
            labels.forEachIndexed { i, label ->
                Text(
                    label,
                    style = if (i == step) T.caption2.bold else T.caption2.medium,
                    color = if (i <= step) Theme.ink else Theme.faint,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

// A car on the map.
@Composable
fun CarPin(vehicle: String?, color: Color = Theme.accent) {
    Box(
        Modifier
            .size(36.dp)
            .dropShadow(CircleShape, Shadow(radius = 6.dp, color = Color.Black.copy(alpha = 0.26f), offset = DpOffset(0.dp, 3.dp)))
            .background(color, CircleShape)
            .border(2.5.dp, Color.White, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Sym.vehicle(vehicle), null, tint = Theme.onAccent, modifier = Modifier.size(18.dp))
    }
}

// A driver on the rider's map, with how long until they're at the pickup.
@Composable
fun DriverPin(vehicle: String?, eta: String?, plate: String? = null) {
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        if (eta != null) {
            Text(
                eta,
                style = T.caption2.bold,
                color = Color.White,
                modifier = Modifier.background(Theme.night, CircleShape).padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
        CarPin(vehicle)
        if (plate != null) Text(plate, style = T.caption2.bold, color = Theme.ink)
    }
}

// What a pin on the map shows of a driver: their price and stars while they fit, or only the circle.
// Hidden: far out, or it would land under someone's bubble. It shows when zooming in.
enum class PinStyle { Hidden, Circle, Label }

// A circle with the vehicle in it, with a short line up to a bubble with the price and the stars. Every driver sets their own price, so the map is the market.
@Composable
fun PricePin(
    vehicle: String?,
    text: String,
    rating: Double?,
    eta: String? = null,
    verified: Boolean = false,
    selected: Boolean = false,
    busy: Boolean = false,
    style: PinStyle = PinStyle.Label,
    modifier: Modifier = Modifier,
) {
    val shown = if (selected) PinStyle.Label else style
    val fill = if (selected) Theme.night else Theme.accent
    val ink = if (selected) Color.White else Theme.onAccent
    val circle = @Composable {
        Box(
            Modifier.size(26.dp).background(Theme.accent, CircleShape).border(2.dp, Theme.card, CircleShape),
            contentAlignment = Alignment.Center,
        ) { Icon(Sym.vehicle(vehicle), null, tint = Theme.onAccent, modifier = Modifier.size(15.dp)) }
    }
    when (shown) {
        PinStyle.Hidden -> Spacer(Modifier.size(1.dp))
        PinStyle.Circle -> Box(Modifier.graphicsLayer { alpha = if (busy) 0.6f else 1f }.then(modifier).size(30.dp), contentAlignment = Alignment.Center) { circle() }
        // A pin is centred on its spot: the same room below the circle keeps the circle there. It's outside what a finger can tap.
        PinStyle.Label -> Column(
            Modifier.padding(bottom = 32.dp).graphicsLayer { alpha = if (busy) 0.6f else 1f }.then(modifier),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Row(
                Modifier
                    .height(24.dp)
                    .dropShadow(CircleShape, Shadow(radius = 3.dp, color = Color.Black.copy(alpha = 0.22f), offset = DpOffset(0.dp, 1.dp)))
                    .background(fill, CircleShape)
                    .padding(horizontal = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text, style = T.size(12).bold.kern(-0.2f).digits, color = ink, maxLines = 1)
                if (rating != null) {
                    Icon(Sym.star, null, tint = ink, modifier = Modifier.size(9.dp))
                    Text(String.format(java.util.Locale.US, "%.1f", rating), style = T.size(11).semibold.digits, color = ink, maxLines = 1)
                } else {
                    Text("New", style = T.size(10).semibold, color = ink.copy(alpha = 0.85f), maxLines = 1)
                }
                if (selected && eta != null) Text(eta, style = T.size(10).semibold, color = ink.copy(alpha = 0.75f), maxLines = 1)
                if (verified) VerifiedMark(11.dp, rim = true)
            }
            Box(Modifier.size(width = 3.dp, height = 8.dp).background(fill))
            circle()
        }
    }
}

// The blue check of a verified driver, by itself, next to a name. On a coloured card it needs a white rim, or blue disappears on blue.
@Composable
fun VerifiedMark(size: Dp = 16.dp, rim: Boolean = false) {
    Box(Modifier.size(if (rim) size * 1.28f else size).semantics { contentDescription = "Verified driver" }, contentAlignment = Alignment.Center) {
        if (rim) Icon(Sym.seal, null, tint = Color.White, modifier = Modifier.size(size * 1.28f))
        // The check itself is a hole in the seal: white behind it.
        Box(Modifier.size(size * 0.5f).background(Color.White, CircleShape))
        Icon(Sym.seal, null, tint = Theme.verified, modifier = Modifier.size(size))
    }
}

// What riders see on a driver whose checks went through.
@Composable
fun VerifiedBadge() {
    Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "Verified driver" }, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        VerifiedMark(14.dp)
        Text("Verified", style = T.caption.semibold, color = Theme.verified)
    }
}

// Green: now. Yellow: booked for a time. `booked`: the driver's own ride, a check before the price, and a tap opens the ride.
@Composable
fun OrderPin(planned: Boolean, cents: Int?, modifier: Modifier = Modifier, booked: Boolean = false) {
    val ink = if (planned) Theme.night else Color.White
    Row(
        modifier
            .dropShadow(CircleShape, Shadow(radius = 6.dp, color = Color.Black.copy(alpha = 0.26f), offset = DpOffset(0.dp, 3.dp)))
            .background(if (planned) Theme.planned else Theme.now, CircleShape)
            .border(2.dp, Color.White, CircleShape)
            .padding(horizontal = 10.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (booked) Icon(Sym.check, null, tint = ink, modifier = Modifier.size(12.dp))
        Text(Fmt.eur(cents), style = T.caption.bold, color = ink)
    }
}

// Pickup and drop-off: Android's take on Apple's Marker, a round pin with an icon and its name under it.
@Composable
fun PlaceMarker(icon: ImageVector, color: Color, label: String?) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier
                .size(32.dp)
                .dropShadow(CircleShape, Shadow(radius = 5.dp, color = Color.Black.copy(alpha = 0.3f), offset = DpOffset(0.dp, 2.dp)))
                .background(color, CircleShape)
                .border(2.dp, Color.White, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, null, tint = if (color == Theme.accent) Theme.onAccent else Color.White, modifier = Modifier.size(17.dp))
        }
        Canvas(Modifier.size(width = 10.dp, height = 6.dp)) {
            val path = Path().apply {
                moveTo(0f, 0f)
                lineTo(size.width, 0f)
                lineTo(size.width / 2, size.height)
                close()
            }
            drawPath(path, color)
        }
        if (label != null) Text(label, style = T.caption2.bold, color = Theme.ink, modifier = Modifier.padding(top = 1.dp))
    }
}

// Rings going out from a spot: looking for a driver, or a driver who's online.
@Composable
fun Radar(color: Color = Theme.accent, size: Dp = 170.dp) {
    val transition = rememberInfiniteTransition(label = "radar")
    val rings = (0 until 3).map { i ->
        transition.animateFloat(
            initialValue = 0.08f, targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(2700, easing = androidx.compose.animation.core.FastOutSlowInEasing), RepeatMode.Restart, StartOffset(i * 900)),
            label = "ring$i",
        )
    }
    Canvas(Modifier.size(size)) {
        for (ring in rings) {
            val r = this.size.minDimension / 2 * ring.value
            val a = 1f - (ring.value - 0.08f) / 0.92f
            drawCircle(color.copy(alpha = 0.14f * a), r)
            drawCircle(color.copy(alpha = 0.75f * a), r, style = Stroke(1.5.dp.toPx()))
        }
    }
}

// A coin's round badge in its own colours, like a wallet app shows it.
@Composable
fun CoinBadge(coin: String?, size: Dp = 40.dp) {
    val (glyph, colors, ink) = when (coin) {
        "sol" -> Triple("◎", listOf(hexColor(0x9945FF), hexColor(0x14F195)), Color.White)
        "usdc-sol" -> Triple("$", listOf(hexColor(0x2775CA), hexColor(0x1C5BA3)), Color.White)
        "cash" -> Triple("€", listOf(hexColor(0x2E9E6B), hexColor(0x1F7A52)), Color.White)
        "xrp" -> Triple("✕", listOf(hexColor(0x23292F), hexColor(0x3A434D)), Color.White)
        "ltc" -> Triple("Ł", listOf(hexColor(0x345D9D), hexColor(0x6A8FCB)), Color.White)
        "xlm" -> Triple("✦", listOf(hexColor(0x0F0F0F), hexColor(0x3D3D3D)), Color.White)
        else -> Triple("¤", listOf(Theme.accent, Theme.accentInk), Theme.onAccent)
    }
    Box(Modifier.size(size), contentAlignment = Alignment.Center) {
        Box(
            Modifier.fillMaxSize().background(Brush.linearGradient(colors), CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            Text(glyph, color = ink, style = TextStyle(fontSize = (size.value * 0.46f).sp, fontWeight = FontWeight.ExtraBold))
        }
        // USDC lives on Solana: a small Solana mark says where.
        if (coin == "usdc-sol") {
            Box(
                Modifier
                    .align(Alignment.BottomEnd)
                    .offset(x = 2.dp, y = 2.dp)
                    .size(size * 0.38f)
                    .background(Brush.linearGradient(listOf(hexColor(0x9945FF), hexColor(0x14F195))), CircleShape)
                    .border(1.5.dp, Color.White, CircleShape),
            )
        }
    }
}

// The moment a payment lands: the coin drops in and the escrow locks. This is what no other ride app has, so it gets its moment.
@Composable
fun EscrowMoment(price: String, coin: String?, done: () -> Unit) {
    val drop = remember { Animatable(-260f) }
    val locked = remember { Animatable(0f) }
    val haptics = LocalHapticFeedback.current
    LaunchedEffect(Unit) {
        launch { drop.animateTo(0f, spring(dampingRatio = 0.6f, stiffness = 130f)) }
        delay(650)
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        launch { locked.animateTo(1f, spring(dampingRatio = 0.72f, stiffness = 110f)) }
        delay(2300)
        done()
    }
    val accent = Theme.accent
    Box(Modifier.fillMaxSize().background(Theme.night).clickable(onClick = done), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(26.dp)) {
            Box(Modifier.size(150.dp), contentAlignment = Alignment.Center) {
                Canvas(Modifier.fillMaxSize().padding(5.dp)) {
                    drawCircle(Color.White.copy(alpha = 0.13f), style = Stroke(9.dp.toPx()))
                    drawArc(accent, -90f, 360f * locked.value, false, style = Stroke(9.dp.toPx(), cap = StrokeCap.Round))
                }
                Box(
                    Modifier.graphicsLayer {
                        translationY = drop.value * density
                        val s = 1f - locked.value * 0.8f
                        scaleX = s
                        scaleY = s
                        alpha = 1f - locked.value.coerceIn(0f, 1f)
                    },
                ) { CoinBadge(coin, 72.dp) }
                Icon(
                    Sym.lock, null, tint = Color.White,
                    modifier = Modifier.size(54.dp).graphicsLayer {
                        val s = 0.2f + locked.value * 0.8f
                        scaleX = s
                        scaleY = s
                        alpha = locked.value.coerceIn(0f, 1f)
                    },
                )
            }
            Column(
                Modifier.padding(horizontal = 34.dp).graphicsLayer {
                    alpha = locked.value.coerceIn(0f, 1f)
                    translationY = (1f - locked.value) * 12 * density
                },
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text("Locked in escrow", style = T.size(30).bold.kern(-0.6f), color = Color.White)
                Text("$price waits safely on Solana until your ride is done.", style = T.subheadline, color = Color.White.copy(alpha = 0.72f), textAlign = TextAlign.Center)
            }
        }
    }
}

// Shows that moment over a screen when a ride goes from waiting for payment to paid.
@Composable
fun EscrowMomentOver(status: String?, price: String, coin: String?) {
    var showing by remember { mutableStateOf(false) }
    var before by remember { mutableStateOf(status) }
    LaunchedEffect(status) {
        if (before == "awaiting_payment" && status in listOf("accepted", "arrived", "riding", "scheduled")) showing = true
        before = status
    }
    if (showing) {
        FullScreen(onDismiss = { showing = false }) {
            EscrowMoment(price, coin) { showing = false }
        }
    }
}

// Naming your price: a ruler you slide under a needle, ticking as it goes, with the cheapest driver's price marked on it.
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun PriceRuler(cents: Int, cheapest: Int?, onChange: (Int) -> Unit) {
    val step = 50
    val low = 100
    val high = 30_000
    val tickWidth = 16.dp
    val count = (high - low) / step
    fun index(value: Int) = ((value - low + step / 2) / step).coerceIn(0, count)
    val cheapestIndex = cheapest?.let { index(it) }
    val state = rememberLazyListState(initialFirstVisibleItemIndex = index(cents))
    val haptics = LocalHapticFeedback.current
    val density = LocalDensity.current
    val tickPx = with(density) { tickWidth.toPx() }

    // While a finger moves it, it says what the price is; otherwise the buttons do, and it follows.
    LaunchedEffect(state) {
        snapshotFlow { state.firstVisibleItemIndex + if (state.firstVisibleItemScrollOffset > tickPx / 2) 1 else 0 }
            .distinctUntilChanged()
            .collect { i ->
                if (state.isScrollInProgress) {
                    haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                    onChange(low + i.coerceIn(0, count) * step)
                }
            }
    }
    LaunchedEffect(cents) {
        val current = state.firstVisibleItemIndex + if (state.firstVisibleItemScrollOffset > tickPx / 2) 1 else 0
        if (!state.isScrollInProgress && current != index(cents)) state.animateScrollToItem(index(cents))
    }

    BoxWithConstraints(Modifier.fillMaxWidth().height(58.dp)) {
        val side = (maxWidth - tickWidth) / 2
        LazyRow(
            state = state,
            flingBehavior = rememberSnapFlingBehavior(state),
            contentPadding = PaddingValues(horizontal = side),
            modifier = Modifier
                .fillMaxSize()
                .graphicsLayer(compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen)
                .fadeSides(),
        ) {
            items(count + 1) { i ->
                val value = low + i * step
                val major = value % 500 == 0
                Column(Modifier.width(tickWidth).height(56.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Box(
                        Modifier
                            .width(if (i == cheapestIndex) 3.dp else 2.dp)
                            .height(if (major || i == cheapestIndex) 30.dp else 16.dp)
                            .background(if (i == cheapestIndex) Theme.ok else Theme.ink.copy(alpha = if (major) 0.85f else 0.22f), CircleShape),
                    )
                    if (major) {
                        Text("€${value / 100}", style = T.caption2.semibold, color = Theme.muted, maxLines = 1, softWrap = false, modifier = Modifier.wrapContentWidth(unbounded = true))
                    }
                }
            }
        }
        Box(Modifier.align(Alignment.TopCenter).offset(y = (-4).dp).size(width = 4.dp, height = 38.dp).background(Theme.accent, CircleShape))
    }
}

// What slides under something fades away at the ends.
private fun Modifier.fadeSides(): Modifier = this.then(Modifier.drawWithContentFade())

private fun Modifier.drawWithContentFade(): Modifier = this.drawWithContent {
    drawContent()
    drawRect(
        Brush.horizontalGradient(
            0f to Color.Transparent, 0.16f to Color.Black, 0.84f to Color.Black, 1f to Color.Transparent,
        ),
        blendMode = androidx.compose.ui.graphics.BlendMode.DstIn,
    )
}

// A QR code for a wallet to scan. Always on white: a wallet can't scan it on a dark page.
@Composable
fun QRCode(text: String, size: Dp = 180.dp) {
    val image = remember(text) { qrBitmap(text) }
    if (image != null) {
        Box(Modifier.background(Color.White, RoundedCornerShape(14.dp)).padding(12.dp)) {
            Image(image, "QR code", Modifier.size(size), contentScale = ContentScale.FillBounds, filterQuality = FilterQuality.None)
        }
    }
}

private fun qrBitmap(text: String): ImageBitmap? = runCatching {
    val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, mapOf(com.google.zxing.EncodeHintType.MARGIN to 0))
    val pixels = IntArray(matrix.width * matrix.height) { i ->
        if (matrix.get(i % matrix.width, i / matrix.width)) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    }
    android.graphics.Bitmap.createBitmap(pixels, matrix.width, matrix.height, android.graphics.Bitmap.Config.RGB_565).asImageBitmap()
}.getOrNull()

fun openUrl(context: Context, url: String, pkg: String? = null): Boolean = try {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    if (pkg != null) intent.setPackage(pkg)
    context.startActivity(intent)
    true
} catch (_: ActivityNotFoundException) {
    false
}

fun openSettings(context: Context) {
    context.startActivity(
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
}

fun openInMaps(context: Context, place: Place, name: String) {
    openUrl(context, "geo:${place.lat},${place.lng}?q=${place.lat},${place.lng}(${Uri.encode(name)})")
}

// Going online or offline takes a slide, so a bump in the car can't do it by accident.
@Composable
fun SlideControl(title: String, fill: Color, ink: Color, working: Boolean = false, action: () -> Unit) {
    val knob = 50.dp
    val density = LocalDensity.current
    val knobPx = with(density) { knob.toPx() }
    val moved = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val phase by rememberDashPhase(0.9f)
    val night = Theme.night
    BoxWithConstraints(
        Modifier
            .fillMaxWidth()
            .height(58.dp)
            .lifted(1f, 29.dp)
            .semantics {
                contentDescription = title
                onClick { if (!working) action(); true }
            },
    ) {
        val room = max(1f, constraints.maxWidth - knobPx - with(density) { 8.dp.toPx() })
        val shown = 1f - min(1f, moved.value / room * 1.5f)
        Box(
            Modifier
                .fillMaxSize()
                .background(fill, CircleShape)
                .pointerInput(working, room) {
                    detectHorizontalDragGestures(
                        onDragEnd = {
                            val far = moved.value >= room * 0.85f
                            scope.launch { moved.animateTo(0f, spring(dampingRatio = 0.8f, stiffness = 500f)) }
                            if (far && !working) {
                                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                                action()
                            }
                        },
                        onDragCancel = { scope.launch { moved.animateTo(0f) } },
                    ) { change, drag ->
                        change.consume()
                        if (!working) scope.launch { moved.snapTo((moved.value + drag).coerceIn(0f, room)) }
                    }
                },
        ) {
            Canvas(Modifier.fillMaxSize().graphicsLayer(alpha = shown, compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen)) {
                val dash = 8.dp.toPx()
                val gap = 9.dp.toPx()
                drawLine(
                    ink.copy(alpha = 0.28f), Offset(knobPx, size.height / 2), Offset(size.width - 22.dp.toPx(), size.height / 2),
                    strokeWidth = 2.dp.toPx(), cap = StrokeCap.Round,
                    pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, gap), -(dash + gap) * phase),
                )
                drawRect(
                    Brush.horizontalGradient(0f to Color.Black, 0.28f to Color.Transparent, 0.72f to Color.Transparent, 1f to Color.Black),
                    blendMode = androidx.compose.ui.graphics.BlendMode.DstIn,
                )
            }
            Text(
                title,
                style = T.size(17).semibold.kern(-0.2f),
                color = ink.copy(alpha = shown),
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center).padding(start = knob * 0.7f),
            )
            Box(
                Modifier
                    .offset { IntOffset((with(density) { 4.dp.toPx() } + moved.value).roundToInt(), with(density) { 4.dp.toPx() }.roundToInt()) }
                    .size(knob)
                    .dropShadow(CircleShape, Shadow(radius = 3.dp, color = Color.Black.copy(alpha = 0.2f), offset = DpOffset(0.dp, 1.dp)))
                    .background(Color.White, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (working) Spinner(night) else Icon(Sym.car, null, tint = night, modifier = Modifier.size(24.dp))
            }
        }
    }
}

// What cancelling costs, said before ordering.
@Composable
fun CancelTerms(planned: Boolean) {
    Row(
        Modifier.fillMaxWidth().background(Theme.soft, RoundedCornerShape(14.dp)).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Sym.info, null, tint = Theme.faint, modifier = Modifier.size(18.dp))
        Text(
            if (planned) "Ordering is free. You pay once a driver takes it, at least 30 minutes before. Free to cancel until 3 hours before; later you get 50% back and the driver 50%. If the driver cancels, you get everything back."
            else "Ordering is free. A driver has 5 minutes to accept, then you have 5 minutes to pay. Cancelling before you pay is free. Once you’ve paid: 50% back, or everything if the driver is late or cancels.",
            style = T.caption,
            color = Theme.muted,
        )
    }
}

// A small rounded square with a coloured symbol, at the start of a menu row.
@Composable
fun IconTile(symbol: ImageVector, tint: Color = Theme.accentInk, background: Color = Theme.accentSoft) {
    Box(Modifier.size(36.dp).background(background, RoundedCornerShape(11.dp)), contentAlignment = Alignment.Center) {
        Icon(symbol, null, tint = tint, modifier = Modifier.size(20.dp))
    }
}

// A row in a card: icon, title, what's on the right, a chevron when it opens something.
@Composable
fun CardRow(
    symbol: ImageVector,
    title: String,
    subtitle: String? = null,
    tint: Color = Theme.accentInk,
    background: Color = Theme.accentSoft,
    chevron: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconTile(symbol, tint, background)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(title, style = T.callout.medium, color = if (tint == Theme.danger) Theme.danger else Theme.ink)
            if (subtitle != null) Text(subtitle, style = T.caption, color = Theme.faint, maxLines = 2)
        }
        trailing?.invoke()
        if (chevron) Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(20.dp))
    }
}

// The line between two rows of a card.
@Composable
fun CardDivider(start: Dp = 62.dp) {
    Box(Modifier.fillMaxWidth().padding(start = start).height(0.5.dp).background(Theme.line))
}

@Composable
fun Hairline(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(0.5.dp).background(Theme.line))
}

// A white card under a small title; put a CardDivider between its rows.
@Composable
fun CardGroup(title: String? = null, footer: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (title != null) Text(title, style = T.title3.bold.kern(-0.3f), color = Theme.ink, modifier = Modifier.padding(horizontal = 4.dp))
        Column(Modifier.fillMaxWidth().lifted(0.45f, 22.dp).clip(RoundedCornerShape(22.dp)).background(Theme.card), content = content)
        if (footer != null) Text(footer, style = T.footnote, color = Theme.faint, modifier = Modifier.padding(horizontal = 4.dp))
    }
}

// The big coloured card at the top of a screen, in your colour.
@Composable
fun HeroCard(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(28.dp)
    Column(
        Modifier.fillMaxWidth().lifted(0.7f, 28.dp).clip(shape).background(Theme.accent).padding(20.dp),
    ) {
        androidx.compose.runtime.CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides Theme.onAccent) { content() }
    }
}

// A short explanation in a tinted box.
@Composable
fun NoteBox(symbol: ImageVector, tint: Color, background: Color, text: String, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().background(background, RoundedCornerShape(Theme.radius)).padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(symbol, null, tint = tint, modifier = Modifier.size(20.dp))
        Text(text, style = T.footnote, color = Theme.ink)
    }
}

// A round button floating over a map.
@Composable
fun MapRoundButton(symbol: ImageVector, label: String, onClick: () -> Unit) {
    Box(
        Modifier.size(48.dp).lifted(1f, 24.dp).clip(CircleShape).background(Theme.card).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(symbol, label, tint = Theme.ink, modifier = Modifier.size(22.dp))
    }
}

// Which way is north, on a map that's turned. Not there when it isn't.
@Composable
fun MapCompass(controller: eu.drivezzz.app.map.MapController, modifier: Modifier = Modifier) {
    val bearing = controller.bearing
    if (kotlin.math.abs(bearing) > 1f && kotlin.math.abs(bearing) < 359f) {
        Box(
            modifier.size(44.dp).lifted(0.8f, 22.dp).clip(CircleShape).background(Theme.card).clickable { controller.north() },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Sym.navigation, "Point north", tint = Theme.danger, modifier = Modifier.size(22.dp).graphicsLayer { rotationZ = -bearing })
        }
    }
}

// Now or later, as two big buttons: the first choice of a ride.
@Composable
fun WhenSwitch(planned: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth().background(Theme.soft, CircleShape).padding(3.dp)) {
        WhenOption(!planned, "Now", Sym.bolt) { if (planned) onChange(false) }
        WhenOption(planned, "Plan a ride", Sym.calendar) { if (!planned) onChange(true) }
    }
}

@Composable
private fun RowScope.WhenOption(on: Boolean, title: String, symbol: ImageVector, onClick: () -> Unit) {
    Row(
        Modifier
            .weight(1f)
            .heightIn(min = 40.dp)
            .then(if (on) Modifier.lifted(0.5f, 20.dp).background(Theme.raised, CircleShape) else Modifier)
            .clip(CircleShape)
            .clickable(onClick = onClick),
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(symbol, null, tint = if (on) Theme.accentInk else Theme.muted, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(7.dp))
        Text(title, style = T.subheadline.semibold, color = if (on) Theme.ink else Theme.muted)
    }
}

// A choice of a few, in your colour.
@Composable
fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth().background(Theme.track, RoundedCornerShape(10.dp)).padding(2.dp)) {
        options.forEachIndexed { i, text ->
            val on = i == selected
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 34.dp)
                    .background(if (on) Theme.accent else Color.Transparent, RoundedCornerShape(8.dp))
                    .clip(RoundedCornerShape(8.dp))
                    .clickable { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) {
                Text(text, style = T.footnote.semibold, color = if (on) Theme.onAccent else Theme.ink, maxLines = 1)
            }
        }
    }
}

// − value +
@Composable
fun Stepper(label: String, value: Int, range: IntRange, onChange: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = T.subheadline, color = Theme.ink, modifier = Modifier.weight(1f))
        Row(Modifier.background(Theme.soft, RoundedCornerShape(10.dp))) {
            Box(Modifier.size(width = 46.dp, height = 34.dp).clickable(enabled = value > range.first) { onChange(value - 1) }, contentAlignment = Alignment.Center) {
                Icon(Sym.minus, "Less", tint = if (value > range.first) Theme.ink else Theme.faint, modifier = Modifier.size(18.dp))
            }
            Box(Modifier.size(width = 46.dp, height = 34.dp).clickable(enabled = value < range.last) { onChange(value + 1) }, contentAlignment = Alignment.Center) {
                Icon(Sym.plus, "More", tint = if (value < range.last) Theme.ink else Theme.faint, modifier = Modifier.size(18.dp))
            }
        }
    }
}

// A field to type in, in a quiet fill. Nothing rewrites what's typed in a password.
@Composable
fun DzField(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    style: TextStyle = T.callout,
    minLines: Int = 1,
    maxLines: Int = if (minLines > 1) 8 else 1,
    keyboard: KeyboardOptions = KeyboardOptions.Default,
    password: Boolean = false,
    filled: Boolean = true,
    enabled: Boolean = true,
    keyboardActions: androidx.compose.foundation.text.KeyboardActions = androidx.compose.foundation.text.KeyboardActions.Default,
) {
    BasicTextField(
        value = value,
        onValueChange = onChange,
        modifier = modifier.fillMaxWidth(),
        textStyle = style.copy(color = Theme.ink),
        cursorBrush = SolidColor(Theme.accentInk),
        minLines = minLines,
        maxLines = maxLines,
        singleLine = maxLines == 1,
        enabled = enabled,
        keyboardOptions = if (password) keyboard.copy(keyboardType = KeyboardType.Password, autoCorrectEnabled = false) else keyboard,
        keyboardActions = keyboardActions,
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
        decorationBox = { inner ->
            Box(
                if (filled) Modifier.fillMaxWidth().background(Theme.soft, RoundedCornerShape(Theme.buttonRadius)).padding(16.dp) else Modifier.fillMaxWidth(),
            ) {
                if (value.isEmpty()) Text(placeholder, style = style, color = Theme.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                inner()
            }
        },
    )
}

// A small menu that opens from something: as iOS's `Menu`.
@Composable
fun MenuFrom(anchor: @Composable (open: () -> Unit) -> Unit, content: @Composable MenuScope.() -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        anchor { open = true }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = Theme.card, shape = RoundedCornerShape(14.dp)) {
            MenuScope { open = false }.content()
        }
    }
}

class MenuScope(val close: () -> Unit) {
    @Composable
    fun Item(text: String, icon: ImageVector? = null, destructive: Boolean = false, onClick: () -> Unit) {
        DropdownMenuItem(
            text = { Text(text, style = T.callout, color = if (destructive) Theme.danger else Theme.ink) },
            // On the right, as on iOS.
            trailingIcon = if (icon != null) ({ Icon(icon, null, tint = if (destructive) Theme.danger else Theme.accentInk, modifier = Modifier.size(20.dp)) }) else null,
            onClick = {
                close()
                onClick()
            },
        )
    }
}

// How much a section of a page looks like iOS's grouped list.
@Composable
fun ListSection(title: String? = null, footer: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (title != null) Text(title, style = T.footnote.semibold, color = Theme.muted, modifier = Modifier.padding(horizontal = 16.dp))
        Column(
            Modifier.fillMaxWidth().background(Theme.card, RoundedCornerShape(14.dp)).clip(RoundedCornerShape(14.dp)),
            content = content,
        )
        if (footer != null) Text(footer, style = T.footnote, color = Theme.faint, modifier = Modifier.padding(horizontal = 16.dp))
    }
}

@Composable
fun ListRow(modifier: Modifier = Modifier, onClick: (() -> Unit)? = null, content: @Composable () -> Unit) {
    Box(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 11.dp),
    ) { content() }
}

// The mark: a road shaped like a Z, with a dashed middle line. In a 1000 x 1000 box, like design/make-icon.swift.
private fun zPath(side: Float, dx: Float = 0f, dy: Float = 0f): Path {
    val s = side / 1000
    return Path().apply {
        moveTo(dx + 270 * s, dy + 290 * s)
        lineTo(dx + 730 * s, dy + 290 * s)
        lineTo(dx + 270 * s, dy + 710 * s)
        lineTo(dx + 730 * s, dy + 710 * s)
    }
}

fun DrawScope.drawZRoad(color: Color, width: Float) {
    val side = min(size.width, size.height)
    drawPath(
        zPath(side, (size.width - side) / 2, (size.height - side) / 2),
        color,
        style = Stroke(width, cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
}

fun DrawScope.drawZDashes(color: Color, width: Float, dash: Float, gap: Float, phase: Float) {
    val side = min(size.width, size.height)
    drawPath(
        zPath(side, (size.width - side) / 2, (size.height - side) / 2),
        color,
        style = Stroke(width, cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, gap), phase)),
    )
}

@Composable
fun MarkTile(size: Dp = 34.dp) {
    val on = Theme.onAccent
    val dash = Theme.roadDash
    Box(Modifier.size(size).clip(RoundedCornerShape(size * 0.22f)).background(Theme.gradient)) {
        Canvas(Modifier.fillMaxSize()) {
            val s = this.size.minDimension
            drawZRoad(on, s * 0.15f)
            drawZDashes(dash, s * 0.016f, s * 0.046f, s * 0.052f, 0f)
        }
    }
}

// A single stat in a tile, with a word under it.
@Composable
fun RowScope.StatTile(value: String, label: String, style: TextStyle = T.headline.digits, radius: Dp = 14.dp) {
    Column(
        Modifier.weight(1f).background(Theme.soft, RoundedCornerShape(radius)).padding(vertical = 10.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Text(value, style = style, color = Theme.ink, maxLines = 1)
        Text(label, style = T.caption, color = Theme.faint, maxLines = 1)
    }
}

@Composable
fun RowScope.FactTile(symbol: ImageVector, title: String, note: String) {
    Column(
        Modifier.weight(1f).lifted(0.45f, 22.dp).background(Theme.card, RoundedCornerShape(22.dp)).padding(vertical = 14.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(symbol, null, tint = Theme.accentInk, modifier = Modifier.size(24.dp))
        Text(title, style = T.subheadline.bold, color = Theme.ink, maxLines = 1)
        Text(note, style = T.caption, color = Theme.faint, maxLines = 1)
    }
}

@Composable
fun RowScope.PriceColumn(price: String, unit: String) {
    Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(price, style = T.title3.bold.digits, color = Theme.accentInk, maxLines = 1)
        Text(unit, style = T.caption, color = Theme.faint, maxLines = 1)
    }
}

@Composable
fun VerticalHairline() {
    Box(Modifier.width(0.5.dp).height(40.dp).background(Theme.line))
}

// From and to, joined by a line, like a route.
@Composable
fun RouteStops(from: String?, to: String?) {
    val ink = Theme.ink
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.padding(top = 3.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Canvas(Modifier.size(12.dp)) { drawCircle(ink, this.size.minDimension / 2 - 1.75.dp.toPx(), style = Stroke(3.5.dp.toPx())) }
            Box(Modifier.size(width = 2.dp, height = 22.dp).background(ink.copy(alpha = 0.18f)))
            Box(Modifier.size(12.dp).background(ink, RoundedCornerShape(2.5.dp)))
        }
        Column(verticalArrangement = Arrangement.spacedBy(15.dp)) {
            Text(from ?: "Pickup", style = T.subheadline.semibold, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(to ?: "Drop-off", style = T.subheadline.semibold, color = ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// Your own vehicle on the map, seen from above and pointing where you're going (DriveHeading). Turning is read only in drawing, so a
// new heading doesn't redo anything else.
@Composable
fun OwnVehicle(kind: String?, heading: eu.drivezzz.app.features.DriveHeading) {
    val accent = Theme.accent
    val night = Theme.night
    val turn = remember { Animatable(heading.angle) }
    LaunchedEffect(heading) {
        snapshotFlow { heading.angle }.collect { launch { turn.animateTo(it, tween(600)) } }
    }
    if (kind == null || kind == "car") {
        Canvas(
            Modifier
                .graphicsLayer { rotationZ = turn.value }
                .size(width = 24.dp, height = 44.dp)
                .dropShadow(RoundedCornerShape(8.dp), Shadow(radius = 4.dp, color = Color.Black.copy(alpha = 0.35f), offset = DpOffset(0.dp, 2.dp))),
        ) {
            val w = size.width
            val h = size.height
            val u = 1.dp.toPx()
            fun rect(c: Color, width: Float, height: Float, y: Float, r: Float) {
                drawRoundRect(c, Offset((w - width * u) / 2, h / 2 + (y - height / 2) * u), androidx.compose.ui.geometry.Size(width * u, height * u), CornerRadius(r * u))
            }
            drawRoundRect(night, cornerRadius = CornerRadius(8 * u))
            rect(Color.White.copy(alpha = 0.9f), 17f, 8f, -9f, 3f)
            rect(accent, 17f, 13f, 3f, 3f)
            rect(Color.White.copy(alpha = 0.9f), 15f, 4f, 14f, 2f)
            rect(Color.Red, 5f, 2f, 20f, 1f)
            drawRoundRect(Color.White, cornerRadius = CornerRadius(8 * u), style = Stroke(2 * u))
        }
    } else {
        // Drawn from the side, so it stays upright, and an arrow around it shows the way.
        Box(Modifier.size(58.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.fillMaxSize().graphicsLayer { rotationZ = turn.value }, contentAlignment = Alignment.TopCenter) {
                Icon(Icons.Filled.ArrowDropUp, null, tint = Theme.accentInk, modifier = Modifier.size(18.dp).offset(y = (-4).dp))
            }
            CarPin(kind)
        }
    }
}
