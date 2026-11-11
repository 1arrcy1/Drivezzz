package eu.drivezzz.app.features.checks

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.nfc.NfcAdapter
import android.nfc.Tag
import android.nfc.TagLostException
import android.nfc.tech.IsoDep
import android.util.Log
import net.sf.scuba.smartcards.CardServiceException
import net.sf.scuba.smartcards.IsoDepCardService
import org.bouncycastle.jce.provider.BouncyCastleProvider
import org.jmrtd.BACKey
import org.jmrtd.PassportService
import org.jmrtd.lds.CardAccessFile
import org.jmrtd.lds.PACEInfo
import org.jmrtd.lds.icao.DG15File
import org.jmrtd.lds.icao.DG2File
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.security.Security

// What the chip gave: the state's signed list (SOD), DG1 (who), DG15 (the chip's own key, when it has one) with its signature over
// our challenge, and the photo (DG2), which never leaves the phone: it's only for the face match. As ChipReader.swift.
class ChipRead(val sod: ByteArray, val dg1: ByteArray, val dg15: ByteArray?, val aaSignature: ByteArray?, val photo: Bitmap?)

sealed class ChipError(message: String?) : Exception(message) {
    class NotHere : ChipError("This phone can’t read chips: it has no NFC.")
    class Off : ChipError("NFC is off. Turn it on in Settings, then try again.")
    class WrongKey : ChipError("These details don’t open the chip. Check the document number and both dates.")
    class Lost : ChipError("The chip was lost before it was read. Hold the phone still against it and try again.")
    class Unreadable : ChipError("This chip couldn’t be read. Try again, or try your other document.")
}

object ChipReader {
    fun adapter(activity: Activity): NfcAdapter? = NfcAdapter.getDefaultAdapter(activity)
    fun available(activity: Activity): Boolean = adapter(activity) != null

    // Listening for an ID's chip all the while the ID step is on screen, not only while the reading sheet is up: a card near the
    // phone at any other moment there (before Read ID, held close for the camera, or still on the phone after a read) went to
    // Android, which said it had no app for it. Now it's ours, and nothing happens: only a card that comes while Read ID waits is
    // read. The answer comes on a thread of NFC's own, where reading the chip can take its time.
    //
    // A chip is only ever read there, in the moment Android hands it over. Once that moment has passed, Android checks every second
    // whether the card is still there, and those checks land in the middle of the chip's encrypted conversation: a build that read
    // a card kept from earlier failed, and then waited for ever for a card that never left the phone.
    private val lock = Any()
    private var waiting: ((Tag) -> Unit)? = null
    // Who listens now: the ID step on screen. One that's going away (a screen sliding out while a new one comes in) mustn't stop the
    // new one listening.
    private var owner: Any? = null

    // Listening, for `who`. Also each time the app comes back to the screen: Android stops reader mode whenever it leaves (it only
    // works while the app is in front), and a Read ID that was waiting then still gets the card.
    fun hold(activity: Activity, who: Any? = owner) {
        synchronized(lock) { owner = who }
        val flags = NfcAdapter.FLAG_READER_NFC_A or NfcAdapter.FLAG_READER_NFC_B or NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK or NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS
        runCatching {
            adapter(activity)?.enableReaderMode(activity, { tag ->
                val read = synchronized(lock) { waiting.also { waiting = null } }
                Log.i(TAG, if (read != null) "A card: reading it" else "A card, but Read ID isn't waiting: left alone")
                read?.invoke(tag)
            }, flags, android.os.Bundle().apply { putInt(NfcAdapter.EXTRA_READER_PRESENCE_CHECK_DELAY, 1000) })
        }
    }

    fun release(activity: Activity, who: Any?) {
        synchronized(lock) {
            if (owner !== who) return
            owner = null
            waiting = null
        }
        runCatching { adapter(activity)?.disableReaderMode(activity) }
    }

    // Read the next card. Listening starts again, so Android hands over a card that's already on the phone once more (it only does
    // that when a card comes): tapping Read ID with the ID under the phone, or again after a read that failed, needs no lifting.
    // On the main thread.
    fun next(activity: Activity, onTag: (Tag) -> Unit) {
        synchronized(lock) { waiting = onTag }
        Log.i(TAG, "Waiting for a card")
        runCatching { adapter(activity)?.disableReaderMode(activity) }
        hold(activity)
    }

    // The sheet closed: a card that comes now isn't read.
    fun cancel() {
        synchronized(lock) { waiting = null }
    }

    // Only what's needed: not DG11 or DG12, which can hold the BSN or an address. Blocking: on NFC's thread, never the main one.
    fun read(tag: Tag, key: MrzKey, challenge: ByteArray, show: (String) -> Unit): ChipRead {
        // Each step in the log as well (adb logcat -s ChipReader): where a read stops, never what it read.
        fun progress(step: String) {
            Log.i(TAG, step)
            show(step)
        }
        // Android's own Bouncy Castle is cut down; JMRTD needs all of it for PACE and the chip's signatures.
        if (Security.getProvider("BC")?.javaClass?.name != BouncyCastleProvider::class.java.name) {
            Security.removeProvider("BC")
            Security.insertProviderAt(BouncyCastleProvider(), 1)
        }
        val iso = IsoDep.get(tag) ?: throw ChipError.Unreadable()
        try {
            // Connected first: the timeout is the connection's, and reading the photo takes a few seconds. Not connecting means the
            // card isn't there (any more).
            try {
                if (!iso.isConnected) iso.connect()
            } catch (e: java.io.IOException) {
                throw ChipError.Lost()
            }
            iso.timeout = 10_000
            val card = IsoDepCardService(iso)
            card.open()
            val service = PassportService(card, PassportService.NORMAL_MAX_TRANCEIVE_LENGTH, PassportService.DEFAULT_MAX_BLOCKSIZE, false, false)
            service.open()
            progress("Opening the chip…")
            val access = BACKey(key.number, key.birth, key.expiry)
            // PACE where the chip offers it, BAC otherwise: newer chips may only do PACE, older ones only BAC.
            var paced = false
            var paceRefused = false
            try {
                val cardAccess = CardAccessFile(service.getInputStream(PassportService.EF_CARD_ACCESS, PassportService.DEFAULT_MAX_BLOCKSIZE))
                for (info in cardAccess.securityInfos) {
                    if (info is PACEInfo) {
                        service.doPACE(access, info.objectIdentifier, PACEInfo.toParameterSpec(info.parameterId), null)
                        paced = true
                        Log.i(TAG, "Opened with PACE")
                        break
                    }
                }
            } catch (e: Exception) {
                if (isLost(e)) throw ChipError.Lost()
                // No PACE here, or it didn't open: BAC next. A chip that only does PACE also refuses BAC, so whether this was the
                // chip saying no to the key is kept for then.
                paceRefused = refusedKey(e)
                Log.w(TAG, "PACE didn't open the chip", e)
            }
            service.sendSelectApplet(paced)
            if (!paced) {
                try {
                    service.doBAC(access)
                    Log.i(TAG, "Opened with BAC")
                } catch (e: CardServiceException) {
                    if (isLost(e)) throw ChipError.Lost()
                    Log.w(TAG, "BAC didn't open the chip", e)
                    // Only the chip saying no means the details are wrong. Anything else (the phone's own crypto failing, as it did
                    // when a release build had lost Bouncy Castle's algorithms) isn't the driver's to fix by checking dates.
                    if (!phoneSide(e) && (refusedKey(e) || paceRefused)) throw ChipError.WrongKey()
                    throw ChipError.Unreadable()
                }
            }
            progress("Reading… 10%")
            val sod = readAll(service.getInputStream(PassportService.EF_SOD, PassportService.DEFAULT_MAX_BLOCKSIZE))
            progress("Reading… 25%")
            val dg1 = readAll(service.getInputStream(PassportService.EF_DG1, PassportService.DEFAULT_MAX_BLOCKSIZE))
            progress("Reading… 35%")
            val dg15 = runCatching { readAll(service.getInputStream(PassportService.EF_DG15, PassportService.DEFAULT_MAX_BLOCKSIZE)) }.getOrNull()?.takeIf { it.isNotEmpty() }
            // Active authentication: the chip signs our challenge with the key in DG15, so it's the chip and not a copy of its data.
            var signature: ByteArray? = null
            if (dg15 != null) {
                progress("Checking the chip…")
                signature = runCatching {
                    val publicKey = DG15File(ByteArrayInputStream(dg15)).publicKey
                    val ec = publicKey.algorithm.contains("EC", ignoreCase = true)
                    service.doAA(publicKey, if (ec) "SHA-256" else "SHA-1", if (ec) "SHA256withECDSA" else "SHA1WithRSA/ISO9796-2", challenge).response
                }.getOrNull()?.takeIf { it.isNotEmpty() }
            }
            progress("Reading your photo… 50%")
            val photo = runCatching { photo(DG2File(service.getInputStream(PassportService.EF_DG2, PassportService.DEFAULT_MAX_BLOCKSIZE))) }.getOrNull()
            progress("Done.")
            return ChipRead(sod, dg1, dg15, signature, photo)
        } catch (e: ChipError) {
            throw e
        } catch (e: TagLostException) {
            throw ChipError.Lost()
        } catch (e: Exception) {
            if (isLost(e)) throw ChipError.Lost()
            Log.w(TAG, "The chip couldn't be read", e)
            throw ChipError.Unreadable()
        } finally {
            runCatching { iso.close() }
        }
    }

    // What failed is said in the log, never what opened it: no number, no dates.
    private const val TAG = "ChipReader"

    // The chip turning the key down: "authentication failed" (63 00, or 63 Cx with tries left) or "security status not satisfied"
    // (69 82), as BAC's mutual authentication and PACE's last step answer a wrong number or date.
    private fun refusedKey(e: Throwable): Boolean {
        var t: Throwable? = e
        while (t != null) {
            if (t is CardServiceException) {
                val sw = t.sw
                if (sw == 0x6300 || sw and 0xFFF0 == 0x63C0 || sw == 0x6982) return true
                if (t.message?.contains("MUTUAL AUTH") == true || t.message?.contains("authentication token") == true) return true
            }
            t = t.cause
        }
        return false
    }

    // The phone's own crypto failing, not the chip: an algorithm or key that couldn't be made.
    private fun phoneSide(e: Throwable): Boolean {
        var t: Throwable? = e
        while (t != null) {
            if (t is java.security.GeneralSecurityException) return true
            t = t.cause
        }
        return false
    }

    private fun isLost(e: Throwable): Boolean {
        var t: Throwable? = e
        while (t != null) {
            if (t is TagLostException || t is java.io.IOException && t.message?.contains("lost", true) == true) return true
            t = t.cause
        }
        return false
    }

    private fun readAll(stream: InputStream): ByteArray = stream.use { it.readBytes() }

    private fun photo(dg2: DG2File): Bitmap? {
        val image = dg2.faceInfos.flatMap { it.faceImageInfos }.firstOrNull() ?: return null
        val bytes = readAll(image.imageInputStream)
        return if (image.mimeType?.contains("jp2") == true || image.mimeType?.contains("jpeg2000") == true || bytes.isJpeg2000) Jpeg2000.decode(bytes)
        else BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
    }

    private val ByteArray.isJpeg2000: Boolean
        get() = size > 12 && ((this[0] == 0x00.toByte() && this[4] == 0x6A.toByte() && this[5] == 0x50.toByte()) || (this[0] == 0xFF.toByte() && this[1] == 0x4F.toByte()))
}

// Most chips keep the photo in JPEG 2000, which Android can't show by itself. JJ2000 (Apache-2.0) decodes it, in Java.
object Jpeg2000 {
    fun decode(bytes: ByteArray): Bitmap? = runCatching {
        val defaults = jj2000.j2k.util.ParameterList()
        for (p in jj2000.j2k.decoder.Decoder.getAllParameters()) if (p[3] != null) defaults[p[0]] = p[3]
        val pl = jj2000.j2k.util.ParameterList(defaults)
        val input = jj2000.j2k.util.ISRandomAccessIO(ByteArrayInputStream(bytes), bytes.size, 1, bytes.size)
        val ff = jj2000.j2k.fileformat.reader.FileFormatReader(input)
        ff.readFileFormat()
        if (ff.JP2FFUsed) input.seek(ff.firstCodeStreamPos)
        val hi = jj2000.j2k.codestream.HeaderInfo()
        val hd = jj2000.j2k.codestream.reader.HeaderDecoder(input, pl, hi)
        val comps = hd.numComps
        val specs = hd.decoderSpecs
        val depth = IntArray(comps) { hd.getOriginalBitDepth(it) }
        val reader = jj2000.j2k.codestream.reader.BitstreamReaderAgent.createInstance(input, hd, pl, specs, false, hi)
        val entropy = hd.createEntropyDecoder(reader, pl)
        val roi = hd.createROIDeScaler(entropy, pl, specs)
        val dequantizer = hd.createDequantizer(roi, depth, specs)
        val wavelet = jj2000.j2k.wavelet.synthesis.InverseWT.createInstance(dequantizer, specs)
        wavelet.setImgResLevel(reader.imgRes)
        val converter = jj2000.j2k.image.ImgDataConverter(wavelet, 0)
        val src = jj2000.j2k.image.invcomptransf.InvCompTransf(converter, specs, depth, pl)
        val w = src.imgWidth
        val h = src.imgHeight
        val pixels = IntArray(w * h)
        val planes = Array(minOf(comps, 3)) { IntArray(w * h) }
        val tiles = src.getNumTiles(null)
        for (ty in 0 until tiles.y) for (tx in 0 until tiles.x) {
            src.setTile(tx, ty)
            val tile = src.tileIdx
            for (c in planes.indices) {
                val bits = src.getNomRangeBits(c)
                val shift = 1 shl (bits - 1)
                val max = (1 shl bits) - 1
                val fixed = src.getFixedPoint(c)
                val tw = src.getTileCompWidth(tile, c)
                val th = src.getTileCompHeight(tile, c)
                val ulx = src.getCompULX(c) - Math.ceil(src.imgULX / src.getCompSubsX(c).toDouble()).toInt()
                val uly = src.getCompULY(c) - Math.ceil(src.imgULY / src.getCompSubsY(c).toDouble()).toInt()
                val blk = jj2000.j2k.image.DataBlkInt()
                for (row in 0 until th) {
                    blk.ulx = ulx
                    blk.uly = uly + row
                    blk.w = tw
                    blk.h = 1
                    val got = src.getInternCompData(blk, c) as jj2000.j2k.image.DataBlkInt
                    val y = uly + row
                    if (y !in 0 until h) continue
                    for (col in 0 until tw) {
                        val x = ulx + col
                        if (x !in 0 until w) continue
                        val v = ((got.data[got.offset + col] shr fixed) + shift).coerceIn(0, max)
                        planes[c][y * w + x] = if (bits == 8) v else v * 255 / max
                    }
                }
            }
        }
        for (i in pixels.indices) {
            val r = planes[0][i]
            val g = if (planes.size >= 3) planes[1][i] else r
            val b = if (planes.size >= 3) planes[2][i] else r
            pixels[i] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
        }
        Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888)
    }.getOrNull()
}
