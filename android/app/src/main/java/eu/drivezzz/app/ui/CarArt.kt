package eu.drivezzz.app.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.rememberVectorPainter
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.Car
import kotlin.math.max
import kotlin.math.min

enum class CarAngle { Side, Front, Rear, Inside }

// A motor or scooter has no inside, and its picture is simpler.
fun anglesFor(car: Car): List<CarAngle> = if (car.kind == "car") CarAngle.entries else listOf(CarAngle.Side, CarAngle.Rear)

// The generated pictures of a car: drawn from what its number plate says in the register (body, colour, plate).
// Shown when a driver has no photos, or next to them.
@Composable
fun CarArt(car: Car, angle: CarAngle = CarAngle.Side, modifier: Modifier = Modifier) {
    val paint = colorOf(car.colorHex) ?: hexColor(0xB8BBBF)
    val soft = Theme.accentSoft
    val ink = Theme.ink
    val faint = Theme.faint
    val plateSize = remember(car) { car.shownPlate }
    val veryLight = car.colorHex?.uppercase() in listOf("#F4F4F2", "#E8E0C8")
    val shape = RoundedCornerShape(Theme.radius)
    BoxWithConstraints(
        modifier.clip(shape).background(soft).semantics { contentDescription = "Generated picture of a ${car.colorName ?: ""} ${car.title}" },
    ) {
        val w = maxWidth
        val h = maxHeight
        if (car.kind != "car") {
            Canvas(Modifier.fillMaxSize()) {
                drawOval(ink.copy(alpha = 0.08f), Offset(size.width * 0.1f, size.height * 0.79f), Size(size.width * 0.8f, size.height * 0.1f))
            }
            Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(h * 0.05f, Alignment.CenterVertically), horizontalAlignment = Alignment.CenterHorizontally) {
                Icon(
                    Sym.vehicle(car.kind), null,
                    tint = if (veryLight) faint else paint,
                    modifier = Modifier.size(h * if (angle == CarAngle.Rear) 0.42f else 0.6f),
                )
                if (angle == CarAngle.Rear) PlateView(plateSize, min((w * 0.05f).value, (h * 0.1f).value).dp)
            }
        } else {
            Canvas(Modifier.fillMaxSize()) {
                drawOval(ink.copy(alpha = 0.08f), Offset(size.width * 0.1f, size.height * 0.79f), Size(size.width * 0.8f, size.height * 0.1f))
                when (angle) {
                    CarAngle.Side -> drawSide(car, paint, ink)
                    CarAngle.Front -> drawFaceOn(car, paint, ink, true)
                    CarAngle.Rear -> drawFaceOn(car, paint, ink, false)
                    CarAngle.Inside -> drawInside(paint)
                }
            }
            if (angle == CarAngle.Front || angle == CarAngle.Rear) {
                val plate = min((w * 0.042f).value, (h * 0.07f).value).dp
                Box(Modifier.fillMaxSize().padding(top = h * 0.69f - plate * 0.85f), contentAlignment = Alignment.TopCenter) { PlateView(plateSize, plate) }
            }
        }
    }
}

private class Shape(val roofStart: Float, val roofEnd: Float, val roof: Float, val belly: Float, val tail: Float, val nose: Float)

// Roof and bonnet heights for each body, as shares of the picture.
private fun shapeOf(body: String?) = when (body) {
    "sedan" -> Shape(0.34f, 0.62f, 0.30f, 0.74f, 0.46f, 0.52f)
    "estate" -> Shape(0.34f, 0.82f, 0.30f, 0.74f, 0.40f, 0.52f)
    "suv" -> Shape(0.32f, 0.82f, 0.22f, 0.72f, 0.34f, 0.46f)
    "mpv" -> Shape(0.26f, 0.86f, 0.22f, 0.74f, 0.34f, 0.50f)
    "van" -> Shape(0.22f, 0.92f, 0.18f, 0.74f, 0.20f, 0.46f)
    else -> Shape(0.34f, 0.76f, 0.28f, 0.74f, 0.38f, 0.52f)
}

private fun DrawScope.drawSide(car: Car, paint: Color, ink: Color) {
    val w = size.width
    val h = size.height
    val s = shapeOf(car.body)
    fun X(x: Float) = x * w
    fun Y(y: Float) = y * h
    val body = Path().apply {
        moveTo(X(0.06f), Y(s.belly))
        lineTo(X(0.06f), Y(s.nose + 0.06f))
        quadraticTo(X(0.06f), Y(s.nose), X(0.10f), Y(s.nose))
        lineTo(X(s.roofStart - 0.10f), Y(s.nose - 0.06f))
        quadraticTo(X(s.roofStart - 0.04f), Y(s.roof + 0.06f), X(s.roofStart), Y(s.roof))
        lineTo(X(s.roofEnd), Y(s.roof))
        quadraticTo(X(0.92f), Y(s.roof), X(0.94f), Y(s.tail))
        lineTo(X(0.94f), Y(s.belly))
        close()
    }
    val window = Path().apply {
        moveTo(X(s.roofStart + 0.012f), Y(s.roof + 0.035f))
        lineTo(X(s.roofEnd - 0.01f), Y(s.roof + 0.035f))
        quadraticTo(X(s.roofEnd + 0.07f), Y(s.roof + 0.04f), X(min(0.90f, s.roofEnd + 0.09f)), Y(s.tail + 0.01f))
        lineTo(X(s.roofStart - 0.075f), Y(s.tail + 0.01f))
        close()
    }
    drawPath(body, Brush.verticalGradient(listOf(paint.copy(alpha = 0.92f), paint)))
    drawPath(body, ink.copy(alpha = 0.18f), style = Stroke(1.dp.toPx()))
    drawPath(window, hexColor(0x1A2B44).copy(alpha = 0.85f))
    val x = (s.roofStart + s.roofEnd) / 2
    drawLine(paint, Offset(X(x), Y(s.roof + 0.03f)), Offset(X(x), Y(s.tail + 0.01f)), strokeWidth = max(2.dp.toPx(), w * 0.012f))
    // Door line, handle, lights.
    drawLine(ink.copy(alpha = 0.18f), Offset(X(x), Y(s.tail + 0.02f)), Offset(X(x), Y(s.belly - 0.02f)), strokeWidth = 1.dp.toPx())
    fun capsule(c: Color, cx: Float, cy: Float, width: Float, height: Float) {
        drawRoundRect(c, Offset(X(cx) - width / 2, Y(cy) - height / 2), Size(width, height), CornerRadius(min(width, height) / 2))
    }
    capsule(hexColor(0xFFF3B0), 0.085f, s.nose + 0.05f, w * 0.045f, h * 0.035f)
    capsule(hexColor(0xD92D20), 0.925f, s.tail + 0.07f, w * 0.03f, h * 0.05f)
    fun wheel(cx: Float) {
        val d = min(w * 0.17f, h * 0.3f)
        val c = Offset(X(cx), Y(s.belly))
        drawCircle(hexColor(0x14171C), d / 2, c)
        drawCircle(hexColor(0xC7CCD4), d * 0.275f, c)
        drawCircle(hexColor(0x6A7280), d * 0.08f, c)
    }
    wheel(0.24f)
    wheel(0.76f)
}

private fun DrawScope.drawFaceOn(car: Car, paint: Color, ink: Color, front: Boolean) {
    val w = size.width
    val h = size.height
    val tall = if (car.body in listOf("suv", "mpv", "van")) 0.18f else 0.26f
    fun X(x: Float) = x * w
    fun Y(y: Float) = y * h
    fun box(c: Color, cx: Float, cy: Float, width: Float, height: Float, r: Float) {
        drawRoundRect(c, Offset(X(cx) - width / 2, Y(cy) - height / 2), Size(width, height), CornerRadius(r))
    }
    box(hexColor(0x14171C), 0.25f, 0.83f, w * 0.09f, h * 0.1f, 3.dp.toPx())
    box(hexColor(0x14171C), 0.75f, 0.83f, w * 0.09f, h * 0.1f, 3.dp.toPx())
    val cabin = Path().apply {
        moveTo(X(0.27f), Y(0.52f))
        lineTo(X(0.33f), Y(tall))
        quadraticTo(X(0.5f), Y(tall - 0.04f), X(0.67f), Y(tall))
        lineTo(X(0.73f), Y(0.52f))
        close()
    }
    drawPath(cabin, paint)
    drawPath(cabin, ink.copy(alpha = 0.18f), style = Stroke(1.dp.toPx()))
    val lower = Rect(Offset(0.18f * w, 0.49f * h), Size(0.64f * w, 0.3f * h))
    drawRoundRect(paint, lower.topLeft, lower.size, CornerRadius(h * 0.05f))
    drawRoundRect(ink.copy(alpha = 0.18f), lower.topLeft, lower.size, CornerRadius(h * 0.05f), style = Stroke(1.dp.toPx()))
    val glass = Path().apply {
        moveTo(X(0.31f), Y(0.5f))
        lineTo(X(0.355f), Y(tall + 0.04f))
        quadraticTo(X(0.5f), Y(tall), X(0.645f), Y(tall + 0.04f))
        lineTo(X(0.69f), Y(0.5f))
        close()
    }
    drawPath(glass, hexColor(0x1A2B44).copy(alpha = 0.85f))
    if (front) {
        box(hexColor(0xFFF3B0), 0.28f, 0.57f, w * 0.12f, h * 0.055f, h * 0.03f)
        box(hexColor(0xFFF3B0), 0.72f, 0.57f, w * 0.12f, h * 0.055f, h * 0.03f)
        box(hexColor(0x14171C).copy(alpha = 0.75f), 0.5f, 0.58f, w * 0.26f, h * 0.06f, 4.dp.toPx())
    } else {
        box(hexColor(0xD92D20), 0.28f, 0.57f, w * 0.13f, h * 0.055f, h * 0.03f)
        box(hexColor(0xD92D20), 0.72f, 0.57f, w * 0.13f, h * 0.055f, h * 0.03f)
    }
}

private fun DrawScope.drawInside(paint: Color) {
    val w = size.width
    val h = size.height
    fun X(x: Float) = x * w
    fun Y(y: Float) = y * h
    drawRect(hexColor(0x1F2A3C))
    // Windscreen with the sky.
    val screen = Path().apply {
        moveTo(X(0.08f), Y(0.5f))
        lineTo(X(0.16f), Y(0.08f))
        lineTo(X(0.84f), Y(0.08f))
        lineTo(X(0.92f), Y(0.5f))
        close()
    }
    drawPath(screen, Brush.verticalGradient(listOf(hexColor(0xBFDAFF), hexColor(0xEAF1FF))))
    // Dashboard.
    drawRoundRect(hexColor(0x2E3A4F), Offset(0f, 0.48f * h), Size(w, 0.2f * h), CornerRadius(6.dp.toPx()))
    drawRoundRect(hexColor(0x0B1B33), Offset(X(0.5f) - w * 0.08f, Y(0.57f) - h * 0.05f), Size(w * 0.16f, h * 0.1f), CornerRadius(4.dp.toPx()))
    // Wheel.
    val wheel = Offset(X(0.72f), Y(0.66f))
    drawCircle(hexColor(0x0E1420), h * 0.17f, wheel, style = Stroke(max(3.dp.toPx(), h * 0.03f)))
    drawLine(hexColor(0x0E1420), wheel - Offset(h * 0.15f, 0f), wheel + Offset(h * 0.15f, 0f), strokeWidth = max(2.dp.toPx(), h * 0.02f), cap = StrokeCap.Butt)
    // Seats, in the car's colour.
    fun seat(cx: Float, cy: Float) {
        drawRoundRect(paint.copy(alpha = 0.9f), Offset(X(cx) - w * 0.1f, Y(cy) - h * 0.14f), Size(w * 0.2f, h * 0.28f), CornerRadius(h * 0.05f))
    }
    seat(0.28f, 0.88f)
    seat(0.72f, 0.92f)
}

// A car's photos and generated pictures, swiped through. Tap one to see it big.
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CarGallery(car: Car, height: Dp = 190.dp) {
    val photos = car.photos ?: emptyList()
    // The generated pictures are for a vehicle without photos yet: nobody can drive without them now.
    val art = if (photos.isEmpty()) anglesFor(car) else emptyList()
    val count = photos.size + art.size
    val pager = rememberPagerState { count }
    var big by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(Theme.radius)).clickable { big = true }) {
            HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { i ->
                if (i < photos.size) {
                    RemotePhoto(ApiClient.imageURL(photos[i].url), Modifier.fillMaxSize())
                } else {
                    CarArt(car, art[i - photos.size], Modifier.fillMaxSize())
                }
            }
            if (count > 1) PageDots(count, pager.currentPage, Modifier.align(Alignment.BottomCenter).padding(bottom = 8.dp))
        }
        if (photos.isEmpty()) Text("Pictures generated from the number plate", style = T.caption, color = Theme.faint)
    }
    if (big) {
        FullScreen(onDismiss = { big = false }) {
            CarPicturesBig(car, pager.currentPage) { big = false }
        }
    }
}

@Composable
private fun PageDots(count: Int, current: Int, modifier: Modifier = Modifier) {
    androidx.compose.foundation.layout.Row(modifier.padding(horizontal = 8.dp, vertical = 5.dp), horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        for (i in 0 until count) {
            Box(Modifier.size(6.dp).background(Color.White.copy(alpha = if (i == current) 1f else 0.45f), CircleShape))
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun CarPicturesBig(car: Car, page: Int, close: () -> Unit) {
    val photos = car.photos ?: emptyList()
    val art = if (photos.isEmpty()) anglesFor(car) else emptyList()
    val count = photos.size + art.size
    val pager = rememberPagerState(initialPage = page.coerceIn(0, (count - 1).coerceAtLeast(0))) { count }
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        HorizontalPager(state = pager, modifier = Modifier.fillMaxSize()) { i ->
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                if (i < photos.size) {
                    RemotePhoto(ApiClient.imageURL(photos[i].url), Modifier.fillMaxSize(), ContentScale.Fit, Color.Black)
                } else {
                    CarArt(car, art[i - photos.size], Modifier.fillMaxWidth().padding(horizontal = 12.dp).height(240.dp))
                }
            }
        }
        if (count > 1) PageDots(count, pager.currentPage, Modifier.align(Alignment.BottomCenter).padding(bottom = 40.dp))
        Box(
            Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(16.dp)
                .size(40.dp)
                .background(Color.White.copy(alpha = 0.18f), CircleShape)
                .clickable(onClick = close),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Sym.close, "Close", tint = Color.White, modifier = Modifier.size(20.dp))
        }
    }
}

// A small picture of a vehicle: its first photo, or the drawn one.
@Composable
fun VehicleThumb(car: Car, width: Dp = 84.dp, height: Dp = 60.dp) {
    val photo = car.photos?.firstOrNull()?.url?.let { ApiClient.imageURL(it) }
    Box(Modifier.size(width, height).clip(RoundedCornerShape(12.dp)).background(Theme.page)) {
        if (photo != null) {
            RemotePhoto(photo, Modifier.fillMaxSize())
        } else {
            CarArt(car, anglesFor(car)[0], Modifier.fillMaxSize().padding(4.dp))
        }
    }
}
