package eu.drivezzz.app.features.checks

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.time.LocalDate
import kotlin.coroutines.resume

// Text in a picture, read on the phone with ML Kit's model inside the app: Vision on iOS. Nothing of the picture leaves the phone for
// this. Made when it's first used: loading the model takes a moment.
object TextReader {
    private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

    suspend fun text(image: InputImage): Text? = suspendCancellableCoroutine { out ->
        recognizer.process(image)
            .addOnSuccessListener { out.resume(it) }
            .addOnFailureListener { out.resume(null) }
    }

    // The same, on a thread that may wait: the camera's own.
    fun textNow(image: InputImage): Text? = runCatching { com.google.android.gms.tasks.Tasks.await(recognizer.process(image)) }.getOrNull()

    // Every line of text in a picture.
    suspend fun lines(bitmap: Bitmap): List<String> =
        text(InputImage.fromBitmap(bitmap, 0))?.textBlocks?.flatMap { b -> b.lines.map { it.text } } ?: emptyList()

    suspend fun lines(jpeg: ByteArray): List<String> {
        val bitmap = withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(jpeg, 0, jpeg.size) } ?: return emptyList()
        return lines(bitmap)
    }

    // What's in a picture with where it is, for putting the pieces of one line together (MrzScan.lines).
    fun seen(text: Text, dx: Float = 0f, dy: Float = 0f): List<MrzScan.Seen> =
        text.textBlocks.flatMap { b -> b.lines }.mapNotNull { l ->
            val r = l.boundingBox ?: return@mapNotNull null
            MrzScan.Seen(l.text, r.left + dx, r.top + dy, r.right + dx, r.bottom + dy)
        }
}

// The chauffeurskaart or taxi permit: the text on it, and a guess at its number and the last date on it (the one it's valid until).
data class ReadDocument(val text: String, val number: String?, val validUntil: LocalDate?)

object DocumentReader {
    private val date = Regex("""(\d{2})[-./ ](\d{2})[-./ ](\d{4})""")

    suspend fun read(bitmap: Bitmap): ReadDocument {
        val text = TextReader.lines(bitmap).joinToString("\n")
        val dates = date.findAll(text).mapNotNull { m ->
            val (d, mo, y) = m.destructured
            if (mo.toInt() > 12) null else runCatching { LocalDate.of(y.toInt(), mo.toInt(), d.toInt()) }.getOrNull()
        }.toList()
        // The longest run of letters and digits that has at least five digits and isn't a date.
        val tokens = text.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }
        val number = tokens.filter { t -> t.count { it.isDigit() } >= 5 && t.length <= 20 }.maxByOrNull { it.length }
        return ReadDocument(text.take(3000), number?.uppercase(), dates.maxOrNull())
    }

    // Small enough to send, sharp enough to read.
    fun jpeg(image: Bitmap, longest: Int = 1600): ByteArray {
        val scale = minOf(1f, longest.toFloat() / maxOf(image.width, image.height))
        val sized = if (scale < 1f) Bitmap.createScaledBitmap(image, (image.width * scale).toInt(), (image.height * scale).toInt(), true) else image
        return ByteArrayOutputStream().use { out ->
            sized.compress(Bitmap.CompressFormat.JPEG, 75, out)
            out.toByteArray()
        }
    }

    // The part of a camera's upright picture that's in a frame on screen (left, top, width, height, then the screen's width and
    // height), with a little room around it: the picture fills the screen and has its edges cut off.
    fun cropped(picture: Bitmap, frame: FloatArray, room: Float = 0.06f): Bitmap {
        val (left, top, w, h) = listOf(frame[0], frame[1], frame[2], frame[3])
        val sw = frame[4]
        val sh = frame[5]
        if (w <= 1f || h <= 1f) return picture
        val scale = maxOf(sw / picture.width, sh / picture.height)
        val dx = (picture.width * scale - sw) / 2
        val dy = (picture.height * scale - sh) / 2
        val margin = h * room
        val x0 = ((left - margin + dx) / scale).toInt().coerceIn(0, picture.width - 1)
        val y0 = ((top - margin + dy) / scale).toInt().coerceIn(0, picture.height - 1)
        val x1 = ((left + w + margin + dx) / scale).toInt().coerceIn(x0 + 1, picture.width)
        val y1 = ((top + h + margin + dy) / scale).toInt().coerceIn(y0 + 1, picture.height)
        return Bitmap.createBitmap(picture, x0, y0, x1 - x0, y1 - y0)
    }

    fun rotated(bitmap: Bitmap, degrees: Int, mirrored: Boolean = false): Bitmap {
        if (degrees == 0 && !mirrored) return bitmap
        val m = Matrix().apply {
            postRotate(degrees.toFloat())
            if (mirrored) postScale(-1f, 1f)
        }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
    }
}
