package eu.drivezzz.app.core

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

object Fmt {
    fun eur(cents: Int?): String = if (cents == null) "–" else String.format(Locale.US, "€%.2f", cents / 100.0)

    fun rate(cents: Int?): String = eur(cents)

    // How long the line for the Solana network is, in words (ChainQueueNote).
    fun queueWait(seconds: Int): String {
        if (seconds < 60) return "$seconds seconds"
        val minutes = (seconds + 59) / 60
        return if (minutes == 1) "a minute" else "$minutes minutes"
    }

    fun km(metres: Int?): String {
        if (metres == null) return "–"
        if (metres < 1000) return "$metres m"
        return String.format(Locale.US, "%.1f km", metres / 1000.0)
    }

    fun minutes(seconds: Int?): String {
        if (seconds == null) return "–"
        val m = max(1, (seconds / 60.0).roundToInt())
        if (m < 60) return "$m min"
        return "${m / 60} h ${m % 60} min"
    }

    private val zone: ZoneId get() = ZoneId.systemDefault()

    fun time(ms: Double): String =
        DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(Locale.getDefault()).format(Instant.ofEpochMilli(ms.toLong()).atZone(zone))

    fun dayTime(ms: Double): String {
        val at = Instant.ofEpochMilli(ms.toLong()).atZone(zone)
        val today = LocalDate.now(zone)
        return when (at.toLocalDate()) {
            today -> "Today ${time(ms)}"
            today.plusDays(1) -> "Tomorrow ${time(ms)}"
            else -> DateTimeFormatter.ofPattern("EEE d MMM, ", Locale.getDefault()).format(at) + time(ms)
        }
    }

    fun weekdayDayMonth(ms: Double): String =
        DateTimeFormatter.ofPattern("EEE d MMM", Locale.getDefault()).format(Instant.ofEpochMilli(ms.toLong()).atZone(zone))

    fun dayMonth(ms: Double): String =
        DateTimeFormatter.ofPattern("d MMM", Locale.getDefault()).format(Instant.ofEpochMilli(ms.toLong()).atZone(zone))

    // Today, Tomorrow, Yesterday, or the day written out: the agenda's headers.
    fun dayTitle(day: LocalDate): String {
        val today = LocalDate.now(zone)
        return when (day) {
            today -> "Today"
            today.plusDays(1) -> "Tomorrow"
            today.minusDays(1) -> "Yesterday"
            else -> DateTimeFormatter.ofPattern("EEEE d MMMM", Locale.getDefault()).format(day)
        }
    }

    fun localDay(ms: Double): LocalDate = Instant.ofEpochMilli(ms.toLong()).atZone(zone).toLocalDate()

    fun stopwatch(seconds: Int): String =
        String.format(Locale.US, "%02d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)

    fun clock(seconds: Int): String = String.format(Locale.US, "%d:%02d", seconds / 60, seconds % 60)

    fun rating(rating: Double?, count: Int?): String {
        if (rating == null || count == null || count <= 0) return "New"
        return String.format(Locale.US, "%.1f (%d)", rating, count)
    }

    fun shortAddress(address: String?): String {
        if (address == null || address.length <= 14) return address ?: ""
        return "${address.take(6)}…${address.takeLast(6)}"
    }

    fun amount(text: String?, symbol: String?): String = "${text ?: "0"} ${symbol ?: ""}"

    // What a ride comes to in its coin, to read at a glance: SOL to 5 decimals and USDC to cents, rounded up, so it's never less than
    // what the wallet asks. As Format.swift.
    fun coinAmount(text: String?, coin: String?): String {
        val value = text?.toBigDecimalOrNull() ?: return amount(text, coinSymbol(coin))
        val places = if (coin == "sol") 5 else 2
        var shown = value.setScale(places, java.math.RoundingMode.UP).stripTrailingZeros()
        if (shown.scale() < 2) shown = shown.setScale(2)
        return "${shown.toPlainString()} ${coinSymbol(coin)}"
    }

    // A coin's price in euros, like €174.12.
    fun eurPrice(eur: Double?): String = if (eur == null) "–" else String.format(Locale.US, "€%.2f", eur)

    fun people(n: Int?): String = if ((n ?: 1) == 1) "1 person" else "${n ?: 1} people"

    fun coinSymbol(id: String?): String = when (id) {
        "usdc-sol" -> "USDC"
        "sol" -> "SOL"
        "cash" -> "Cash"
        "xrp" -> "XRP"
        "ltc" -> "LTC"
        "xlm" -> "XLM"
        else -> id?.uppercase() ?: ""
    }

    fun coinName(id: String?): String = if (id == "usdc-sol") "USDC on Solana" else coinSymbol(id)
}

fun String.capitalized(): String = replaceFirstChar { it.uppercase() }

// A car, a motor or a scooter.
object Vehicle {
    val all = listOf("car", "motor", "scooter")
    fun name(kind: String?): String = (kind ?: "car").capitalized()

    // "Only check in when you're in the car."
    fun riding(kind: String?): String = when (kind) {
        "motor" -> "on the motor"
        "scooter" -> "on the scooter"
        else -> "in the car"
    }
}

data class LatLng(val lat: Double, val lng: Double)

// Google's polyline format, as the server sends routes.
object Polyline {
    fun decode(text: String?): List<LatLng> {
        if (text == null) return emptyList()
        val bytes = text.toByteArray(Charsets.UTF_8)
        val out = ArrayList<LatLng>()
        var i = 0
        var lat = 0
        var lng = 0
        fun next(): Int {
            var shift = 0
            var result = 0
            var b: Int
            do {
                if (i >= bytes.size) return 0
                b = (bytes[i].toInt() and 0xFF) - 63
                i++
                result = result or ((b and 0x1F) shl shift)
                shift += 5
            } while (b >= 0x20)
            return if (result and 1 != 0) (result shr 1).inv() else result shr 1
        }
        while (i < bytes.size) {
            lat += next()
            lng += next()
            out.add(LatLng(lat / 1e5, lng / 1e5))
        }
        return out
    }
}

// The coins Drivezzz uses. An old ride can still say XRP, LTC or XLM; nothing else shows them, whatever a server still lists.
object Coins {
    val used = listOf("usdc-sol", "sol")
    // Not a coin: it goes from rider to driver in the car, and has a ride's `coin` to itself.
    const val cash = "cash"
    val payWith = listOf(cash, "sol", "usdc-sol")
}

// The little Markdown the server's agreement uses: **bold** and [links](https://…), the one inside the other if need be. A pair that
// isn't closed is just text, so nothing a page says can make words disappear.
object Markdown {
    data class Span(val text: String, val bold: Boolean = false, val url: String? = null)

    private val mark = Regex("""\*\*(.+?)\*\*|\[([^\]]+)]\(([^)\s]+)\)""")

    fun spans(text: String, bold: Boolean = false): List<Span> {
        val out = ArrayList<Span>()
        var at = 0
        for (m in mark.findAll(text)) {
            if (m.range.first > at) out += Span(text.substring(at, m.range.first), bold)
            val inside = m.groups[1]?.value
            if (inside != null) out += spans(inside, bold = true) else out += Span(m.groupValues[2], bold, m.groupValues[3])
            at = m.range.last + 1
        }
        if (at < text.length) out += Span(text.substring(at), bold)
        return out
    }
}
