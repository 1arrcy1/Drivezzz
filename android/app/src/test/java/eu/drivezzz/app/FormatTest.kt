package eu.drivezzz.app

import eu.drivezzz.app.core.AppAccent
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.JsonFormat
import eu.drivezzz.app.core.LatLng
import eu.drivezzz.app.core.Markdown
import eu.drivezzz.app.core.MarketOrder
import eu.drivezzz.app.core.MessageFilter
import eu.drivezzz.app.core.Polyline
import eu.drivezzz.app.core.Ride
import eu.drivezzz.app.core.Sunlight
import eu.drivezzz.app.core.Vehicle
import eu.drivezzz.app.core.forYouFirst
import eu.drivezzz.app.core.toJsonElement
import eu.drivezzz.app.core.Car
import eu.drivezzz.app.core.MarketResponse
import eu.drivezzz.app.features.SteadyCar
import eu.drivezzz.app.features.Turn
import eu.drivezzz.app.features.bearingBetween
import eu.drivezzz.app.features.metresBetween
import eu.drivezzz.app.map.FingerWatch
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FormatTest {
    @Test fun agreementMarkdown() {
        assertEquals(listOf(Markdown.Span("plain")), Markdown.spans("plain"))
        assertEquals(
            listOf(Markdown.Span("In an emergency", bold = true), Markdown.Span(" call 112.")),
            Markdown.spans("**In an emergency** call 112."),
        )
        assertEquals(
            listOf(Markdown.Span("see the "), Markdown.Span("Terms", url = "https://x.nl/terms"), Markdown.Span(".")),
            Markdown.spans("see the [Terms](https://x.nl/terms)."),
        )
        assertEquals(
            listOf(Markdown.Span("a ", bold = true), Markdown.Span("b", bold = true, url = "https://x.nl"), Markdown.Span(" c", bold = true)),
            Markdown.spans("**a [b](https://x.nl) c**"),
        )
        // Not closed: still every word, as text.
        assertEquals("a **b [c](d", Markdown.spans("a **b [c](d").joinToString("") { it.text })
    }

    @Test fun queueWaitInWords() {
        assertEquals("3 seconds", Fmt.queueWait(3))
        assertEquals("59 seconds", Fmt.queueWait(59))
        assertEquals("a minute", Fmt.queueWait(60))
        assertEquals("2 minutes", Fmt.queueWait(61))
        assertEquals("5 minutes", Fmt.queueWait(300))
    }

    // Moving the map must never pick a driver (Pieter, 6 November 2026): only a quick touch that stays put, on a map lying still, is a tap.
    private fun finger() = FingerWatch(stayWithinPx = 16f)

    @Test fun aQuickTouchIsATap() {
        val f = finger()
        f.down(100f, 100f, 1000, mapGliding = false)
        f.moved(103f, 102f)
        f.up(104f, 102f, 1120)
        assertTrue(f.takeTap())
        assertFalse("once", f.takeTap())
    }

    @Test fun aNudgeIsNoTap() {
        val f = finger()
        f.down(100f, 100f, 1000, mapGliding = false)
        f.moved(118f, 100f) // under Android's own touch slop of 21 px on this screen, so the map would have called it a tap
        f.up(118f, 100f, 1100)
        assertFalse(f.takeTap())
        assertTrue(f.strayed)
    }

    @Test fun movingAwayAndBackIsNoTap() {
        val f = finger()
        f.down(100f, 100f, 1000, mapGliding = false)
        f.moved(160f, 100f)
        f.moved(100f, 100f)
        f.up(100f, 100f, 1200)
        assertFalse(f.takeTap())
    }

    @Test fun aTouchThatStopsTheGlideIsNoTap() {
        val f = finger()
        f.down(100f, 100f, 1000, mapGliding = true)
        f.up(100f, 100f, 1050)
        assertFalse(f.takeTap())
        assertTrue("nor a hold", f.strayed)
    }

    @Test fun aSlowPressIsNoTap() {
        val f = finger()
        f.down(100f, 100f, 1000, mapGliding = false)
        f.up(100f, 100f, 1000 + FingerWatch.TAP_AT_MOST_MS + 1)
        assertFalse(f.takeTap())
    }

    @Test fun aHoldIsHalfASecondOfStayingPut() {
        val f = finger()
        f.down(100f, 100f, 1000, mapGliding = false)
        assertEquals(100L, f.untilHeld(1400)) // when Android first says "long"
        assertEquals(0L, f.untilHeld(1600))
        assertTrue(f.stillHolding)
        f.moved(120f, 100f)
        assertFalse("it began to move the map", f.stillHolding)
    }

    @Test fun liftingEndsAHold() {
        val f = finger()
        f.down(100f, 100f, 1000, mapGliding = false)
        f.up(100f, 100f, 1450)
        assertFalse(f.stillHolding)
    }

    @Test fun aSecondFingerIsNoTap() {
        val f = finger()
        f.down(100f, 100f, 1000, mapGliding = false)
        f.secondFinger()
        f.up(100f, 100f, 1100)
        assertFalse(f.takeTap())
    }

    @Test fun money() {
        assertEquals("€12.50", Fmt.eur(1250))
        assertEquals("€0.05", Fmt.eur(5))
        assertEquals("–", Fmt.eur(null))
    }

    @Test fun distanceAndTime() {
        assertEquals("950 m", Fmt.km(950))
        assertEquals("1.2 km", Fmt.km(1234))
        assertEquals("1 min", Fmt.minutes(10))
        assertEquals("15 min", Fmt.minutes(900))
        assertEquals("1 h 10 min", Fmt.minutes(4200))
        assertEquals("01:01:01", Fmt.stopwatch(3661))
        assertEquals("4:05", Fmt.clock(245))
    }

    @Test fun rating() {
        assertEquals("New", Fmt.rating(null, 0))
        assertEquals("4.5 (12)", Fmt.rating(4.5, 12))
    }

    @Test fun addresses() {
        assertEquals("6aHmEJ…kV7YuN", Fmt.shortAddress("6aHmEJ6gikE7XH8NANwzBHukdAP2nMUkQR9DTRkV7YuN"))
        assertEquals("short", Fmt.shortAddress("short"))
    }

    @Test fun coins() {
        assertEquals("USDC", Fmt.coinSymbol("usdc-sol"))
        assertEquals("USDC on Solana", Fmt.coinName("usdc-sol"))
        assertEquals("SOL", Fmt.coinName("sol"))
        assertEquals("in the car", Vehicle.riding("car"))
        assertEquals("on the scooter", Vehicle.riding("scooter"))
    }

    @Test fun polyline() {
        // Google's own example.
        val line = Polyline.decode("_p~iF~ps|U_ulLnnqC_mqNvxq`@")
        assertEquals(3, line.size)
        assertEquals(38.5, line[0].lat, 1e-5)
        assertEquals(-120.2, line[0].lng, 1e-5)
        assertEquals(43.252, line[2].lat, 1e-5)
        assertEquals(-126.453, line[2].lng, 1e-5)
        assertTrue(Polyline.decode(null).isEmpty())
    }

    // What Core/Theme.swift says for the same moments and places (ios-vectors.txt).
    @Test fun sunMatchesIos() {
        javaClass.classLoader!!.getResource("ios-vectors.txt")!!.readText().lines().filter { it.startsWith("sun ") }.forEach { line ->
            val (ms, lat, lng) = line.substringBefore('=').removePrefix("sun ").split(" ").map { it.toDouble() }
            assertEquals(line.substringAfter('=').toDouble(), Sunlight.elevation(ms.toLong(), lat, lng), 1e-6)
        }
        assertEquals(AppAccent.Blue, AppAccent.of("nonsense"))
    }

    @Test fun wordFilter() {
        val words = setOf("kanker", "flikker")
        assertTrue(MessageFilter.isBlocked("wat een K4NK3R", words))
        assertTrue(MessageFilter.isBlocked("f.l.i.k.k.e.r", words))
        assertTrue(MessageFilter.isBlocked("Kánker", words))
        assertFalse(MessageFilter.isBlocked("gewoon een nette zin", words))
    }

    @Test fun jsonBodies() {
        val body = mapOf("a" to 1, "b" to "x", "c" to true, "d" to listOf(1.5, 2), "e" to mapOf("f" to null))
        assertEquals("""{"a":1,"b":"x","c":true,"d":[1.5,2],"e":{"f":null}}""", body.toJsonElement().toString())
    }

    @Test fun serverFieldsAreOptional() {
        // New fields are ignored, and everything but the ids may be missing.
        val ride = JsonFormat.decodeFromString(
            Ride.serializer(),
            """{"id":"r1","status":"riding","pickup":{"lat":52.1,"lng":4.3},"dropoff":{"lat":52.2,"lng":4.4},"brandNewField":{"x":1},"driverEtaS":59}""",
        )
        assertEquals("r1", ride.id)
        assertEquals("Riding", ride.statusTitle)
        assertEquals("Almost there", ride.etaShort)
        assertEquals(ride.dropoff, ride.navigationTarget)
        assertTrue(ride.isLive)
    }

    @Test fun heldCarAndBookedRides() {
        // A car's hold and the market's booked rides are optional, as everything new from the server.
        val held = JsonFormat.decodeFromString(Car.serializer(), """{"id":"c1","plate":"TX555E","hold":{"code":"plate","text":"A person is checking.","review":true}}""")
        assertTrue(held.hold!!.plate)
        assertEquals(null, JsonFormat.decodeFromString(Car.serializer(), """{"id":"c2","plate":"AB12CD"}""").hold)
        val market = JsonFormat.decodeFromString(MarketResponse.serializer(), """{"orders":[],"booked":[{"id":"r1","status":"scheduled","pickup":{"lat":52.1,"lng":4.3},"dropoff":{"lat":52.2,"lng":4.4}}]}""")
        assertEquals("r1", market.booked!!.single().id)
        assertEquals(null, JsonFormat.decodeFromString(MarketResponse.serializer(), """{"orders":[]}""").booked)
    }

    @Test fun steadyCar() {
        // The rider's view of a driver's car: GPS wobble under 30 m holds it still, a real move or another ride moves it.
        val car = SteadyCar()
        val here = LatLng(52.3676, 4.9041)
        assertEquals(here, car.follow(here, "r1"))
        assertEquals("about 13 m: wobble", here, car.follow(LatLng(52.3677, 4.9042), "r1"))
        assertEquals("about 26 m from where it's shown: still wobble", here, car.follow(LatLng(52.3678, 4.9043), "r1"))
        val moved = LatLng(52.3690, 4.9041)
        assertEquals("about 155 m: a real move", moved, car.follow(moved, "r1"))
        val other = LatLng(52.3691, 4.9041)
        assertEquals("another ride starts where its car is", other, car.follow(other, "r2"))
        assertEquals(null, car.follow(null, "r2"))
    }

    @Test fun orderForYouFirst() {
        val orders = listOf(MarketOrder("a", lat = 0.0, lng = 0.0), MarketOrder("b", lat = 0.0, lng = 0.0, forYou = true))
        assertEquals("b", orders.forYouFirst.first().id)
    }

    @Test fun geometry() {
        assertEquals(111_195.0, metresBetween(LatLng(52.0, 4.0), LatLng(53.0, 4.0)), 50.0)
        assertEquals(0.0, bearingBetween(LatLng(52.0, 4.0), LatLng(53.0, 4.0)), 1e-6)
        assertEquals(Turn.Straight, Turn.between(10.0, 15.0))
        assertEquals(Turn.Right, Turn.between(0.0, 90.0))
        assertEquals(Turn.Left, Turn.between(0.0, -90.0))
        assertEquals(Turn.UTurn, Turn.between(0.0, 180.0))
        assertEquals(Turn.SlightRight, Turn.between(350.0, 20.0))
    }

    // The pay card: SOL to 5 decimals and USDC to cents, rounded up, never less than what the wallet asks (8 November 2026).
    @Test fun coinAmountsOnThePayCard() {
        assertEquals("0.03456 SOL", Fmt.coinAmount("0.034555671", "sol"))
        assertEquals("0.05 SOL", Fmt.coinAmount("0.05", "sol"))
        assertEquals("2.79 USDC", Fmt.coinAmount("2.781", "usdc-sol"))
        assertEquals("€80.45", Fmt.eurPrice(80.45))
        val ride = Ride(id = "r", status = "riding", pickup = eu.drivezzz.app.core.Place(0.0, 0.0), dropoff = eu.drivezzz.app.core.Place(0.0, 0.0))
        assertEquals("Riding", ride.statusTitle)
        assertEquals("About 4 min · 1.2 km away", ride.copy(status = "accepted", driverEtaS = 240, driverToPickupM = 1200).comingLine)
    }
}
