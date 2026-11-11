package eu.drivezzz.app.features.checks

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.PointF
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.face.FaceLandmark
import java.nio.ByteBuffer
import kotlin.math.sqrt

// Comparing two faces on the phone: the photo in an ID's chip and a selfie. Neither leaves the phone; only the score is sent. As
// FaceMatch.swift: ML Kit finds the face and its eyes, nose and mouth; the face is turned and scaled so those sit where the model
// expects (112 × 112, ArcFace's five points), and SFace (OpenCV Zoo, Apache-2.0, assets/SFace-LICENSE.txt) turns it into 128 numbers.
// Two faces are compared by the cosine of their numbers: the same person usually 0.4 to 0.8, two people under 0.3. The server decides
// what passes (rules.faceAutoMatch). The same weights as the iPhone's, in 16 bits, run by SFace.kt.
sealed class FaceMatchError(message: String) : Exception(message) {
    class NoFace : FaceMatchError("No face found.")
    class ManyFaces : FaceMatchError("More than one face: only you in the picture.")
    class Model : FaceMatchError("The face check couldn’t start. Update Drivezzz.")
}

class FaceMatcher private constructor(private val context: Context) {
    companion object {
        const val MODEL_NAME = "sface-2021dec-fp16"
        // What the server takes as the same person (rules.faceAutoMatch in server/src/config.js): only for what the result screen
        // says. The server decides.
        const val SAME_PERSON = 0.40
        private const val SIDE = 112
        // Where SFace wants the eyes, the tip of the nose and the corners of the mouth, left to right as seen in the picture.
        private val template = arrayOf(
            PointF(38.2946f, 51.6963f), PointF(73.5318f, 51.5014f), PointF(56.0252f, 71.7366f),
            PointF(41.5493f, 92.3655f), PointF(70.7299f, 92.2041f),
        )
        @Volatile private var shared: FaceMatcher? = null
        fun get(context: Context): FaceMatcher = shared ?: synchronized(this) { shared ?: FaceMatcher(context.applicationContext).also { shared = it } }

        fun cosine(a: FloatArray, b: FloatArray): Double {
            if (a.size != b.size || a.isEmpty()) return 0.0
            var dot = 0f
            var na = 0f
            var nb = 0f
            for (i in a.indices) {
                dot += a[i] * b[i]
                na += a[i] * a[i]
                nb += b[i] * b[i]
            }
            return if (na > 0 && nb > 0) (dot / (sqrt(na) * sqrt(nb))).toDouble() else 0.0
        }
    }

    // A still picture, looked at closely: every landmark it can find.
    private val detector by lazy {
        FaceDetection.getClient(
            FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
                .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
                .setMinFaceSize(0.1f)
                .build()
        )
    }

    // Made when first used: loading it takes a moment, and it's 40 MB in memory, so it goes again when the check is done (`release`).
    private var net: SFace? = null

    @Synchronized
    private fun model(): SFace {
        net?.let { return it }
        val made = try {
            SFace(ByteBuffer.wrap(context.assets.open("$MODEL_NAME.bin").use { it.readBytes() }))
        } catch (_: Exception) {
            throw FaceMatchError.Model()
        }
        net = made
        return made
    }

    @Synchronized
    fun release() {
        net = null
    }

    // The 128 numbers of the biggest face in an upright picture. Blocking: off the main thread.
    fun features(image: Bitmap, onlyOne: Boolean = false): FloatArray {
        val faces = runCatching { Tasks.await(detector.process(InputImage.fromBitmap(image, 0))) }.getOrNull() ?: throw FaceMatchError.NoFace()
        if (onlyOne && faces.count { it.boundingBox.width() > 0.12f * image.width } > 1) throw FaceMatchError.ManyFaces()
        val face = faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() } ?: throw FaceMatchError.NoFace()
        val points = fivePoints(face) ?: throw FaceMatchError.NoFace()
        val aligned = align(image, points)
        val pixels = IntArray(SIDE * SIDE)
        aligned.getPixels(pixels, 0, SIDE, 0, 0, SIDE, SIDE)
        // The face and its mirror image together (as face recognition is usually measured): the same numbers whichever way round a
        // picture is, and steadier for a face lit from one side. As FaceMatch.swift, where the selfie is mirrored.
        val straight = embed(pixels, mirrored = false)
        val mirror = embed(pixels, mirrored = true)
        val v = FloatArray(straight.size) { straight[it] + mirror[it] }
        val norm = sqrt(v.fold(0f) { s, x -> s + x * x })
        return if (norm > 0) FloatArray(v.size) { v[it] / norm } else v
    }

    // SFace's 128 numbers for an aligned face (112 × 112), as it is or mirrored left to right.
    private fun embed(pixels: IntArray, mirrored: Boolean): FloatArray {
        val plane = SIDE * SIDE
        val input = FloatArray(3 * plane)
        for (y in 0 until SIDE) for (x in 0 until SIDE) {
            val p = pixels[y * SIDE + if (mirrored) SIDE - 1 - x else x]
            val i = y * SIDE + x
            input[i] = ((p shr 16) and 0xFF).toFloat() // red
            input[plane + i] = ((p shr 8) and 0xFF).toFloat() // green
            input[2 * plane + i] = (p and 0xFF).toFloat() // blue
        }
        return model().run(input)
    }

    // Eyes, nose and mouth corners in pixels from the top left, left to right as seen.
    private fun fivePoints(face: Face): Array<PointF>? {
        val a = face.getLandmark(FaceLandmark.LEFT_EYE)?.position ?: return null
        val b = face.getLandmark(FaceLandmark.RIGHT_EYE)?.position ?: return null
        val nose = face.getLandmark(FaceLandmark.NOSE_BASE)?.position ?: return null
        val m1 = face.getLandmark(FaceLandmark.MOUTH_LEFT)?.position ?: return null
        val m2 = face.getLandmark(FaceLandmark.MOUTH_RIGHT)?.position ?: return null
        val (leftEye, rightEye) = if (a.x < b.x) a to b else b to a
        val (left, right) = if (m1.x < m2.x) m1 to m2 else m2 to m1
        return arrayOf(leftEye, rightEye, nose, left, right)
    }

    // The face, turned and scaled onto the template: a least-squares turn, scale and shift (no stretching), 112 × 112.
    private fun align(image: Bitmap, src: Array<PointF>): Bitmap {
        val n = src.size.toFloat()
        val msx = src.sumOf { it.x.toDouble() }.toFloat() / n
        val msy = src.sumOf { it.y.toDouble() }.toFloat() / n
        val mdx = template.sumOf { it.x.toDouble() }.toFloat() / n
        val mdy = template.sumOf { it.y.toDouble() }.toFloat() / n
        var num1 = 0f
        var num2 = 0f
        var den = 0f
        for (i in src.indices) {
            val xs = src[i].x - msx
            val ys = src[i].y - msy
            val xd = template[i].x - mdx
            val yd = template[i].y - mdy
            num1 += xs * xd + ys * yd
            num2 += xs * yd - ys * xd
            den += xs * xs + ys * ys
        }
        if (den <= 0) throw FaceMatchError.NoFace()
        val a = num1 / den
        val b = num2 / den
        val m = Matrix().apply {
            setValues(floatArrayOf(a, -b, mdx - (a * msx - b * msy), b, a, mdy - (b * msx + a * msy), 0f, 0f, 1f))
        }
        val out = Bitmap.createBitmap(SIDE, SIDE, Bitmap.Config.ARGB_8888)
        Canvas(out).drawBitmap(image, m, Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG))
        return out
    }
}
