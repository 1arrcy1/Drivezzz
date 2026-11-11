package eu.drivezzz.app

import eu.drivezzz.app.features.checks.MrzKey
import eu.drivezzz.app.features.checks.MrzLook
import eu.drivezzz.app.features.checks.MrzRead
import eu.drivezzz.app.features.checks.MrzScan
import eu.drivezzz.app.features.checks.MrzTally
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

// Reading the code on the back of an ID, as MRZ.swift does: ICAO 9303's own examples, the Dutch sample the iPhone pretends to scan,
// and what text reading tends to get wrong.
class MrzTest {
    private val card = listOf("I<NLDSPECI20212<<<<<<<<<<<<<<<", "6503101F3108022NLD<<<<<<<<<<<6", "DE<BRUIJN<<WILLEKE<LISELOTTE<<")

    @Test fun checkDigits() {
        // ICAO 9303 part 3, the TD3 example.
        assertEquals("6", MrzKey.checkDigit("L898902C3"))
        assertEquals("2", MrzKey.checkDigit("740812"))
        assertEquals("9", MrzKey.checkDigit("120415"))
        assertEquals("2", MrzKey.checkDigit("SPECI2021"))
    }

    @Test fun key() {
        assertEquals("SPECI2021" + "2" + "650310" + "1" + "310802" + "2", MrzKey("speci-2021", "650310", "310802").key)
        // A short number is filled to nine with <.
        assertEquals("AB12345<<" + MrzKey.checkDigit("AB12345<<"), MrzKey("AB12345", "650310", "310802").key.take(10))
    }

    @Test fun dutchCard() {
        val r = MrzScan.read(card)
        assertEquals(MrzRead("SPECI2021", "650310", "310802", "DE BRUIJN", "WILLEKE LISELOTTE", "NLD"), r)
        assertTrue(r.hasKey)
    }

    // The day the tests are read on: ICAO's sample passport ran out in 2012, which is only a likely date until 2027.
    private val today = LocalDate.of(2026, 11, 7)

    @Test fun passport() {
        val r = MrzScan.look(listOf("P<UTOERIKSSON<<ANNA<MARIA<<<<<<<<<<<<<<<<<<<", "L898902C36UTO7408122F1204159ZE184226B<<<<<10"), today = today).read
        assertEquals("L898902C3", r.number)
        assertEquals("740812", r.birth)
        assertEquals("120415", r.expiry)
        assertEquals("UTO", r.nationality)
        assertEquals("ERIKSSON", r.surname)
        assertEquals("ANNA MARIA", r.givenNames)
    }

    @Test fun misreadings() {
        // An O for a 0 in a Dutch number, a lost < after the I, a blurry < read as a small k, spaces.
        val r = MrzScan.read(listOf("INLDSPECI2O212<<<<<<<<<<<<<<<", "650310 1F3108022NLDkk<<<<<<<<<6", "DE<BRUIJN<<WILLEKE<LISELOTTE<<"))
        assertEquals("SPECI2021", r.number)
        assertEquals("650310", r.birth)
        assertEquals("310802", r.expiry)
        // A wrong check digit is nothing at all, not a guess.
        assertNull(MrzScan.read(listOf("6503109F3108022NLD<<<<<<<<<<<6")).birth)
    }

    @Test fun names() {
        // A filler at the end of a line cut short is no space in the name, so this look agrees with one that read the whole line.
        assertEquals("WILLEKE LISELOTTE", MrzScan.read(listOf("DE<BRUIJN<<WILLEKE<LISELOTTE<")).givenNames)
        // A passport's line without its fillers at the end is no longer than a card's, but still starts with P<NLD.
        val passport = MrzScan.read(listOf("P<NLDBAKKER<<BRAM<<<<"))
        assertEquals("BAKKER", passport.surname)
        assertEquals("BRAM", passport.givenNames)
        // The < after the P read as an E, or lost.
        assertEquals("BAKKER", MrzScan.read(listOf("PENLDBAKKER<<BRAM<<<<")).surname)
        assertEquals("BAKKER", MrzScan.read(listOf("PNLDBAKKER<<BRAM<<<<")).surname)
        // Fillers at the end read as K: three or more go, while a name that ends in K keeps it.
        assertEquals("BRAM", MrzScan.read(listOf("BAKKER<<BRAMKKKKKKKKKKKKKKKKKK")).givenNames)
        assertEquals("BRAM", MrzScan.read(listOf("BAKKER<<BRAM<KCKKK<<<<<<<<<<<")).givenNames)
        assertEquals("ERIK", MrzScan.read(listOf("BAKKER<<ERIK<<<<<<<<<<<<<<<<<")).givenNames)
        // A line that stops on a letter was cut short: its given names aren't taken.
        assertNull(MrzScan.read(listOf("JANSSEN<<LUCAS<MAR")).givenNames)
        // A card's surname that starts with P stays whole.
        assertEquals("PETERS", MrzScan.read(listOf("PETERS<<PIETER<<<<<<<<<<<<<<<<")).surname)
        // An М from another alphabet, and a letter with an accent.
        assertEquals("EMMA", MrzScan.read(listOf("MULDER<<EМMA<<<<<<<<<<<<<<<<<<")).givenNames)
        assertEquals("EMMA", MrzScan.read(listOf("MULDER<<EMMĄ<<<<<<<<<<<<<<<<<<")).givenNames)
    }

    @Test fun piecesOfOneLine() {
        val seen = listOf(
            MrzScan.Seen("I<NLDSPECI2021", 10f, 100f, 300f, 130f),
            MrzScan.Seen("2<<<<<<<<<<<<<<<", 305f, 102f, 600f, 132f),
            MrzScan.Seen("6503101F3108022NLD<<<<<<<<<<<6", 10f, 150f, 600f, 180f),
        )
        assertEquals(listOf("I<NLDSPECI20212<<<<<<<<<<<<<<<", "6503101F3108022NLD<<<<<<<<<<<6"), MrzScan.lines(seen, 620f))
    }

    @Test fun unlikelyDates() {
        // Check digits that fit, but valid until 2099, or a sex that's no sex: misreadings, not dates.
        assertNull(MrzScan.read(listOf("650310" + "1" + "F" + "990802" + MrzKey.checkDigit("990802") + "NLD<<<<<<<<<<<6")).expiry)
        assertNull(MrzScan.read(listOf("6503101" + "7" + "3108022NLD<<<<<<<<<<<6")).birth)
        // Not at the start of a card's line or behind a passport's number: somewhere a date can't be.
        assertNull(MrzScan.read(listOf("<<<<<6503101F3108022NLD<<<<<<6")).birth)
    }

    @Test fun guessedNumber() {
        // A Dutch number never has an O, so an O read in it is a 0: that's no guess.
        val look = MrzScan.look(listOf("I<NLDSPECI2O212<<<<<<<<<<<<<<<", "6503101F3108022NLD<<<<<<<<<<<6"))
        assertEquals(MrzLook(MrzRead("SPECI2021", "650310", "310802", nationality = "NLD"), emptySet()), look)
        // A Z for its 2: only swapping it back fits the check digit, so that is one.
        val swapped = MrzScan.look(listOf("I<NLDSPECIZ0212<<<<<<<<<<<<<<<"))
        assertEquals("SPECI2021", swapped.read.number)
        assertEquals(setOf("number"), swapped.guessed)
        // Second guesses only fill in what's missing, and count as guesses.
        val second = MrzScan.look(listOf("I<NLDSPECI20212<<<<<<<<<<<<<<<"), alternatives = listOf("6503101F3108022NLD<<<<<<<<<<<6"))
        assertEquals("650310", second.read.birth)
        assertEquals(setOf("birth", "expiry", "nationality"), second.guessed)
    }

    // Pictures a moment apart are nearly the same picture: two of them agreeing isn't enough any more. A scan takes a few seconds.
    @Test fun sureTakesLooksAndTime() {
        val look = MrzScan.look(card)
        val quick = MrzTally()
        for (i in 0 until 8) quick.add(look, i * 0.1)
        assertFalse("8 looks in 0.7 s", quick.sure)
        assertEquals("SPECI2021", quick.read.number)
        assertEquals(MrzRead(), MrzRead(number = quick.confirmed.number, birth = quick.confirmed.birth, expiry = quick.confirmed.expiry))
        quick.add(look, 1.5)
        assertFalse("and once more after 1.5 s", quick.sure)
        quick.add(look, 2.5)
        assertTrue("and once more after 2.5 s", quick.sure)
        assertEquals("SPECI2021", quick.confirmed.number)

        val few = MrzTally()
        for (i in 0 until 5) few.add(look, i * 1.0)
        assertFalse("5 looks over 4 s", few.sure)
        few.add(look, 5.0)
        assertTrue(few.sure)
    }

    // The name comes from the chip: a scan is done once the three parts that open it are sure, whatever the names line gave.
    @Test fun sureWithoutTheName() {
        val tally = MrzTally()
        for (i in 0 until 6) tally.add(MrzScan.look(card.take(2)), i * 0.5)
        assertTrue(tally.sure)
        assertNull(tally.confirmed.surname)
        assertEquals(MrzRead("SPECI2021", "650310", "310802", nationality = "NLD"), tally.confirmed)
    }

    // A blurry picture can lose the start of the names line: that reading doesn't hold back the whole surname.
    @Test fun aLostStartDoesntCompete() {
        val whole = MrzScan.look(card)
        val lost = MrzLook(whole.read.copy(surname = "BRUIJN"))
        val tally = MrzTally()
        for (i in 0 until 3) tally.add(lost, i * 0.1)
        for (i in 0 until 3) tally.add(whole, 1.0 + i * 0.1)
        assertTrue(tally.isSure("surname"))
        assertEquals("DE BRUIJN", tally.confirmed.surname)
    }

    @Test fun guessesCountHalf() {
        val tally = MrzTally()
        val guessed = MrzLook(MrzRead("SPECI2021", "650310", "310802"), setOf("number"))
        for (i in 0 until 6) tally.add(guessed, i * 0.5)
        assertFalse(tally.isSure("number"))
        assertTrue(tally.isSure("birth"))
        for (i in 6 until 12) tally.add(guessed, i * 0.5)
        assertTrue(tally.isSure("number"))
    }

    @Test fun aRivalHoldsItBack() {
        val right = MrzScan.look(card)
        val wrong = MrzLook(right.read.copy(number = "SPECI2O21".replace('O', '8')))
        val tally = MrzTally()
        tally.add(wrong, 0.0)
        tally.add(wrong, 0.1)
        for (i in 0 until 7) tally.add(right, 0.5 + i * 0.4)
        // 14 points against 4: not yet four times as many.
        assertFalse(tally.isSure("number"))
        assertTrue(tally.isSure("birth"))
        tally.add(right, 3.5)
        assertTrue(tally.isSure("number"))
        assertEquals("SPECI2021", tally.confirmed.number)
    }

    @Test fun dates() {
        assertEquals(LocalDate.of(1965, 3, 10), MrzKey.date("650310", past = true))
        assertEquals(LocalDate.of(2031, 8, 2), MrzKey.date("310802", past = false))
        assertEquals("650310", MrzKey.yymmdd(LocalDate.of(1965, 3, 10)))
        assertNull(MrzKey.date("651310", past = true))
    }
}
