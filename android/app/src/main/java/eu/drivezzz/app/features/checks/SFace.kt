package eu.drivezzz.app.features.checks

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.stream.IntStream

// SFace (OpenCV Zoo, Apache-2.0) in plain Kotlin: 27 convolutions, each with a PReLU, and one fully connected layer at the end,
// from 112 × 112 × 3 to 128 numbers. The weights are the iPhone's, in 16 bits, with each batch norm folded in by
// android/tools/sface-weights.py, which also says what's in the file. ONNX Runtime would add 33 MB for each kind of processor for
// this alone. About 570 million multiplications a face, spread over the phone's cores; SFaceTest checks it against ONNX Runtime.
class SFace(data: ByteBuffer) {
    private class Conv(
        val cin: Int, val cout: Int, val k: Int, val stride: Int, val pad: Int, val groups: Int,
        val w: FloatArray, val bias: FloatArray, val slope: FloatArray,
    )

    private val offset: Float
    private val scale: Float
    private val convs: List<Conv>
    private val fcIn: Int
    private val fcOut: Int
    private val fcW: FloatArray
    private val fcB: FloatArray

    init {
        val b = data.order(ByteOrder.LITTLE_ENDIAN)
        val magic = ByteArray(4).also { b.get(it) }
        require(String(magic) == "SFC1") { "not an SFace file" }
        offset = b.float
        scale = b.float
        val n = b.int
        convs = List(n) {
            val cin = b.int
            val cout = b.int
            val k = b.int
            val stride = b.int
            val pad = b.int
            val groups = b.int
            Conv(cin, cout, k, stride, pad, groups, halves(b, cout * (cin / groups) * k * k), floats(b, cout), floats(b, cout))
        }
        fcIn = b.int
        fcOut = b.int
        fcW = halves(b, fcIn * fcOut)
        fcB = floats(b, fcOut)
    }

    // `rgb`: red, green and blue planes of 112 × 112, each 0 to 255, rows from the top.
    fun run(rgb: FloatArray): FloatArray {
        var side = 112
        var x = FloatArray(rgb.size) { (rgb[it] - offset) * scale }
        for (c in convs) {
            val out = (side + 2 * c.pad - c.k) / c.stride + 1
            x = when {
                c.groups == 1 && c.k == 1 -> pointwise(c, x, side)
                c.groups == c.cin && c.groups == c.cout -> depthwise(c, x, side, out)
                else -> full(c, x, side, out)
            }
            side = out
        }
        val y = FloatArray(fcOut)
        IntStream.range(0, fcOut).parallel().forEach { o ->
            val row = o * fcIn
            var acc = fcB[o]
            for (i in 0 until fcIn) acc += fcW[row + i] * x[i]
            y[o] = acc
        }
        return y
    }

    // 1 × 1: every output channel a weighted sum of all input channels, spot by spot.
    private fun pointwise(c: Conv, x: FloatArray, side: Int): FloatArray {
        val area = side * side
        val y = FloatArray(c.cout * area)
        IntStream.range(0, c.cout).parallel().forEach { o ->
            val base = o * area
            val b = c.bias[o]
            for (p in 0 until area) y[base + p] = b
            val row = o * c.cin
            for (i in 0 until c.cin) {
                val wv = c.w[row + i]
                if (wv == 0f) continue
                val src = i * area
                for (p in 0 until area) y[base + p] += wv * x[src + p]
            }
            prelu(y, base, area, c.slope[o])
        }
        return y
    }

    // 3 × 3, each channel by itself.
    private fun depthwise(c: Conv, x: FloatArray, side: Int, out: Int): FloatArray {
        val y = FloatArray(c.cout * out * out)
        val k = c.k
        IntStream.range(0, c.cout).parallel().forEach { ch ->
            val src = ch * side * side
            val dst = ch * out * out
            val wb = ch * k * k
            for (oy in 0 until out) for (ox in 0 until out) {
                var sum = c.bias[ch]
                for (ky in 0 until k) {
                    val iy = oy * c.stride - c.pad + ky
                    if (iy < 0 || iy >= side) continue
                    for (kx in 0 until k) {
                        val ix = ox * c.stride - c.pad + kx
                        if (ix < 0 || ix >= side) continue
                        sum += c.w[wb + ky * k + kx] * x[src + iy * side + ix]
                    }
                }
                y[dst + oy * out + ox] = sum
            }
            prelu(y, dst, out * out, c.slope[ch])
        }
        return y
    }

    // The first layer: 3 × 3 over all of the picture's three colours.
    private fun full(c: Conv, x: FloatArray, side: Int, out: Int): FloatArray {
        val y = FloatArray(c.cout * out * out)
        val k = c.k
        val per = c.cin / c.groups
        val outsPerGroup = c.cout / c.groups
        IntStream.range(0, c.cout).parallel().forEach { o ->
            val g = o / outsPerGroup
            val dst = o * out * out
            for (oy in 0 until out) for (ox in 0 until out) {
                var sum = c.bias[o]
                for (i in 0 until per) {
                    val src = (g * per + i) * side * side
                    val wb = (o * per + i) * k * k
                    for (ky in 0 until k) {
                        val iy = oy * c.stride - c.pad + ky
                        if (iy < 0 || iy >= side) continue
                        for (kx in 0 until k) {
                            val ix = ox * c.stride - c.pad + kx
                            if (ix < 0 || ix >= side) continue
                            sum += c.w[wb + ky * k + kx] * x[src + iy * side + ix]
                        }
                    }
                }
                y[dst + oy * out + ox] = sum
            }
            prelu(y, dst, out * out, c.slope[o])
        }
        return y
    }

    private fun prelu(y: FloatArray, from: Int, count: Int, slope: Float) {
        for (p in from until from + count) if (y[p] < 0f) y[p] *= slope
    }

    private companion object {
        fun floats(b: ByteBuffer, n: Int) = FloatArray(n) { b.float }
        fun halves(b: ByteBuffer, n: Int) = FloatArray(n) { half(b.short.toInt() and 0xFFFF) }

        // IEEE 754 half to float: Android's own Half isn't there in tests on the Mac.
        fun half(h: Int): Float {
            val sign = (h ushr 15) and 1
            val exp = (h ushr 10) and 0x1F
            val mant = h and 0x3FF
            val bits = when {
                exp == 0 && mant == 0 -> sign shl 31
                exp == 0 -> { // subnormal: mant × 2^-24, made normal
                    var e = -14
                    var m = mant
                    while (m and 0x400 == 0) {
                        m = m shl 1
                        e--
                    }
                    (sign shl 31) or ((e + 127) shl 23) or ((m and 0x3FF) shl 13)
                }
                exp == 31 -> (sign shl 31) or (0xFF shl 23) or (mant shl 13)
                else -> (sign shl 31) or ((exp - 15 + 127) shl 23) or (mant shl 13)
            }
            return java.lang.Float.intBitsToFloat(bits)
        }
    }
}
