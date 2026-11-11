package eu.drivezzz.app.features.checks

import android.graphics.Bitmap
import android.hardware.camera2.CameraCharacteristics
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Size
import android.view.HapticFeedbackConstants
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.ImageProxy
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FlashlightOff
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.common.InputImage
import eu.drivezzz.app.ui.FullScreen
import eu.drivezzz.app.ui.T
import eu.drivezzz.app.ui.Theme
import eu.drivezzz.app.ui.semibold
import kotlin.math.max
import kotlin.math.min
import kotlin.math.tan

// The camera reading the code at the bottom of an ID. Like MRZCamera.swift: the frame on screen is the part of the picture that's
// read, and the camera zooms in so that an ID fills the frame from further away than its lens's closest focus (an ID filling the
// screen is closer than many phones can focus).
class MrzCapture {
    // The most seen so far, sure or not: only for showing how far it got.
    var read by mutableStateOf(MrzRead())
        private set
    // What's sure (MrzTally): all that leaves the scanner, also on Cancel.
    var confirmed by mutableStateOf(MrzRead())
        private set
    var torchOn by mutableStateOf(false)
        private set
    var problem by mutableStateOf<String?>(null)
    var onDone: ((MrzRead) -> Unit)? = null
    var camera: Camera? = null
        set(value) {
            field = value
            if (value != null) sharpen(value)
        }

    private val tally = MrzTally()
    @Volatile private var finished = false
    // Whether the lens is still finding the ID, as the camera said with its last frame, and since when.
    @Volatile var focusing = false
    private var focusingSince: Double? = null
    // The frame on screen, and the screen: what's read is only what's in the frame.
    @Volatile private var aim: FloatArray? = null
    private val main = Handler(Looper.getMainLooper())

    fun aim(left: Float, top: Float, width: Float, height: Float, screenW: Float, screenH: Float) {
        aim = floatArrayOf(left, top, width, height, screenW, screenH)
    }

    fun stop() {
        finished = true
    }

    fun toggleTorch() {
        val c = camera ?: return
        if (c.cameraInfo.hasFlashUnit()) {
            torchOn = !torchOn
            c.cameraControl.enableTorch(torchOn)
        }
    }

    // How far in, for an ID card filling the frame at a quarter past the lens's closest focus. A passport is held further away.
    @androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
    private fun sharpen(camera: Camera) {
        runCatching {
            val info = Camera2CameraInfo.from(camera.cameraInfo)
            val diopters = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
            val closest = if (diopters > 0) 1000f / diopters else 200f // mm
            val sensor = info.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
            val focal = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.firstOrNull()
            // Upright, across is the picture's short side: of a 16:9 picture, 9/16 of the sensor's long side.
            val seenAcrossPerMm = if (sensor != null && focal != null && focal > 0) max(sensor.width, sensor.height) * 9f / 16f / focal
            else (2 * tan(Math.toRadians(69.0 / 2)) * 9 / 16).toFloat()
            val cardFillsFrameAt = 85.6f / 0.75f / seenAcrossPerMm // the frame is about three quarters of what the camera sees
            val wanted = min(max(1f, closest * 1.25f / cardFillsFrameAt), 2.5f)
            val zoom = camera.cameraInfo.zoomState.value
            camera.cameraControl.setZoomRatio(if (zoom != null) wanted.coerceIn(zoom.minZoomRatio, zoom.maxZoomRatio) else wanted)
        }
    }

    // On the camera's own thread. This takes a moment, and frames arriving meanwhile are dropped.
    fun analyze(image: ImageProxy) {
        image.use {
            if (finished) return
            val time = SystemClock.elapsedRealtime() / 1000.0
            // Not while the lens is still finding the ID: a picture half in focus is where most misreadings come from. Never more
            // than a second of that, in case a camera keeps saying it's focusing.
            if (focusing) {
                val since = focusingSince ?: time
                focusingSince = since
                if (time - since < 1) return
            } else {
                focusingSince = null
            }
            val upright = DocumentReader.rotated(image.toBitmap(), image.imageInfo.rotationDegrees)
            // Text is read only in the frame, and read better: it's not the whole picture shrunk. A hand isn't a tripod, and a
            // passport's code is as wide as the frame, so with some room around it.
            val part = aim?.let { DocumentReader.cropped(upright, it, room = 0.12f) } ?: Bitmap.createBitmap(upright, 0, upright.height / 4, upright.width, upright.height / 2)
            val text = TextReader.textNow(InputImage.fromBitmap(part, 0)) ?: return
            tally.add(MrzScan.look(MrzScan.lines(TextReader.seen(text), part.width.toFloat())), time)
            val now = tally.read
            val sure = tally.confirmed
            // Done once the three parts that open the chip are sure: the name comes from the chip, so it isn't waited for.
            val done = tally.sure
            if (done) finished = true
            main.post {
                if (read != now) read = now
                if (confirmed != sure) confirmed = sure
                if (done) onDone?.invoke(sure)
            }
        }
    }
}

// The screen around it: the camera, a frame the shape of an ID card, and how far it got. Cancelling hands over only the parts it
// was sure of: one that's only been seen might be a misreading, and a date from the scan isn't shown to check.
@Composable
fun MrzScanner(done: (MrzRead?) -> Unit) {
    val context = LocalContext.current
    val view = LocalView.current
    val density = LocalDensity.current
    val capture = remember { MrzCapture() }
    var allowed by remember { mutableStateOf(CameraAccess.allowed(context)) }
    val ask = rememberCameraAsk { ok ->
        allowed = ok
        if (!ok) capture.problem = "Drivezzz needs the camera to read this. Allow it in Settings, or type the details in."
    }
    LaunchedEffect(Unit) {
        capture.onDone = {
            view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
            done(it)
        }
        if (!allowed) ask()
    }
    DisposableEffect(Unit) { onDispose { capture.stop() } }

    FullScreen(onDismiss = {
        capture.stop()
        done(capture.confirmed)
    }) {
        BoxWithConstraints(Modifier.fillMaxSize().background(Theme.night)) {
            val screenW = constraints.maxWidth.toFloat()
            val screenH = constraints.maxHeight.toFloat()
            val frameW = min(screenW - with(density) { 32.dp.toPx() }, with(density) { 520.dp.toPx() })
            val frameH = min(frameW / 1.586f, screenH * 0.5f)
            val frameX = (screenW - frameW) / 2
            val frameY = (screenH - frameH) * 0.42f
            LaunchedEffect(screenW, screenH) { capture.aim(frameX, frameY, frameW, frameH, screenW, screenH) }
            if (allowed) {
                // A bigger picture than usual: small letters, and the zoom crops it.
                CameraView(front = false, modifier = Modifier.fillMaxSize(), analysis = Size(1920, 1080), analyze = { capture.analyze(it) }, focusing = { capture.focusing = it }, onCamera = { camera ->
                    capture.camera = camera
                    if (camera == null) capture.problem = "The camera can’t be used. Type the details in instead."
                })
            }
            val dim = Theme.night.copy(alpha = 0.6f)
            Canvas(Modifier.fillMaxSize()) {
                val r = 16.dp.toPx()
                val path = Path().apply {
                    fillType = PathFillType.EvenOdd
                    addRect(androidx.compose.ui.geometry.Rect(0f, 0f, size.width, size.height))
                    addRoundRect(androidx.compose.ui.geometry.RoundRect(frameX, frameY, frameX + frameW, frameY + frameH, CornerRadius(r)))
                }
                drawPath(path, dim)
                drawRoundRect(Color.White, Offset(frameX, frameY), androidx.compose.ui.geometry.Size(frameW, frameH), CornerRadius(r), style = androidx.compose.ui.graphics.drawscope.Stroke(3.dp.toPx()))
            }
            Text(
                "<<<<<<<<<<<<<<<<<<<<",
                style = T.footnote.semibold.copy(fontFamily = FontFamily.Monospace),
                color = Color.White.copy(alpha = 0.65f),
                maxLines = 1,
                modifier = Modifier.align(Alignment.TopCenter).offset(y = with(density) { (frameY + frameH).toDp() } - 36.dp),
            )
            Row(
                Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = 16.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    "Cancel",
                    style = T.body.semibold,
                    color = Color.White,
                    modifier = Modifier.clickable {
                        capture.stop()
                        done(capture.confirmed)
                    }.padding(8.dp),
                )
                Spacer(Modifier.weight(1f))
                Box(
                    Modifier
                        .size(44.dp)
                        .background(Color.White.copy(alpha = if (capture.torchOn) 0.3f else 0.15f), CircleShape)
                        .clickable { capture.toggleTorch() }
                        .semantics { contentDescription = "Light" },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(if (capture.torchOn) Icons.Filled.FlashlightOn else Icons.Filled.FlashlightOff, null, tint = Color.White, modifier = Modifier.size(20.dp))
                }
            }
            Column(
                Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(horizontal = 24.dp).padding(bottom = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(14.dp),
            ) {
                // How far it got, without naming the parts: "born" and "valid until" are printed on the front, and sent people there.
                // A part seen but not yet sure is half lit, and then the screen asks to hold still while it makes sure.
                val r = capture.read
                val c = capture.confirmed
                val seen = listOf(r.number, r.birth, r.expiry).count { it != null }
                val parts = listOf(c.number, c.birth, c.expiry).count { it != null }
                val problem = capture.problem
                if (problem != null) {
                    Text(problem, style = T.headline, color = Color.White, textAlign = TextAlign.Center)
                } else {
                    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(if (seen > 0) "Hold still…" else "The back of your ID card", style = T.headline, color = Color.White, textAlign = TextAlign.Center)
                        Text("The side without your photo. Put the lines with <<< in the frame, about 25 cm from the phone.", style = T.subheadline, color = Color.White.copy(alpha = 0.85f), textAlign = TextAlign.Center)
                        Text("Passport: the bottom of the photo page.", style = T.footnote, color = Color.White.copy(alpha = 0.7f), textAlign = TextAlign.Center)
                    }
                }
                Row(
                    Modifier.semantics { contentDescription = if (parts == 3) "Read" else "Reading, $parts of 3" },
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    for (i in 0 until 3) {
                        val fill by animateColorAsState(
                            when {
                                i < parts -> Theme.ok
                                i < maxOf(seen, parts) -> Theme.ok.copy(alpha = 0.4f)
                                else -> Color.White.copy(alpha = 0.3f)
                            },
                            label = "part",
                        )
                        Box(Modifier.width(28.dp).height(6.dp).background(fill, RoundedCornerShape(3.dp)))
                    }
                }
            }
        }
    }
}
