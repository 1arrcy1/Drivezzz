package eu.drivezzz.app.features.checks

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import androidx.camera.core.ImageProxy
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import kotlin.math.abs

// The selfie: the front camera, and a turn of the head one way and then the other, in the order the server asked. A photo held up
// to the camera can't do that. Two straight-on pictures (before and after) are what's compared with the ID; the pictures stay in
// memory and are gone when this closes. As SelfieCapture.swift, with ML Kit's face finder in place of Vision's.
//
// Made to be hard to get stuck in (Pieter, 7 November 2026: it took too long and people got frustrated): an arrow and four marks
// say where you are, a turn counts from how you held your head looking straight (a phone held to one side tilts that), turning
// the same way twice says "the other way" instead of asking again for a way it won't take, a tip comes after 8 seconds on one
// step, and it gives up only after 2 minutes.
class SelfieCapture(val steps: List<String>) {
    enum class Side { Left, Right }

    sealed class Phase {
        data object Starting : Phase()
        data object Straight : Phase()
        data class Turn(val i: Int) : Phase()
        data object StraightAgain : Phase()
        data object Done : Phase()
        data class Failed(val why: String) : Phase()
    }

    var phase by mutableStateOf<Phase>(Phase.Starting)
        private set
    var hint by mutableStateOf("Look straight at the camera")
        private set
    // The second turn went the first one's way: "the other way", and no arrow.
    var wrongWay by mutableStateOf(false)
        private set
    var onDone: ((List<Bitmap>) -> Unit)? = null
    // A step done: the screen gives a tap you can feel.
    var onStep: (() -> Unit)? = null

    private val pictures = mutableListOf<Bitmap>()
    private var firstTurnSign = 0.0
    private var baseline = 0.0 // the yaw looking straight, which turns count from
    private val straightYaws = mutableListOf<Double>()
    private var backInMiddle = false // after the first turn, back to straight before the second
    @Volatile private var wrong = false
    private var steadyFrames = 0
    private var lastFrame = 0L
    private var startedAt = System.currentTimeMillis()
    private var stepStartedAt = startedAt

    // The way to turn now, as you see yourself: the picture on screen is mirrored, so your left is the screen's left.
    val arrow: Side?
        get() {
            val p = phase
            if (p !is Phase.Turn || wrongWay) return null
            return if (steps.getOrNull(p.i) == "left") Side.Left else Side.Right
        }

    // How many steps are done, of `stepCount`: looking straight, the two turns, and straight again.
    val stepsDone: Int
        get() = when (val p = phase) {
            is Phase.Turn -> 1 + p.i
            is Phase.StraightAgain -> 3
            is Phase.Done -> stepCount
            else -> 0
        }
    val stepCount: Int get() = if (steps.isEmpty()) 1 else 4
    @Volatile private var current: Phase = Phase.Starting
    private val main = Handler(Looper.getMainLooper())

    // Fast and rough, for following a face frame by frame: only where it is and how it's turned.
    private val detector = FaceDetection.getClient(
        FaceDetectorOptions.Builder().setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_FAST).setMinFaceSize(0.15f).build()
    )

    fun started() {
        startedAt = System.currentTimeMillis()
        stepStartedAt = startedAt
        set(Phase.Straight, "Look straight at the camera")
    }

    fun failed(why: String) = set(Phase.Failed(why), "")

    fun close() {
        current = Phase.Done
        runCatching { detector.close() }
    }

    private fun set(phase: Phase, hint: String, wrongWay: Boolean = false) {
        current = phase
        wrong = wrongWay
        main.post {
            if (this.phase != phase) this.phase = phase
            if (this.hint != hint) this.hint = hint
            if (this.wrongWay != wrongWay) this.wrongWay = wrongWay
            if (phase == Phase.Done) onDone?.invoke(pictures.toList())
        }
    }

    // On to the next step, with a tap you can feel.
    private fun advance(phase: Phase, hint: String) {
        stepStartedAt = System.currentTimeMillis()
        backInMiddle = false
        set(phase, hint)
        main.post { onStep?.invoke() }
    }

    private fun side(i: Int) = if (steps.getOrNull(i) == "left") "left" else "right"
    private fun turnHint(i: Int) = if (i == 0) "Turn your head to the ${side(i)}" else "Now turn your head to the ${side(i)}"

    // On the camera's own thread, for every frame it hands over.
    fun analyze(image: ImageProxy) {
        image.use {
            val now = System.currentTimeMillis()
            // About 8 looks a second is plenty.
            if (now - lastFrame < 120) return
            lastFrame = now
            val phase = current
            if (phase !is Phase.Straight && phase !is Phase.StraightAgain && phase !is Phase.Turn) return
            if (now - startedAt > 120_000) {
                set(Phase.Failed("That took too long. Try again in good light, with the phone in front of your face."), "")
                return
            }
            val stuck = now - stepStartedAt > 8_000
            // The front camera's picture lies on its side: upright, as others see you, like the photo on your ID.
            val upright = DocumentReader.rotated(image.toBitmap(), image.imageInfo.rotationDegrees)
            val faces = runCatching { Tasks.await(detector.process(InputImage.fromBitmap(upright, 0))) }.getOrNull() ?: return
            val big = faces.filter { it.boundingBox.width() > 0.15f * upright.width }
            if (big.size != 1) {
                steadyFrames = 0
                straightYaws.clear()
                val lost = if (stuck) "Hold the phone in front of your face, in good light" else "Bring your face into the circle"
                set(phase, if (big.isEmpty()) lost else "Only you in the picture", wrong)
                return
            }
            val face = big.first()
            // ML Kit says it in degrees, Vision in radians: the same limits as on iOS.
            val yaw = Math.toRadians(face.headEulerAngleY.toDouble())
            val roll = Math.toRadians(face.headEulerAngleZ.toDouble())
            val width = face.boundingBox.width() / upright.width.toFloat()
            when (phase) {
                is Phase.Straight, is Phase.StraightAgain -> {
                    if (abs(yaw) >= 0.2 || abs(roll) >= 0.3 || width <= 0.25f) {
                        steadyFrames = 0
                        straightYaws.clear()
                        val level = if (stuck) "Look into the camera, not at the screen, and keep your head level" else "Look straight at the camera"
                        set(phase, if (width <= 0.25f) "Come a little closer" else level)
                        return
                    }
                    steadyFrames++
                    straightYaws += yaw
                    if (steadyFrames < 3) return
                    if (phase is Phase.Straight) baseline = straightYaws.average()
                    steadyFrames = 0
                    straightYaws.clear()
                    pictures.add(upright)
                    // No turns asked: one picture is enough.
                    if (phase is Phase.Straight && steps.isNotEmpty()) advance(Phase.Turn(0), turnHint(0)) else advance(Phase.Done, "Got it")
                }
                is Phase.Turn -> {
                    val turned = yaw - baseline
                    if (abs(turned) < 0.15) backInMiddle = true
                    if (abs(turned) <= 0.3) {
                        if (stuck && !wrong) set(phase, "Turn your head further to the ${side(phase.i)}, slowly")
                        return
                    }
                    val sign = if (turned > 0) 1.0 else -1.0
                    if (phase.i == 0) {
                        firstTurnSign = sign
                        advance(Phase.Turn(1), turnHint(1))
                    } else if (sign == -firstTurnSign) {
                        advance(Phase.StraightAgain, "And look straight at the camera again")
                    } else if (backInMiddle) {
                        // The same way as the first turn: whichever of the two went the wrong way, the other way is the one left.
                        set(phase, "Not that way: turn your head the other way", wrongWay = true)
                    }
                }
                else -> {}
            }
        }
    }
}
