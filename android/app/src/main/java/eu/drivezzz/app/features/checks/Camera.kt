package eu.drivezzz.app.features.checks

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.CaptureResult
import android.hardware.camera2.TotalCaptureResult
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.camera2.interop.Camera2Interop
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.AspectRatioStrategy
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.Executors

object CameraAccess {
    fun allowed(context: Context) = ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
    fun has(context: Context, front: Boolean = false) =
        context.packageManager.hasSystemFeature(if (front) PackageManager.FEATURE_CAMERA_FRONT else PackageManager.FEATURE_CAMERA_ANY)
}

// Asks for the camera once it's needed, and says what came of it. `null` until asked.
@Composable
fun rememberCameraAsk(onAnswer: (Boolean) -> Unit): () -> Unit {
    val context = LocalContext.current
    val answer by rememberUpdatedState(onAnswer)
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { answer(it) }
    return { if (CameraAccess.allowed(context)) answer(true) else launcher.launch(Manifest.permission.CAMERA) }
}

// The camera's picture on screen, filling it, with what looks at each frame (on a thread of its own) and what takes a photo.
// Only while it's on screen: the camera stops when this goes. `focusing` hears, frame by frame, whether the lens is still finding
// its focus (on a camera thread).
@androidx.annotation.OptIn(ExperimentalCamera2Interop::class)
@Composable
fun CameraView(
    front: Boolean,
    modifier: Modifier = Modifier,
    analysis: Size? = null,
    analyze: ((ImageProxy) -> Unit)? = null,
    capture: ImageCapture? = null,
    focusing: ((Boolean) -> Unit)? = null,
    onCamera: (Camera?) -> Unit = {},
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val currentAnalyze by rememberUpdatedState(analyze)
    val currentOnCamera by rememberUpdatedState(onCamera)
    val currentFocusing by rememberUpdatedState(focusing)
    val executor = remember { Executors.newSingleThreadExecutor() }
    val view = remember { PreviewView(context).apply { scaleType = PreviewView.ScaleType.FILL_CENTER } }

    DisposableEffect(lifecycle, front) {
        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            val p = runCatching { future.get() }.getOrNull() ?: return@addListener currentOnCamera(null)
            // The same shape as what's looked at, so the frame on screen is the part that's read.
            val shape = ResolutionSelector.Builder().setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY).build()
            val preview = Preview.Builder().setResolutionSelector(shape).build().also { it.surfaceProvider = view.surfaceProvider }
            val cases = mutableListOf<androidx.camera.core.UseCase>(preview)
            if (analyze != null) {
                val selector = ResolutionSelector.Builder()
                    .setAspectRatioStrategy(AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY)
                    .setResolutionStrategy(ResolutionStrategy(analysis ?: Size(1280, 720), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                    .build()
                val builder = ImageAnalysis.Builder()
                    .setResolutionSelector(selector)
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                if (focusing != null) {
                    Camera2Interop.Extender(builder).setSessionCaptureCallback(object : CameraCaptureSession.CaptureCallback() {
                        override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                            val af = result.get(CaptureResult.CONTROL_AF_STATE)
                            currentFocusing?.invoke(af == CaptureResult.CONTROL_AF_STATE_PASSIVE_SCAN || af == CaptureResult.CONTROL_AF_STATE_ACTIVE_SCAN)
                        }
                    })
                }
                cases += builder
                    .build()
                    .also { a -> a.setAnalyzer(executor) { image -> currentAnalyze?.invoke(image) ?: image.close() } }
            }
            if (capture != null) cases += capture
            val camera = runCatching {
                p.unbindAll()
                p.bindToLifecycle(lifecycle, if (front) CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA, *cases.toTypedArray())
            }.getOrNull()
            currentOnCamera(camera)
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            runCatching { future.get()?.unbindAll() }
        }
    }
    DisposableEffect(Unit) { onDispose { executor.shutdown() } }
    AndroidView(factory = { view }, modifier = modifier)
}
