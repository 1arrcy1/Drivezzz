package eu.drivezzz.app.features.checks

import java.time.LocalDate
import java.time.format.DateTimeFormatter

// The key that opens a passport or ID card chip: its document number, birth date and expiry, as in the MRZ (the two or three
// lines of letters and < at the bottom), each with its check digit (BAC or PACE, ICAO 9303). As MRZ.swift.
data class MrzKey(
    val documentNumber: String, // as printed, letters and digits
    val birth: String, // YYMMDD
    val expiry: String, // YYMMDD
) {
    val number: String get() = documentNumber.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }

    val key: String
        get() {
            val n = number
            val padded = if (n.length < 9) n + "<".repeat(9 - n.length) else n
            return padded + checkDigit(padded) + birth + checkDigit(birth) + expiry + checkDigit(expiry)
        }

    companion object {
        fun checkDigit(s: String): String {
            val weights = intArrayOf(7, 3, 1)
            var sum = 0
            s.uppercase().forEachIndexed { i, c ->
                val v = when (c) {
                    '<' -> 0
                    in '0'..'9' -> c - '0'
                    in 'A'..'Z' -> c.code - 55
                    else -> 0
                }
                sum += v * weights[i % 3]
            }
            return (sum % 10).toString()
        }

        // A day as the code writes it. A day has no time zone here, so it can't show a day off anywhere.
        private val yymmdd: DateTimeFormatter = DateTimeFormatter.ofPattern("yyMMdd")
        fun yymmdd(day: LocalDate): String = day.format(yymmdd)

        // The day a YYMMDD means. "65" is 1965 for a birth date, never 2065.
        fun date(yymmdd: String, past: Boolean): LocalDate? {
            if (yymmdd.length != 6) return null
            val n = yymmdd.toIntOrNull() ?: return null
            var year = 2000 + n / 10000
            if (past && year > LocalDate.now().year) year -= 100
            return runCatching { LocalDate.of(year, n / 100 % 100, n % 100) }.getOrNull()
        }
    }
}

// What the code on an ID says. The optional data, where older Dutch documents have the BSN, is never looked at: the chip doesn't
// need it, and a company may only use a BSN where a law allows it (docs/driver-checks-nl.md).
data class MrzRead(
    val number: String? = null,
    val birth: String? = null, // YYMMDD
    val expiry: String? = null, // YYMMDD
    val surname: String? = null,
    val givenNames: String? = null,
    val nationality: String? = null,
) {
    val hasKey: Boolean get() = number != null && birth != null && expiry != null
    val isEmpty: Boolean get() = this == MrzRead()
}

// One look at the lines: what it read, and which parts were a guess. A number that only fit its check digit with a look-alike
// swapped is one, and so is anything found only in text reading's second guesses. A guess can be right, but counts for less.
data class MrzLook(val read: MrzRead = MrzRead(), val guessed: Set<String> = emptySet())

// Reading the lines by their places, as ICAO 9303 lays them out: TD3 (passports, two lines of 44) and TD1 (ID cards, three of 30).
// A place only for digits gets the digit a look-alike stands for, and the check digits say whether that was right. Text reading
// loses and adds fillers (<), so nothing leans on a line's length.
object MrzScan {
    private val toDigit = mapOf('O' to '0', 'Q' to '0', 'D' to '0', 'I' to '1', 'L' to '1', 'Z' to '2', 'A' to '4', 'S' to '5', 'G' to '6', 'T' to '7', 'B' to '8')
    private val toLetter = mapOf('0' to 'O', '1' to 'I', '2' to 'Z', '4' to 'A', '5' to 'S', '6' to 'G', '7' to 'T', '8' to 'B')
    // In a document number, where letters and digits can both be: the ones the check digit can tell apart.
    private val lookAlikes = mapOf('O' to '0', '0' to 'O', 'Q' to '0', 'I' to '1', '1' to 'I', 'L' to '1', 'Z' to '2', '2' to 'Z', 'S' to '5', '5' to 'S', 'B' to '8', '8' to 'B')

    private fun isLetter(c: Char) = c in 'A'..'Z'
    private fun isDigitChar(c: Char) = c in '0'..'9'

    // Letters of other alphabets that look the same, which text reading sometimes gives for ours (an М in EMMA).
    private val sameLooking = mapOf(
        'А' to 'A', 'В' to 'B', 'Е' to 'E', 'К' to 'K', 'М' to 'M', 'Н' to 'H', 'О' to 'O', 'Р' to 'P', 'С' to 'C', 'Т' to 'T', 'Х' to 'X', 'У' to 'Y', 'І' to 'I',
        'а' to 'a', 'е' to 'e', 'о' to 'o', 'р' to 'p', 'с' to 'c', 'х' to 'x', 'к' to 'k',
        'Α' to 'A', 'Β' to 'B', 'Ε' to 'E', 'Ζ' to 'Z', 'Η' to 'H', 'Ι' to 'I', 'Κ' to 'K', 'Μ' to 'M', 'Ν' to 'N', 'Ο' to 'O', 'Ρ' to 'P', 'Τ' to 'T', 'Υ' to 'Y', 'Χ' to 'X',
    )

    // Ours: a look-alike from another alphabet as the letter it looks like, and a letter with an accent (Ą) without it.
    private fun latin(c: Char): Char {
        if (c.code < 128) return c
        sameLooking[c]?.let { return it }
        val plain = java.text.Normalizer.normalize(c.toString(), java.text.Normalizer.Form.NFD).filter { it.code < 128 }
        return if (plain.length == 1) plain[0] else c
    }

    // Every place stays a place, whatever text reading made of it: only capitals, digits and < are on a code, so anything else was
    // a <, and a blurry < comes out as a small c, e, k or x.
    fun clean(line: String): List<Char> {
        val out = ArrayList<Char>(line.length)
        for (c in line.map { latin(it) }) {
            when (c) {
                ' ' -> continue
                '«', '≪', '《' -> {
                    out.add('<')
                    out.add('<')
                }
                'Ø', 'ø' -> out.add('0')
                'c', 'e', 'k', 'x' -> out.add('<')
                else -> {
                    val upper = c.uppercaseChar()
                    out.add(if (isLetter(upper) || isDigitChar(upper)) upper else '<')
                }
            }
        }
        return out
    }

    private fun digit(c: Char): Char? = if (isDigitChar(c)) c else toDigit[c]

    private fun digits(part: List<Char>): String? {
        val mapped = part.mapNotNull { digit(it) }
        return if (mapped.size == part.size) String(mapped.toCharArray()) else null
    }

    private fun isDate(yymmdd: String): Boolean {
        val n = yymmdd.toIntOrNull() ?: return false
        return n / 100 % 100 in 1..12 && n % 100 in 1..31
    }

    // Dates a document can have: born before today, and valid until no longer than 15 years ago and no more than 12 years ahead
    // (an ID or passport is valid for 10). A misreading that slips past a check digit is mostly far outside that.
    private fun plausible(birth: String, expiry: String, today: LocalDate): Boolean {
        val born = MrzKey.date(birth, past = true) ?: return false
        val until = MrzKey.date(expiry, past = false) ?: return false
        return born.isBefore(today) && until.isAfter(born) && !until.isBefore(today.minusYears(15)) && !until.isAfter(today.plusYears(12))
    }

    private data class Dates(val at: Int, val birth: String, val expiry: String)

    // Birth date, its check digit, sex, expiry, its check digit: 15 places in a row, the same on a card and in a passport. Only where
    // they can be: at the start of a card's second line, or behind a passport's number and nationality (13 places in), with a
    // place or two for what text reading lost or added. The sex is M, F, X or <.
    private val datesAt = listOf(0, 1, 2) + (10..15)

    private fun dates(row: List<Char>, today: LocalDate): Dates? {
        if (row.size < 15) return null
        for (at in datesAt) {
            if (at + 15 > row.size) continue
            val birth = digits(row.subList(at, at + 6)) ?: continue
            val expiry = digits(row.subList(at + 8, at + 14)) ?: continue
            if (!isDate(birth) || !isDate(expiry)) continue
            if (digit(row[at + 6])?.toString() != MrzKey.checkDigit(birth)) continue
            if (digit(row[at + 14])?.toString() != MrzKey.checkDigit(expiry)) continue
            if (row[at + 7] !in "MFX<" || !plausible(birth, expiry, today)) continue
            return Dates(at, birth, expiry)
        }
        return null
    }

    // The number that fits its check digit: as read, or with one look-alike swapped, if only one such swap fits. More guessing than
    // that makes almost anything fit, and even one swap is a guess: a misread elsewhere can make the wrong swap fit by chance.
    // A Dutch number is two letters, six letters or digits and a digit, and never has an O.
    private fun number(part: List<Char>, check: Char, dutch: Boolean): Pair<String, Boolean>? {
        val c = digit(check)?.toString() ?: return null
        val read = part.toMutableList()
        if (dutch && read.size == 9) {
            for (i in read.indices) if (read[i] == 'O') read[i] = '0'
            for (i in 0..1) read[i] = toLetter[read[i]] ?: read[i]
            read[8] = digit(read[8]) ?: read[8]
        }
        fun fits(chars: List<Char>): Boolean {
            if (MrzKey.checkDigit(String(chars.toCharArray())) != c) return false
            return !dutch || (chars.size == 9 && isLetter(chars[0]) && isLetter(chars[1]) && isDigitChar(chars[8]) && 'O' !in chars && '<' !in chars)
        }
        val found = mutableListOf<List<Char>>()
        if (fits(read)) found.add(read)
        if (found.isEmpty()) {
            for (i in read.indices) {
                val other = lookAlikes[read[i]] ?: continue
                val swapped = read.toMutableList()
                swapped[i] = other
                if (fits(swapped)) found.add(swapped)
            }
        }
        if (found.size != 1) return null
        val number = String(found[0].toCharArray()).replace("<", "")
        return if (number.length >= 6) number to (found[0] != read) else null
    }

    // A card's first line: I<NLD, the number, its check digit. Text reading can lose the < after the I, so NLD says where it starts.
    private fun firstLine(row: List<Char>): Pair<String, Boolean>? {
        if (row.size < 14 || row[0] !in "IAC1" || row.none { isDigitChar(it) }) return null
        val at = (1..3).firstOrNull { String(row.subList(it, it + 3).toCharArray()) == "NLD" }?.let { it + 3 }
        if (at == null && row[1] != '<') return null // not a passport's second line, whose number can start with an I
        val start = at ?: 5
        if (row.size < start + 10) return null
        return number(row.subList(start, start + 9), row[start + 9], dutch = at != null)
    }

    private fun country(part: List<Char>): String? {
        val code = String(part.map { toLetter[it] ?: it }.toCharArray()).replace("<", "")
        return if (code.isNotEmpty() && code.all { isLetter(it) }) code else null
    }

    // SURNAME<<GIVEN<NAMES, behind P<NLD in a passport. Text reading can lose the P<'s <, read it as a letter, or drop the fillers
    // at the end, so the line's length can't say which it is: a passport's line starts with P and its country (NLD, or the < after
    // the P). A filler at either end of a name, or two inside one, is no space in it: "LUCAS<MARIA<" is "LUCAS MARIA", the same
    // name as without the <, so the looks agree.
    // A names line ends in fillers, unless the names fill all of it: one that stops on a letter sooner was cut short by text reading
    // ("LUCAS<MAR"), and gave the wrong given names half the time against one in ten for a whole line, so it isn't used.
    private fun names(row: List<Char>): Pair<String, String>? {
        if (row.count { isDigitChar(it) } > 1) return null
        if (row.lastOrNull() != '<' && row.size < 30) return null
        var chars = row.map { toLetter[it] ?: it }
        val nldAfterP = if (chars.size > 5 && chars[0] == 'P') (1..2).firstOrNull { String(chars.subList(it, it + 3).toCharArray()) == "NLD" } else null
        if (chars.size > 5 && chars[0] == 'P' && chars[1] == '<') {
            chars = chars.drop(5)
        } else if (nldAfterP != null) {
            chars = chars.drop(nldAfterP + 3)
        } else if (chars.size > 30) { // longer than a card's line: a passport's, whose P was lost too, or read as a letter
            val nld = (0..2).firstOrNull { String(chars.subList(it, it + 3).toCharArray()) == "NLD" }
            if (nld != null) chars = chars.drop(nld + 3) else if (chars[0] == 'P') chars = chars.drop(5)
        }
        // The fillers at the end read as K or C, as a blurry < looks like either: three or more of them can't end a name ("ARNOUDKKKKK"),
        // while one or two can ("ERIK<<<<").
        var end = chars.size
        while (end > 0 && chars[end - 1] in "<KC") end--
        if (chars.subList(end, chars.size).count { it != '<' } >= 3) chars = chars.subList(0, end)
        val parts = String(chars.toCharArray()).split("<<").filter { it.isNotEmpty() }
        if (parts.size < 2) return null
        fun tidy(part: String) = part.split('<').filter { it.isNotEmpty() }.joinToString(" ")
        val surname = tidy(parts[0])
        val given = tidy(parts[1])
        if (surname.length < 2 || given.length < 2) return null
        return surname to given
    }

    // What one look at the lines gave.
    fun read(lines: List<String>): MrzRead = look(lines).read

    // The same, with which parts were guessed. Text reading's second guesses only fill in what its first reading didn't give
    // (ML Kit has none; Vision does).
    fun look(lines: List<String>, alternatives: List<String> = emptyList(), today: LocalDate = LocalDate.now()): MrzLook {
        val first = parse(lines, today)
        if (alternatives.isEmpty()) return first
        val second = parse(alternatives, today)
        var read = first.read
        val guessed = first.guessed.toMutableSet()
        for (name in MrzTally.fields) {
            if (MrzTally.value(read, name) != null) continue
            val value = MrzTally.value(second.read, name) ?: continue
            read = MrzTally.withField(read, name, value)
            guessed += name
        }
        return MrzLook(read, guessed)
    }

    // Earlier lines are the likelier reading, so they aren't overwritten.
    private fun parse(lines: List<String>, today: LocalDate): MrzLook {
        var out = MrzRead()
        val guessed = mutableSetOf<String>()
        fun take(found: Pair<String, Boolean>) {
            if (out.number != null) return
            out = out.copy(number = found.first)
            if (found.second) guessed += "number"
        }
        for (row in lines.map { clean(it) }) {
            if (row.size < 14) continue
            val first = firstLine(row)
            if (first != null) {
                take(first)
                continue
            }
            val d = dates(row, today)
            if (d != null) {
                out = out.copy(birth = out.birth ?: d.birth, expiry = out.expiry ?: d.expiry)
                if (d.at >= 10) { // a passport: the number and nationality come first
                    val nationality = country(row.subList(d.at - 3, d.at))
                    out = out.copy(nationality = out.nationality ?: nationality)
                    if (d.at >= 13) number(row.subList(d.at - 13, d.at - 4), row[d.at - 4], dutch = nationality == "NLD")?.let { take(it) }
                } else if (row.size >= d.at + 18) {
                    out = out.copy(nationality = out.nationality ?: country(row.subList(d.at + 15, d.at + 18)))
                }
                continue
            }
            names(row)?.let { (surname, given) -> out = out.copy(surname = out.surname ?: surname, givenNames = out.givenNames ?: given) }
        }
        return MrzLook(out, guessed)
    }

    // A piece of text in a picture, with where it is: pixels from the top left.
    data class Seen(val text: String, val left: Float, val top: Float, val right: Float, val bottom: Float) {
        val midY: Float get() = (top + bottom) / 2
        val height: Float get() = bottom - top
    }

    // The text read in a picture, line by line. The fillers can break a line in two, and two pieces side by side at one height are
    // one line. `width` is the picture's, for how far apart two pieces may be.
    fun lines(found: List<Seen>, width: Float): List<String> {
        fun sameLine(a: Seen, b: Seen) = kotlin.math.abs(a.midY - b.midY) < b.height / 2 && minOf(a.right, b.right) - maxOf(a.left, b.left) < 0.02f * width
        val rows = mutableListOf<MutableList<Seen>>()
        for (o in found.sortedBy { it.midY }) {
            val last = rows.lastOrNull()
            if (last != null && last.all { sameLine(it, o) }) last.add(o) else rows.add(mutableListOf(o))
        }
        return rows.map { row -> row.sortedBy { it.left }.joinToString("") { it.text } }
    }
}

// One picture can misread a character in a way its check digit misses, and pictures a moment apart are nearly the same picture,
// so they can be wrong the same way: two agreeing was too quick, and took wrong numbers and dates. A part of the key counts once
// it was read the same way in at least 6 looks (a guess counts for half a look) over at least two and a half seconds, and
// everything else it was read as adds up to no more than a quarter of that. So a scan takes a few seconds, on purpose. Every part is counted by itself: one picture may get the first
// line, the next the second. As MRZ.swift.
class MrzTally {
    private class Votes(val first: Double) {
        var points = 0
        var looks = 0
        var last = first
    }

    private val votes = HashMap<String, HashMap<String, Votes>>()

    fun add(look: MrzLook, time: Double) {
        for (name in fields) {
            val value = value(look.read, name) ?: continue
            val v = votes.getOrPut(name) { HashMap() }.getOrPut(value) { Votes(time) }
            v.points += if (name in look.guessed) 1 else 2
            v.looks++
            v.last = time
        }
    }

    private fun ranked(name: String): List<Pair<String, Votes>> {
        var seen: Map<String, Votes> = votes[name] ?: emptyMap()
        // A surname that's the end of another one read: text reading lost the start of the line ("DER" for MULDER), which ML Kit
        // does often in a blurry picture. It doesn't compete.
        if (name == "surname") seen = seen.filterKeys { k -> seen.keys.none { it != k && it.endsWith(k) } }
        return seen.entries
            .sortedWith(compareByDescending<Map.Entry<String, Votes>> { it.value.points }.thenByDescending { it.key })
            .map { it.key to it.value }
    }

    // A part of the key, sure as above. The name has no check digit, and its misreadings (a filler read as a C or K) mostly differ
    // from each other: it's sure once one reading was seen 3 times and twice as often as any other. The app doesn't take the name
    // from the scan any more (the chip gives it exactly), so nothing waits for it.
    fun isSure(name: String): Boolean {
        val seen = ranked(name)
        val top = seen.firstOrNull()?.second ?: return false
        val others = seen.drop(1).sumOf { it.second.points }
        if (name in key) return top.points >= POINTS_NEEDED && top.last - top.first >= SECONDS_NEEDED && others * 4 <= top.points
        return top.looks >= 3 && top.points >= 2 * (seen.getOrNull(1)?.second?.points ?: 0)
    }

    // The most seen of everything so far: what the screen shows while it's still looking.
    val read: MrzRead
        get() = fields.fold(MrzRead()) { r, name -> ranked(name).firstOrNull()?.let { withField(r, name, it.first) } ?: r }

    // Only what's sure: what goes in the form.
    val confirmed: MrzRead
        get() = fields.fold(MrzRead()) { r, name -> if (isSure(name)) ranked(name).firstOrNull()?.let { withField(r, name, it.first) } ?: r else r }

    val sure: Boolean get() = key.all { isSure(it) }

    companion object {
        val fields = listOf("number", "birth", "expiry", "surname", "given", "nationality")
        val key = listOf("number", "birth", "expiry")
        const val POINTS_NEEDED = 12 // 2 a look, 1 a guess
        const val SECONDS_NEEDED = 2.5

        fun value(r: MrzRead, name: String): String? = when (name) {
            "number" -> r.number
            "birth" -> r.birth
            "expiry" -> r.expiry
            "surname" -> r.surname
            "given" -> r.givenNames
            else -> r.nationality
        }

        fun withField(r: MrzRead, name: String, value: String): MrzRead = when (name) {
            "number" -> r.copy(number = value)
            "birth" -> r.copy(birth = value)
            "expiry" -> r.copy(expiry = value)
            "surname" -> r.copy(surname = value)
            "given" -> r.copy(givenNames = value)
            else -> r.copy(nationality = value)
        }
    }
}
