package eu.drivezzz.app.features.checks

import android.graphics.Bitmap
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import eu.drivezzz.app.ui.FullScreen
import eu.drivezzz.app.ui.Spinner
import eu.drivezzz.app.ui.T
import eu.drivezzz.app.ui.Theme
import eu.drivezzz.app.ui.semibold
import kotlin.math.min

// Photographing the chauffeurskaart or taxi permit with the camera, in a frame its shape, sharp enough to read on the phone. The
// iPhone's document camera finds the edges by itself; here the frame shows where to hold it, and what's read is checked by the driver.
@Composable
fun DocumentCamera(card: Boolean, done: (Bitmap?) -> Unit) {
    val context = LocalContext.current
    val density = LocalDensity.current
    var allowed by remember { mutableStateOf(CameraAccess.allowed(context)) }
    var problem by remember { mutableStateOf<String?>(null) }
    var taking by remember { mutableStateOf(false) }
    val ask = rememberCameraAsk { ok ->
        allowed = ok
        if (!ok) problem = "Drivezzz needs the camera for this. Allow it in Settings."
    }
    // The same shape as the picture on screen, so the frame on screen is the part that's kept.
    val capture = remember {
        ImageCapture.Builder()
            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
            .setResolutionSelector(ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY).build())
            .build()
    }
    var frame by remember { mutableStateOf(floatArrayOf(0f, 0f, 1f, 1f, 1f, 1f)) }
    LaunchedEffect(Unit) { if (!allowed) ask() }

    fun take() {
        if (taking) return
        taking = true
        capture.takePicture(ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageCapturedCallback() {
            override fun onCaptureSuccess(image: ImageProxy) {
                val picture = image.use { DocumentReader.rotated(it.toBitmap(), it.imageInfo.rotationDegrees) }
                done(DocumentReader.cropped(picture, frame))
            }

            override fun onError(exception: ImageCaptureException) {
                taking = false
                problem = "That didn’t work. Try again."
            }
        })
    }

    FullScreen(onDismiss = { done(null) }) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Theme.night)) {
            val w = constraints.maxWidth.toFloat()
            val h = constraints.maxHeight.toFloat()
            // A card is 85.6 × 54 mm; a permit is a page.
            val frameW = min(w - with(density) { 32.dp.toPx() }, with(density) { 560.dp.toPx() })
            val frameH = if (card) frameW / 1.586f else min(frameW * 1.414f, h * 0.62f)
            val frameX = (w - frameW) / 2
            val frameY = (h - frameH) * 0.4f
            LaunchedEffect(w, h) { frame = floatArrayOf(frameX, frameY, frameW, frameH, w, h) }
            if (allowed) CameraView(front = false, modifier = Modifier.fillMaxSize(), capture = capture, onCamera = { if (it == null) problem = "The camera can’t be used." })
            Canvas(Modifier.fillMaxSize()) {
                val r = 14.dp.toPx()
                val path = Path().apply {
                    fillType = PathFillType.EvenOdd
                    addRect(androidx.compose.ui.geometry.Rect(0f, 0f, size.width, size.height))
                    addRoundRect(androidx.compose.ui.geometry.RoundRect(frameX, frameY, frameX + frameW, frameY + frameH, CornerRadius(r)))
                }
                drawPath(path, Theme.night.copy(alpha = 0.55f))
                drawRoundRect(Color.White, Offset(frameX, frameY), androidx.compose.ui.geometry.Size(frameW, frameH), CornerRadius(r), style = Stroke(3.dp.toPx()))
            }
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp)) {
                Text("Cancel", style = T.body.semibold, color = Color.White, modifier = Modifier.clickable { done(null) }.padding(8.dp))
                Spacer(Modifier.weight(1f))
            }
            Column(
                Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 28.dp, start = 24.dp, end = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                Text(problem ?: if (card) "Fill the frame with the front of the card, in good light." else "Fill the frame with the page, in good light.", style = T.subheadline, color = Color.White, textAlign = TextAlign.Center)
                Box(
                    Modifier
                        .size(74.dp)
                        .border(4.dp, Color.White, CircleShape)
                        .padding(7.dp)
                        .background(if (allowed) Color.White else Color.White.copy(alpha = 0.3f), CircleShape)
                        .clickable(enabled = allowed && !taking) { take() }
                        .semantics { contentDescription = "Take the photo" },
                    contentAlignment = Alignment.Center,
                ) { if (taking) Spinner(Theme.night) }
            }
        }
    }
}
