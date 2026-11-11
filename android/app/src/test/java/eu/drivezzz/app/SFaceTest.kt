package eu.drivezzz.app

import eu.drivezzz.app.features.checks.FaceMatcher
import eu.drivezzz.app.features.checks.SFace
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer

// The face match's network in Kotlin against ONNX Runtime running OpenCV Zoo's own SFace on the same made-up picture
// (android/tools/sface-weights.py wrote both the weights and the answer). The weights are in 16 bits, as on the iPhone, so the
// numbers differ a little, and what counts is the angle between them: a cosine of 1 is the same.
class SFaceTest {
    @Test fun sameAsOnnxRuntime() {
        val net = SFace(ByteBuffer.wrap(File("src/main/assets/sface-2021dec-fp16.bin").readBytes()))
        val side = 112
        val picture = FloatArray(3 * side * side)
        for (c in 0 until 3) for (y in 0 until side) for (x in 0 until side) picture[c * side * side + y * side + x] = ((x * 7 + y * 13 + c * 31) % 256).toFloat()
        val started = System.nanoTime()
        val ours = net.run(picture)
        val ms = (System.nanoTime() - started) / 1_000_000
        val theirs = javaClass.classLoader!!.getResource("sface-reference.txt").readText().trim().split(" ").map { it.toFloat() }.toFloatArray()
        val cosine = FaceMatcher.cosine(ours, theirs)
        println("SFace in Kotlin: cosine $cosine with ONNX Runtime, $ms ms")
        assertTrue("cosine $cosine", cosine > 0.999)
    }
}
