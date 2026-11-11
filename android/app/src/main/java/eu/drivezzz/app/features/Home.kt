package eu.drivezzz.app.features

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import eu.drivezzz.app.core.DriverSort
import androidx.compose.ui.draw.alpha
import androidx.compose.runtime.derivedStateOf
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.ApiError
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.Availability
import eu.drivezzz.app.core.Car
import eu.drivezzz.app.core.Coins
import eu.drivezzz.app.core.DriverCard
import eu.drivezzz.app.core.DriverProfile
import eu.drivezzz.app.core.DriversResponse
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.LatLng
import eu.drivezzz.app.core.LocationService
import eu.drivezzz.app.core.Place
import eu.drivezzz.app.core.Polyline
import eu.drivezzz.app.core.Prefs
import eu.drivezzz.app.core.Quote
import eu.drivezzz.app.core.Ride
import eu.drivezzz.app.core.RideResponse
import eu.drivezzz.app.core.RidesResponse
import eu.drivezzz.app.core.SavedRoutes
import eu.drivezzz.app.core.Vehicle
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.core.place
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.map.DzMap
import eu.drivezzz.app.map.MapAnchor
import eu.drivezzz.app.map.MapAnnotation
import eu.drivezzz.app.map.mapTapArea
import eu.drivezzz.app.map.MapController
import eu.drivezzz.app.map.MapLine
import eu.drivezzz.app.map.Places
import eu.drivezzz.app.map.rememberMapController
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.TimeZone

// An order that only needs to know how it's paid. `takes` is what the rider can pick; null: anything.
data class OrderToPay(val mode: String, val bid: Int? = null, val cents: Int? = null, val driver: String? = null, val takes: List<String>? = null)

private const val ON_LIST = 50 // who you can choose from
private const val ON_MAP = 5 // who gets a pin: more only fills the map with circles
// Zooming out the bubbles go first, then the circles, so the map stays clear: pins are for looking around close by.
private const val BUBBLES_UP_TO_KM = 12.0
private const val CIRCLES_UP_TO_KM = 30.0

// Booking, in one place. The list is what you see first; swipe it down for the map of drivers.
class Booking {
    var pickup by mutableStateOf<Place?>(null) // null: where you are
    var dropoff by mutableStateOf<Place?>(null)
    var passengers by mutableIntStateOf(1)
    var pets by mutableStateOf(false)
    var vehicle by mutableStateOf<String?>(null) // null: any
    // A coin saved before Drivezzz went Solana-only (XRP, LTC, XLM) no longer counts.
    private var storedCoin by mutableStateOf(Prefs.string("payCoin")?.takeIf { it in Coins.payWith } ?: "sol")
    var coin: String
        get() = storedCoin
        set(value) {
            storedCoin = value
            Prefs.set("payCoin", value)
        }
    var planned by mutableStateOf(false)
    var planDate by mutableStateOf(System.currentTimeMillis() + 3600_000.0)
    var quote by mutableStateOf<Quote?>(null)
    var driverId by mutableStateOf<String?>(null) // chosen by the rider; null: the cheapest
    var openDriver by mutableStateOf<DriverCard?>(null) // whose page is open
    var payingFor by mutableStateOf<OrderToPay?>(null) // an order about to go out, asking how to pay
    var bidCents by mutableIntStateOf(0)
    var namingRoute by mutableStateOf(false) // asking a name for the route on screen, to keep it in Rides
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)

    val scheduledAt: Double? get() = if (planned) planDate else null
    val chosenOffer: DriverCard?
        get() {
            val offers = quote?.offers ?: return null
            driverId?.let { id -> offers.firstOrNull { it.id == id }?.let { return it } }
            return if (driverId == null) offers.firstOrNull() else null
        }
    // Who a tap picked, on the map or in the list: with a route the one the Book button books, before it whoever was tapped.
    // A tap on the picked one opens their page (Pieter, 5 November 2026).
    val picked: String? get() = if (quote == null) driverId else chosenOffer?.id

    fun clear() {
        pickup = null
        dropoff = null
        quote = null
        driverId = null
        error = null
        planned = false
    }
}

// What's on every map with a route: its line, with an edge that keeps it readable.
@Composable
fun routeLines(line: List<LatLng>, thick: Boolean = false): List<MapLine> =
    if (line.size < 2) emptyList() else listOf(
        MapLine(line, Theme.routeEdge, if (thick) 10f else 8f),
        MapLine(line, Theme.route, if (thick) 6f else 5f),
    )

fun pickupAnnotation(at: LatLng) = MapAnnotation("pickup", at) { PlaceMarker(Sym.pickup, Theme.pickupPin, "Pickup") }
fun dropoffAnnotation(at: LatLng) = MapAnnotation("dropoff", at) { PlaceMarker(Sym.flag, Theme.accent, "Drop-off") }

@Composable
fun HomeScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    val booking = remember { Booking() }
    val panel = rememberPanelState(PanelDetent.Middle)
    val controller = rememberMapController()
    val density = LocalDensity.current
    var routeCard by remember { mutableStateOf(104.dp) }
    var centred by remember { mutableStateOf(false) }
    var drivers by remember { mutableStateOf<List<DriverCard>>(emptyList()) }
    var totalOnline by remember { mutableStateOf<Int?>(null) }
    var lookedFrom by remember { mutableStateOf<LatLng?>(null) } // where the last look was from
    var requotedFor by remember { mutableStateOf<String?>(null) } // the new prices a quote was last asked again for
    var sort by remember { mutableStateOf(DriverSort.of(Prefs.string("driversSort"))) }
    var radiusKm by remember { mutableStateOf(10f) }
    var petsOnly by remember { mutableStateOf(false) }
    var showFilter by remember { mutableStateOf(false) }
    var searching by remember { mutableStateOf(false) }
    var ordering by remember { mutableStateOf(false) }
    var showBid by remember { mutableStateOf(false) }
    var quoteRun by remember { mutableIntStateOf(0) }
    val steadyDriver = remember { SteadyCar() }

    val ride = app.ride
    val quote = booking.quote
    val routeCoordinates = remember(quote?.polyline) { Polyline.decode(quote?.polyline) }

    // With a ride: how it's going and the road stay in view with the panel down.
    // With a quote: all of the route's card, so the distance and the time show too, however long its text gets.
    val peek = if (ride != null) 138.dp else if (quote == null) 100.dp else routeCard + 30.dp

    // Planning a ride: only drivers who take planned rides.
    val shownDrivers = if (booking.planned) drivers.filter { it.allowsPlanning != false } else drivers

    fun mine(): Place? = LocationService.location?.let { Place(it.latitude, it.longitude, "Your location") }

    // Around you, once your position is known; the map doesn't get there by itself.
    fun centre(force: Boolean = false) {
        if (!force && centred) return
        val here = LocationService.location?.place ?: return
        centred = true
        controller.centre(here, 6000.0, animated = force)
    }

    suspend fun loadDrivers() {
        // Around the pickup once it's moved: that's where a driver has to come to.
        val here = booking.pickup?.coordinate ?: LocationService.location?.place ?: return
        val path = "/api/drivers/nearby?lat=${here.lat}&lng=${here.lng}&radiusKm=${radiusKm.toInt()}&pets=${if (petsOnly) 1 else 0}&limit=$ON_LIST&sort=${sort.key}${booking.vehicle?.let { "&vehicle=$it" } ?: ""}"
        attempt { ApiClient.get<DriversResponse>(path) }?.let { r ->
            // The server answers for the area, so how far they are from you is worked out here.
            val fresh = (r.drivers ?: emptyList()).map { d -> d.coordinate?.let { d.copy(distanceM = metresBetween(here, it).toInt()) } ?: d }
            // Nothing new, nothing drawn again. Otherwise the pins glide to where the drivers are now.
            if (fresh != drivers) drivers = fresh
            totalOnline = r.total
            lookedFrom = here
        }
    }

    // Tapping the map keeps its zoom, so the spot can be corrected with another tap. Only a place from the search shows the whole route.
    // `quiet`: asked again for new prices, without a spinner, and keeping the quote there is if it fails. As HomeView.swift.
    suspend fun getQuote(showRoute: Boolean = false, quiet: Boolean = false) {
        val base = booking.pickup ?: mine()
        val to = booking.dropoff
        if (base == null || to == null) {
            if (!quiet) booking.error = "We need your location to use this app."
            return
        }
        // A few taps in a row: only the last one counts.
        quoteRun++
        val run = quoteRun
        if (!quiet) {
            booking.loading = true
            booking.error = null
        }
        try {
            val from = if (booking.pickup == null) base.copy(label = Places.name(base.coordinate) ?: "Pickup") else base
            val body = buildMap<String, Any?> {
                put("pickup", from.json)
                put("dropoff", to.json)
                put("passengers", booking.passengers)
                put("pets", booking.pets)
                put("coin", booking.coin)
                put("sort", sort.key)
                booking.scheduledAt?.let { put("scheduledAt", it) }
                booking.vehicle?.let { put("vehicle", it) }
            }
            try {
                val q: Quote = ApiClient.post("/api/quote", body)
                // Asked again quietly, but the route was closed meanwhile: it stays closed.
                if (run != quoteRun || (quiet && booking.quote == null)) return
                if (booking.quote == null && panel.detent == PanelDetent.Peek) panel.detent = PanelDetent.Middle
                booking.quote = q
                // Sorted by something else than the price: the one on top is the one you'd book.
                if (sort != DriverSort.Cheapest && booking.driverId == null) booking.driverId = sort.sorted(q.offers ?: emptyList()).firstOrNull()?.id
                if (showRoute) controller.fit(Polyline.decode(q.polyline))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (run != quoteRun || quiet) return
                booking.error = e.shown
                booking.quote = booking.quote ?: Quote(pickup = from, dropoff = to, offers = emptyList())
            }
        } finally {
            if (run == quoteRun && !quiet) booking.loading = false
        }
    }

    // A driver of the quote has changed their price since: the quote is asked again, quietly, so its prices are what they ask now.
    // Once per change, as the look and the quote can take a few seconds to agree. As HomeView.swift.
    fun requoteIfPricesChanged() {
        val offers = booking.quote?.offers.orEmpty()
        if (offers.isEmpty() || booking.payingFor != null || ordering || booking.loading) return
        fun rates(d: DriverCard) = "${d.id}:${d.perKmCents ?: 0}/${d.perMinCents ?: 0}/${d.pickupPerKmCents ?: 0}"
        val changed = offers.mapNotNull { offer -> drivers.firstOrNull { it.id == offer.id }?.let { now -> rates(now).takeIf { it != rates(offer) } } }
        if (changed.isEmpty()) return
        val seen = changed.sorted().joinToString(",")
        if (seen == requotedFor) return
        requotedFor = seen
        scope.launch { getQuote(quiet = true) }
    }

    // Holding the map moves the pickup: the driver waits there. The spot shows right away; its name and the price follow.
    suspend fun movePickup(to: LatLng) {
        val spot = Place(to.lat, to.lng, "Pickup")
        booking.pickup = spot
        val label = Places.name(to)
        if (booking.pickup != spot) return
        booking.pickup = spot.copy(label = label ?: "Pickup")
        if (booking.dropoff != null) getQuote() else loadDrivers()
    }

    suspend fun order(mode: String, bid: Int?) {
        val q = booking.quote ?: return
        ordering = true
        booking.error = null
        val body = buildMap<String, Any?> {
            put("pickup", q.pickup.json)
            put("dropoff", q.dropoff.json)
            put("passengers", booking.passengers)
            put("pets", booking.pets)
            put("coin", booking.coin)
            put("mode", mode)
            booking.scheduledAt?.let { put("scheduledAt", it) }
            booking.vehicle?.let { put("vehicle", it) }
            if (mode == "driver") booking.driverId?.let { put("driverId", it) }
            if (bid != null) put("bidCents", bid) else booking.chosenOffer?.priceCents?.let { put("expectedCents", it) }
        }
        try {
            val r: RideResponse = ApiClient.post("/api/rides", body)
            booking.clear()
            app.syncNow()
            app.sendLocationNow()
            panel.detent = PanelDetent.Middle
            app.showingRide = r.ride
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            booking.error = e.message
            if (e.code == "price_changed") getQuote()
        } finally {
            ordering = false
        }
    }

    // How to pay is asked at the very end. A chosen driver has to take it; otherwise it goes to the cheapest who does.
    fun askToPay() {
        val offer = booking.chosenOffer
        val chosen = booking.driverId != null
        val takes = if (chosen) offer?.coins else booking.quote?.offers?.mapNotNull { it.coins }?.flatten()
        booking.payingFor = OrderToPay(if (chosen) "driver" else "auto", cents = offer?.priceCents, driver = if (chosen) offer?.name else null, takes = takes?.takeIf { it.isNotEmpty() })
    }

    fun changeSort(to: DriverSort) {
        sort = to
        Prefs.set("driversSort", to.key)
    }

    fun choose(d: DriverCard, planned: Boolean) {
        booking.openDriver = null
        booking.driverId = d.id
        booking.planned = planned
        if (booking.dropoff == null) searching = true else scope.launch { getQuote() }
    }

    // A saved route, picked in Rides.
    LaunchedEffect(app.routeToUse) {
        val route = app.routeToUse ?: return@LaunchedEffect
        app.routeToUse = null
        if (app.ride != null) return@LaunchedEffect
        booking.clear()
        booking.pickup = route.pickup
        booking.dropoff = route.dropoff
        // Not in this effect itself: clearing routeToUse ends it.
        scope.launch { getQuote(showRoute = true) }
    }
    fun tappedPin(d: DriverCard, style: PinStyle) {
        // A small one, with the map far out: a tap goes to it.
        val c = d.coordinate
        if (style != PinStyle.Label && booking.picked != d.id && c != null && controller.widthKm > 2.5) {
            controller.centre(c, 3000.0)
            return
        }
        // A tap picks this driver to book with, and a tap on the picked one opens their page (Pieter, 5 November 2026). With a route,
        // one who can't take it only has their page.
        if (booking.picked == d.id) {
            booking.openDriver = d
            return
        }
        val offers = booking.quote?.offers
        if (offers != null && offers.none { it.id == d.id }) {
            booking.openDriver = d
            return
        }
        booking.driverId = d.id
    }

    LaunchedEffect(sort) {
        if (booking.quote != null) {
            booking.driverId = null
            getQuote()
        }
    }
    // Only for someone looking at it: with many people around, every look that nobody sees adds up. Every 5 seconds (Pieter,
    // 8 November 2026, was 30): drivers move on the map, one who's booked or went offline goes, and a new price shows. As HomeView.swift.
    LaunchedEffect(LocationService.hasFix, radiusKm, petsOnly, sort) {
        while (true) {
            if (app.isActive && app.riderTab == 0 && app.ride == null) {
                loadDrivers()
                requoteIfPricesChanged()
            }
            delay(5_000)
        }
    }
    LaunchedEffect(LocationService.hasFix) {
        // After the map's own first layout, which would otherwise win.
        delay(400)
        centre()
    }
    LaunchedEffect(ride?.id) {
        val id = ride?.id
        panel.detent = if (id == null) PanelDetent.Middle else PanelDetent.Peek
        if (id != null) {
            // Once the panel is down, so the route gets the room that leaves, as on iOS. Framed before that it stays small.
            snapshotFlow { panel.rest }.first { it == PanelDetent.Peek }
            delay(350)
            controller.fit(ride.route)
        }
    }
    // Late: the panel comes up by itself, with the green button.
    LaunchedEffect(ride?.driverLate) {
        if (ride?.driverLate == true) panel.detent = PanelDetent.Middle
    }
    LaunchedEffect(searching) {
        panel.detent = if (searching) PanelDetent.Full else if (ride == null) PanelDetent.Middle else panel.detent
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val cover = if (Room.wide(maxWidth)) 0.dp else panelCover(panel.rest, peek, maxHeight)
        val statusTop = with(density) { WindowInsets.statusBars.getTop(density).toDp() }

        // The cheapest of the list, with their price for this ride if there is one. A driver chosen from the list shows as well.
        val pickedId = booking.picked
        // A driver of the quote as the latest look has them: where they are now, and gone once they're booked or offline. Only a look that
        // has everyone around can say someone's gone, and only for who's within it: a quote looks further when there are few.
        val complete = (totalOnline ?: Int.MAX_VALUE) <= drivers.size
        val priced = quote?.offers.orEmpty().mapNotNull { offer ->
            val c = offer.coordinate ?: return@mapNotNull null
            val now = drivers.firstOrNull { it.id == offer.id }
            val from = lookedFrom
            when {
                now != null -> offer.copy(lat = now.lat, lng = now.lng, heading = now.heading)
                complete && from != null && metresBetween(from, c) < radiusKm * 1000 - 200 -> null
                else -> offer
            }
        }
        val around = priced.ifEmpty { shownDrivers.filter { it.coordinate != null } }
        val pins = DriverSort.Cheapest.sorted(around).take(ON_MAP).let { first ->
            val chosen = around.firstOrNull { it.id == pickedId }
            if (chosen != null && first.none { it.id == chosen.id }) first + chosen else first
        }
        // Zooming out: 0 is close by, 1 the bubbles have gone, 2 the circles too. Only a change of these redoes the screen.
        val zoomStage by remember {
            derivedStateOf {
                controller.moved
                val km = controller.widthKm
                if (km > CIRCLES_UP_TO_KM) 2 else if (km > BUBBLES_UP_TO_KM) 1 else 0
            }
        }
        // In order, the first ones first, as far as there's room: bubbles never overlap. The chosen driver always has one, so theirs goes first.
        // What lands under a bubble isn't drawn until there's room. Worked out once the map has stopped.
        var labelled by remember { mutableStateOf(emptySet<String>()) }
        var covered by remember { mutableStateOf(emptySet<String>()) }
        val mapWidth = constraints.maxWidth.toFloat()
        val mapHeight = constraints.maxHeight.toFloat()
        LaunchedEffect(controller.rested, pins.map { it.id }, zoomStage, cover, pickedId) {
            if (zoomStage > 0) {
                labelled = emptySet()
                covered = emptySet()
                return@LaunchedEffect
            }
            val d = density.density
            val top = with(density) { (statusTop + 40.dp).toPx() }
            val screen = android.graphics.RectF(0f, top, mapWidth, mapHeight - with(density) { cover.toPx() })
            val taken = mutableListOf(android.graphics.RectF(mapWidth - 118 * d, 0f, mapWidth, top + 130 * d))
            val boxes = mutableListOf<android.graphics.RectF>()
            val fits = mutableSetOf<String>()
            for (p in pins.filter { it.id == pickedId } + pins.filter { it.id != pickedId }) {
                val spot = p.coordinate?.let { controller.toScreen(it) } ?: continue
                val box = android.graphics.RectF(spot.x - 64 * d, spot.y - 47 * d, spot.x + 64 * d, spot.y + 14 * d)
                if (p.id != pickedId && (!screen.contains(box) || taken.any { android.graphics.RectF.intersects(it, box) })) continue
                taken.add(box)
                boxes.add(box)
                fits.add(p.id)
            }
            val under = mutableSetOf<String>()
            for (p in pins) {
                if (p.id in fits) continue
                val spot = p.coordinate?.let { controller.toScreen(it) } ?: continue
                val small = android.graphics.RectF(spot.x - 13 * d, spot.y - 13 * d, spot.x + 13 * d, spot.y + 13 * d)
                if (boxes.any { android.graphics.RectF.intersects(it, small) }) under.add(p.id)
            }
            labelled = fits
            covered = under
        }

        // Your driver's car: still for GPS wobble, gliding to a real move.
        val driverCar = steadyDriver.follow(ride?.driver?.coordinate, ride?.id)
        val lines = buildList {
            if (ride != null) addAll(routeLines(ride.route))
            if (quote != null) {
                addAll(routeLines(routeCoordinates))
                // Moved to where the road ends: where you tapped stays faint, dashed to where the car can get.
                val tapped = booking.dropoff
                if (tapped != null && (quote.dropoff.movedM ?: 0) > 25) {
                    add(MapLine(listOf(tapped.coordinate, quote.dropoff.coordinate), Theme.ink.copy(alpha = 0.5f), 2.5f, listOf(1f, 2.5f)))
                }
            }
        }
        val annotations = buildList {
            if (ride != null) {
                if (ride.status in listOf("searching", "offered", "open")) {
                    add(MapAnnotation("radar", ride.pickup.coordinate, MapAnchor.Center) { Radar() })
                }
                add(pickupAnnotation(ride.pickup.coordinate))
                add(dropoffAnnotation(ride.dropoff.coordinate))
                driverCar?.let { c ->
                    add(MapAnnotation("driver", c, MapAnchor.Center, glide = true) { DriverPin(ride.driver?.car?.kind, ride.etaShort, ride.driver?.car?.shownPlate) })
                }
            } else {
                pins.forEach { d ->
                    val c = d.coordinate ?: return@forEach
                    val style = when {
                        zoomStage == 2 -> PinStyle.Hidden
                        d.id in labelled -> PinStyle.Label
                        d.id in covered -> PinStyle.Hidden
                        else -> PinStyle.Circle
                    }
                    val seen = style != PinStyle.Hidden || pickedId == d.id
                    add(
                        MapAnnotation(
                            "d-${d.id}", c, MapAnchor.Center, glide = true,
                            onTap = if (seen) ({ tappedPin(d, style) }) else null,
                            // Holding a driver shows who it is, whatever a tap does right now.
                            onHold = if (seen) ({ booking.openDriver = d }) else null,
                        ) {
                            val offer = quote?.offers?.firstOrNull { it.id == d.id }
                            PricePin(
                                vehicle = d.car?.kind,
                                // The whole ride's price once there's a quote, what they ask per km until then.
                                text = offer?.priceCents?.let { Fmt.eur(it) } ?: "${Fmt.rate(d.perKmCents)}/km",
                                rating = d.rating,
                                // Once there's a quote: how long this driver needs to get to you.
                                eta = offer?.pickupS?.let { Fmt.minutes(it) },
                                verified = d.verified == true,
                                selected = pickedId == d.id,
                                busy = d.busy == true,
                                style = style,
                                modifier = Modifier.mapTapArea(),
                            )
                        },
                    )
                }
            }
            if (quote != null) {
                add(pickupAnnotation(quote.pickup.coordinate))
                val tapped = booking.dropoff
                if (tapped != null && (quote.dropoff.movedM ?: 0) > 25) {
                    add(
                        MapAnnotation("tapped", tapped.coordinate, MapAnchor.Center) {
                            Box(Modifier.size(12.dp).background(Theme.ink.copy(alpha = 0.35f), CircleShape).border(2.dp, Color.White, CircleShape))
                        },
                    )
                }
                add(dropoffAnnotation(quote.dropoff.coordinate))
            } else {
                // Moved by hand, before there's a route: the spot shows right away.
                if (ride == null) booking.pickup?.let { add(pickupAnnotation(it.coordinate)) }
                booking.dropoff?.let { add(dropoffAnnotation(it.coordinate)) }
            }
        }

        DzMap(
            modifier = Modifier.fillMaxSize(),
            controller = controller,
            lines = lines,
            annotations = annotations,
            showUser = true,
            bottomCover = cover,
            topCover = statusTop + 8.dp,
            onTap = { c ->
                if (app.ride == null) {
                    scope.launch {
                        val label = Places.name(c)
                        booking.dropoff = Place(c.lat, c.lng, label)
                        getQuote()
                    }
                }
            },
            onHold = { c ->
                if (app.ride == null && booking.openDriver == null && !showFilter && !showBid) scope.launch { movePickup(c) }
            },
        )
        Column(
            Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 8.dp, end = 14.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                Modifier
                    .height(44.dp)
                    .floating(22.dp)
                    .clip(CircleShape)
                    .clickable { showFilter = true }
                    .padding(horizontal = 14.dp)
                    .semantics { contentDescription = "Filter, showing drivers within ${radiusKm.toInt()} kilometres" },
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Sym.filter, null, tint = Theme.accentInk, modifier = Modifier.size(18.dp))
                Text("${radiusKm.toInt()} km", style = T.footnote.semibold, color = Theme.ink)
            }
            Box(
                Modifier.size(44.dp).floating(22.dp).clip(CircleShape).clickable { centre(force = true) },
                contentAlignment = Alignment.Center,
            ) {
                Icon(Sym.location, "Show where I am", tint = Theme.ink, modifier = Modifier.size(20.dp))
            }
        }
        // Picked before a route: the footer offers to book with them.
        val pickedDriver = if (quote == null) booking.driverId?.let { id -> shownDrivers.firstOrNull { it.id == id } } else null
        BottomPanel(
            state = panel,
            peek = peek,
            footer = if (ride == null && quote == null && !searching && pickedDriver != null) ({
                // A driver picked before there's a route: book with them, which asks where to; or let it be anyone again.
                Column(Modifier.background(Theme.card)) {
                    Hairline()
                    Row(
                        Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        GhostButton("Anyone", height = 50.dp, modifier = Modifier.widthIn(max = 112.dp), onClick = { booking.driverId = null })
                        PrimaryButton(
                            "${if (booking.planned) "Plan" else "Book"} with ${pickedDriver.name ?: "this driver"}",
                            modifier = Modifier.weight(1f),
                            onClick = { choose(pickedDriver, booking.planned) },
                        )
                    }
                }
            }) else if (ride == null && quote != null) ({
                Column(Modifier.background(Theme.card)) {
                    Hairline()
                    Row(
                        Modifier.fillMaxWidth().padding(start = 18.dp, end = 18.dp, top = 8.dp, bottom = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        val offer = booking.chosenOffer
                        GhostButton(
                            "Your price",
                            height = 50.dp,
                            modifier = if (offer == null) Modifier.weight(1f) else Modifier.widthIn(max = 112.dp),
                            onClick = {
                                booking.bidCents = quote.suggestedBidCents ?: 1000
                                showBid = true
                            },
                        )
                        if (offer != null) {
                            PrimaryButton(
                                "${if (booking.planned) "Plan" else "Book"} for ${Fmt.eur(offer.priceCents)}",
                                working = ordering,
                                modifier = Modifier.weight(1f),
                                onClick = { askToPay() },
                            )
                        }
                    }
                }
            }) else null,
        ) {
            Column(Modifier.padding(horizontal = 18.dp)) {
                when {
                    ride != null -> ActiveRide(ride)
                    quote != null -> QuoteStage(
                        booking, quote, sort, ::changeSort,
                        reQuote = { scope.launch { getQuote() } },
                        onRouteCard = { routeCard = it },
                    )
                    else -> IdleStage(
                        booking, shownDrivers, radiusKm.toInt(), searching, sort, maxOf(totalOnline ?: 0, shownDrivers.size), ::changeSort,
                        onSearching = { searching = it },
                        onPicked = { scope.launch { getQuote(showRoute = true) } },
                        onPickupHere = {
                            booking.pickup = null
                            scope.launch { loadDrivers() }
                        },
                    )
                }
            }
        }
    }

    EscrowMomentOver(if (app.showingRide == null) ride?.status else null, Fmt.eur(ride?.shownPriceCents), ride?.coin)

    if (showFilter) {
        DzSheet(onDismiss = { showFilter = false }, tall = false) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Filter", style = T.headline, color = Theme.ink, modifier = Modifier.weight(1f))
                    TextAction("Done", { showFilter = false })
                }
                SectionLabel("Show first")
                Segmented(DriverSort.entries.map { it.label }, DriverSort.entries.indexOf(sort)) { changeSort(DriverSort.entries[it]) }
                Text("In the list. The map shows the $ON_MAP cheapest. Best rated also counts how many reviews a driver has, so one 5-star review doesn’t come first.", style = T.footnote, color = Theme.faint)
                SectionLabel("Show drivers within")
                Text("${radiusKm.toInt()} km", style = T.headline, color = Theme.ink)
                DzSlider(radiusKm, 1f..40f) { radiusKm = it.toInt().toFloat() }
                SectionLabel("Vehicle")
                val options = listOf<String?>(null) + Vehicle.all
                Segmented(options.map { it?.let(Vehicle::name) ?: "Any" }, options.indexOf(booking.vehicle)) { i ->
                    booking.vehicle = options[i]
                    scope.launch { loadDrivers() }
                }
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Pets allowed", style = T.subheadline, color = Theme.ink, modifier = Modifier.weight(1f))
                    DzSwitch(petsOnly, "Pets allowed") { petsOnly = it }
                }
            }
        }
    }
    booking.openDriver?.let { d ->
        DzSheet(onDismiss = { booking.openDriver = null }) {
            NavStack {
                DriverProfileScreen(d.id, d, onBook = { planned -> choose(d, planned) }, close = { booking.openDriver = null })
            }
        }
    }
    if (showBid) {
        DzSheet(onDismiss = { showBid = false }, tall = false) {
            BidSheet(booking, close = { showBid = false }) {
                showBid = false
                // Any driver can claim a named price, so every way to pay is open.
                booking.payingFor = OrderToPay("bid", bid = booking.bidCents, cents = booking.bidCents)
            }
        }
    }
    if (booking.namingRoute) {
        RouteNameDialog(
            title = "Save this route",
            message = "It keeps the pickup and the drop-off. Find it in Rides, under Booked. It stays on this phone.",
            onDismiss = { booking.namingRoute = false },
        ) { name ->
            booking.namingRoute = false
            booking.quote?.let { q -> SavedRoutes.add(name, q.pickup, q.dropoff) }
        }
    }
    booking.payingFor?.let { pending ->
        DzSheet(onDismiss = { booking.payingFor = null }, tall = false) {
            PayChoice(pending, close = { booking.payingFor = null }) { coin ->
                booking.coin = coin
                booking.payingFor = null
                scope.launch { order(pending.mode, pending.bid) }
            }
        }
    }
}

// How the rider wants to pay, asked on booking. Only what the driver takes can be picked.
@Composable
private fun PayChoice(order: OrderToPay, close: () -> Unit, onPick: (String) -> Unit) {
    val subtitle = order.cents?.let { cents -> order.driver?.let { "${Fmt.eur(cents)} with $it" } ?: Fmt.eur(cents) }
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Row(Modifier.fillMaxWidth()) { TextAction("Close", close) }
        ScreenTitle("How do you want to pay?", subtitle)
        Column(Modifier.fillMaxWidth().lifted(0.45f, 22.dp).clip(RoundedCornerShape(22.dp)).background(Theme.card)) {
            Coins.payWith.forEachIndexed { i, coin ->
                if (i > 0) CardDivider()
                val open = order.takes?.contains(coin) != false
                Row(
                    Modifier
                        .fillMaxWidth()
                        .alpha(if (open) 1f else 0.5f)
                        .clickable(enabled = open) { onPick(coin) }
                        .padding(horizontal = 14.dp, vertical = 12.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    CoinBadge(coin, 36.dp)
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(Fmt.coinName(coin), style = T.subheadline.semibold, color = Theme.ink)
                        when {
                            !open -> Text(if (order.driver == null) "No driver here takes this." else "This driver doesn’t take this.", style = T.caption, color = Theme.muted)
                            coin == Coins.cash -> {
                                Text("Pay your driver in the car.", style = T.caption, color = Theme.muted)
                                Text("With cash you have less protection, and your transaction is finalised with the driver.", style = T.caption.medium, color = Theme.warn)
                            }
                            else -> Text("From your own wallet. Held in escrow until the ride is done.", style = T.caption, color = Theme.muted)
                        }
                    }
                    if (open) Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}

// What comes first in the list, right on top of it.
@Composable
private fun SortMenu(sort: DriverSort, font: androidx.compose.ui.text.TextStyle, onSort: (DriverSort) -> Unit) {
    MenuFrom({ open ->
        Row(Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = open), horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(sort.listTitle, style = font, color = Theme.ink, maxLines = 1)
            Icon(Sym.chevronDown, null, tint = Theme.accentInk, modifier = Modifier.size(20.dp))
        }
    }) {
        DriverSort.entries.forEach { s -> Item(s.label, if (s == sort) Sym.check else null) { onSort(s) } }
    }
}

@Composable
private fun ActiveRide(ride: Ride) {
    val app = AppState
    Column(Modifier.padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(
            Modifier.fillMaxWidth().clickable { app.showingRide = ride },
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(ride.statusTitle, style = T.title3.bold.kern(-0.3f), color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    ride.comingLine ?: ride.dropoff.label ?: "Your ride",
                    style = T.subheadline, color = Theme.muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
            Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(20.dp))
        }
        RideSteps(ride)
        ride.driver?.let { d ->
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                CarTile(d.car, 50.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(d.name ?: "Your driver", style = T.subheadline.semibold, color = Theme.ink, maxLines = 1)
                    d.car?.shownPlate?.let { PlateView(it, 12.dp) }
                }
                MessageButton(d.id, d.name ?: "your driver")
            }
        }
        if (rideStateCardShows(ride)) RideStateCard(ride)
        // A driver accepted: pay right here.
        if (ride.needsPayment) PayRideCard(ride)
        if (rideCancelShows(ride)) RideCancelButton(ride)
    }
}

@Composable
private fun IdleStage(
    booking: Booking,
    shownDrivers: List<DriverCard>,
    radiusKm: Int,
    searching: Boolean,
    sort: DriverSort,
    online: Int,
    onSort: (DriverSort) -> Unit,
    onSearching: (Boolean) -> Unit,
    onPicked: () -> Unit,
    onPickupHere: () -> Unit,
) {
    Column(Modifier.padding(top = 2.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        WhereToSearch(booking, searching, onSearching, onPicked)
        if (!searching) {
            booking.pickup?.let { MovedPickup(it, onPickupHere) }
            WhenSwitch(booking.planned) { booking.planned = it }
            if (booking.planned) PlanTime(booking.planDate) { booking.planDate = it }
            Column(Modifier.padding(top = 6.dp)) {
                Row(Modifier.padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    SortMenu(sort, T.title3.bold.kern(-0.3f), onSort)
                    Spacer(Modifier.weight(1f))
                    Box(Modifier.size(7.dp).background(if (shownDrivers.isEmpty()) Theme.faint else Theme.ok, CircleShape))
                    Spacer(Modifier.width(5.dp))
                    Text("${if (booking.planned) shownDrivers.size else online} online", style = T.footnote.medium, color = Theme.muted)
                }
                if (online > ON_MAP && !booking.planned) {
                    Text("The $ON_MAP cheapest are on the map.", style = T.footnote, color = Theme.muted, modifier = Modifier.padding(bottom = 6.dp))
                }
                if (shownDrivers.isEmpty()) {
                    Text(
                        if (booking.planned) "No driver within $radiusKm km takes planned rides right now. You can still name your price."
                        else "No drivers online within $radiusKm km right now. You can still plan a ride, or name your price.",
                        style = T.subheadline, color = Theme.muted,
                    )
                }
                // A tap picks a driver to book with, a tap on the picked one opens their page; so does their vehicle's picture, and holding it.
                sort.sorted(shownDrivers).take(ON_LIST).forEach { d ->
                    val selected = booking.driverId == d.id
                    val shape = RoundedCornerShape(Theme.radius)
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .clip(shape)
                            .background(if (selected) Theme.accentSoft.copy(alpha = 0.55f) else Color.Transparent, shape)
                            .border(2.dp, if (selected) Theme.accent else Color.Transparent, shape)
                            .combinedClickable(onLongClick = { booking.openDriver = d }) { if (selected) booking.openDriver = d else booking.driverId = d.id }
                            .padding(10.dp),
                    ) { DriverRow(d, null, note = if (sort == DriverSort.OnTime) d.arrivalScore?.let { "$it% on time" } ?: "No rides yet" else null, onIcon = { booking.openDriver = d }) }
                }
            }
        }
    }
}

// A pickup moved away from where you are, and the way back.
@Composable
private fun MovedPickup(spot: Place, onHere: () -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Sym.pickup, null, tint = Theme.pickupPin, modifier = Modifier.size(22.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(spot.label ?: "Pickup", style = T.subheadline.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("Your pickup: your driver waits here", style = T.caption, color = Theme.muted, maxLines = 1)
        }
        Box(
            Modifier.size(30.dp).background(Theme.card, CircleShape).clip(CircleShape).clickable(onClick = onHere).semantics { contentDescription = "Pick up where I am" },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Sym.close, null, tint = Theme.ink, modifier = Modifier.size(16.dp))
        }
    }
}

// The time of a planned ride, between a quarter of an hour and a week from now.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlanTime(at: Double, onChange: (Double) -> Unit) {
    val zone = ZoneId.systemDefault()
    val soonest = System.currentTimeMillis() + 16 * 60_000.0
    val latest = System.currentTimeMillis() + 7 * 86_400_000.0
    fun clamp(ms: Double) = ms.coerceIn(soonest, latest)
    val local = LocalDateTime.ofInstant(Instant.ofEpochMilli(at.toLong()), zone)
    var pickDate by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("Pick-up", style = T.subheadline.medium, color = Theme.ink, modifier = Modifier.weight(1f))
        DateChip(Fmt.weekdayDayMonth(at)) { pickDate = true }
        DateChip(Fmt.time(at)) { pickTime = true }
    }
    if (pickDate) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = local.toLocalDate().atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli(),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean {
                    val day = Instant.ofEpochMilli(utcTimeMillis).atZone(java.time.ZoneOffset.UTC).toLocalDate()
                    val first = Instant.ofEpochMilli(soonest.toLong()).atZone(zone).toLocalDate()
                    val last = Instant.ofEpochMilli(latest.toLong()).atZone(zone).toLocalDate()
                    return !day.isBefore(first) && !day.isAfter(last)
                }
            },
        )
        DatePickerDialog(
            onDismissRequest = { pickDate = false },
            confirmButton = {
                TextButton(onClick = {
                    pickDate = false
                    state.selectedDateMillis?.let { ms ->
                        val day = Instant.ofEpochMilli(ms).atZone(java.time.ZoneOffset.UTC).toLocalDate()
                        onChange(clamp(day.atTime(local.toLocalTime()).atZone(zone).toInstant().toEpochMilli().toDouble()))
                    }
                }) { Text("Done", color = Theme.accentInk) }
            },
        ) { DatePicker(state = state) }
    }
    if (pickTime) {
        val state = rememberTimePickerState(local.hour, local.minute, is24Hour = android.text.format.DateFormat.is24HourFormat(androidx.compose.ui.platform.LocalContext.current))
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { pickTime = false },
            containerColor = Theme.card,
            text = { TimePicker(state = state) },
            confirmButton = {
                TextButton(onClick = {
                    pickTime = false
                    onChange(clamp(local.toLocalDate().atTime(state.hour, state.minute).atZone(zone).toInstant().toEpochMilli().toDouble()))
                }) { Text("Done", color = Theme.accentInk) }
            },
        )
    }
}

@Composable
private fun DateChip(text: String, onClick: () -> Unit) {
    Box(
        Modifier.height(36.dp).background(Theme.soft, RoundedCornerShape(10.dp)).clip(RoundedCornerShape(10.dp)).clickable(onClick = onClick).padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = T.subheadline.medium, color = Theme.ink)
    }
}

@Composable
private fun QuoteStage(booking: Booking, quote: Quote, sort: DriverSort, onSort: (DriverSort) -> Unit, reQuote: () -> Unit, onRouteCard: (androidx.compose.ui.unit.Dp) -> Unit) {
    val density = LocalDensity.current
    Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .onSizeChanged { onRouteCard(with(density) { it.height.toDp() }) }
                .background(Theme.soft, RoundedCornerShape(Theme.radius))
                .padding(14.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                PlaceLine(Sym.circle, false, quote.pickup.label ?: "Your location", quote.pickup.movedM, note = "Your driver waits here. Hold the map to move it.")
                PlaceLine(Sym.flag, true, quote.dropoff.label ?: "Drop-off", quote.dropoff.movedM)
                Text(
                    "${Fmt.km(quote.distanceM)} · ${Fmt.minutes(quote.durationS)}${if (quote.estimated == true) " · estimate" else ""}",
                    style = T.footnote.medium, color = Theme.muted, modifier = Modifier.padding(start = 24.dp),
                )
            }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(
                    Modifier.size(30.dp).background(Theme.card, CircleShape).clip(CircleShape).clickable { booking.clear() }.semantics { contentDescription = "Start over" },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(Sym.close, null, tint = Theme.ink, modifier = Modifier.size(16.dp))
                }
                val saved = SavedRoutes.has(quote.pickup, quote.dropoff)
                Box(
                    Modifier
                        .size(30.dp)
                        .background(Theme.card, CircleShape)
                        .clip(CircleShape)
                        .clickable(enabled = !saved) { booking.namingRoute = true }
                        .semantics { contentDescription = if (saved) "This route is saved" else "Save this route" },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(if (saved) Sym.bookmarkFill else Sym.bookmark, null, tint = if (saved) Theme.accentInk else Theme.ink, modifier = Modifier.size(17.dp))
                }
            }
        }
        // Now or later, and who's coming along.
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            WhenSwitch(booking.planned) {
                booking.planned = it
                booking.driverId = null
                reQuote()
            }
            if (booking.planned) PlanTime(booking.planDate) {
                booking.planDate = it
                reQuote()
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                MenuFrom({ open -> OptionChip("${booking.passengers}", Sym.people, onClick = open) }) {
                    for (n in 1..8) Item(Fmt.people(n)) {
                        booking.passengers = n
                        reQuote()
                    }
                }
                OptionChip("Pet", Sym.paw, on = booking.pets, label = if (booking.pets) "Bringing a pet" else "No pet") {
                    booking.pets = !booking.pets
                    reQuote()
                }
                MenuFrom({ open -> OptionChip(booking.vehicle?.let(Vehicle::name) ?: "Any", Sym.vehicle(booking.vehicle), onClick = open) }) {
                    Item("Any vehicle") {
                        booking.vehicle = null
                        booking.driverId = null
                        reQuote()
                    }
                    Vehicle.all.forEach { kind ->
                        Item(Vehicle.name(kind)) {
                            booking.vehicle = kind
                            booking.driverId = null
                            reQuote()
                        }
                    }
                }
                Spacer(Modifier.weight(1f))
                MenuFrom({ open -> OptionChip(Fmt.coinSymbol(booking.coin), if (booking.coin == Coins.cash) Sym.banknote else Sym.coin, onClick = open) }) {
                    Coins.payWith.forEach { c ->
                        Item(Fmt.coinName(c)) {
                            booking.coin = c
                            booking.driverId = null
                            reQuote()
                        }
                    }
                }
            }
        }
        OffersList(booking, sort, onSort)
        CancelTerms(booking.planned)
        ErrorText(booking.error)
    }
}

@Composable
private fun PlaceLine(icon: ImageVector, flag: Boolean, text: String, moved: Int?, note: String? = null) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(icon, null, tint = if (flag) Theme.ink else Theme.pickupPin, modifier = Modifier.padding(top = 3.dp).size(if (flag) 15.dp else 11.dp).width(14.dp))
        Column(verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(text, style = T.subheadline.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (note != null) Text(note, style = T.caption, color = Theme.muted)
            if (moved != null && moved > 25) {
                Text(
                    if (flag && moved > 150) "Moved $moved m to where the road ends: your driver can’t get closer. Check-out works within 200 m of the flag."
                    else "Moved $moved m to where a car can stop",
                    style = T.caption, color = Theme.faint,
                )
            }
        }
    }
}

@Composable
private fun OptionChip(text: String, icon: ImageVector, on: Boolean = false, label: String? = null, onClick: () -> Unit) {
    Row(
        Modifier
            .height(36.dp)
            .background(if (on) Theme.accent else Theme.soft, CircleShape)
            .clip(CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp)
            .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = if (on) Theme.onAccent else Theme.ink, modifier = Modifier.size(16.dp))
        Text(text, style = T.footnote.semibold, color = if (on) Theme.onAccent else Theme.ink)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun OffersList(booking: Booking, sort: DriverSort, onSort: (DriverSort) -> Unit) {
    Column {
        val offers = booking.quote?.offers
        if (booking.loading) {
            Box(Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) { Spinner() }
        } else if (!offers.isNullOrEmpty()) {
            val list = sort.sorted(offers).take(ON_LIST)
            val cheapest = offers.minByOrNull { it.priceCents ?: 0 }?.id
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                SortMenu(sort, T.subheadline.semibold.kern(-0.3f), onSort)
                Spacer(Modifier.weight(1f))
                Text("${list.size} ${if (list.size == 1) "driver" else "drivers"}", style = T.footnote.medium, color = Theme.muted)
            }
            list.forEach { d ->
                val selected = booking.chosenOffer?.id == d.id
                val shape = RoundedCornerShape(Theme.radius)
                Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(shape)
                        .background(if (selected) Theme.accentSoft.copy(alpha = 0.55f) else Color.Transparent, shape)
                        .border(2.dp, if (selected) Theme.accent else Color.Transparent, shape)
                        .combinedClickable(onLongClick = { booking.openDriver = d }) { if (selected) booking.openDriver = d else booking.driverId = d.id }
                        .padding(10.dp),
                ) {
                    DriverRow(
                        d, d.priceCents,
                        label = if (d.id == cheapest) "Cheapest" else null,
                        note = if (d.afterAnotherDrive == true) "Already nearby after another drive" else if (sort == DriverSort.OnTime) d.arrivalScore?.let { "$it% on time" } ?: "No rides yet" else null,
                        onIcon = { booking.openDriver = d },
                    )
                }
            }
        } else {
            Text(
                if (booking.planned) "No driver fits this time yet. Name your price and drivers can claim it."
                else "No drivers can take this right now. Name your price and drivers nearby can claim it.",
                style = T.subheadline, color = Theme.muted,
            )
        }
    }
}

@Composable
private fun BidSheet(booking: Booking, close: () -> Unit, place: () -> Unit) {
    val cheapest = booking.quote?.offers?.firstOrNull()?.priceCents
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { TextAction("Close", close) }
        ScreenTitle("Name your price", "Drivers nearby see your order on their map and can claim it at this price.")
        Row(verticalAlignment = Alignment.CenterVertically) {
            RoundStep(Sym.minus, "50 cents less") { booking.bidCents = maxOf(100, booking.bidCents - 50) }
            Spacer(Modifier.weight(1f))
            Text(Fmt.eur(booking.bidCents), style = T.size(46).bold.digits.kern(-1.2f), color = Theme.ink, maxLines = 1)
            Spacer(Modifier.weight(1f))
            RoundStep(Sym.plus, "50 cents more") { booking.bidCents = minOf(100_000, booking.bidCents + 50) }
        }
        PriceRuler(booking.bidCents, cheapest) { booking.bidCents = it }
        if (cheapest != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(7.dp).background(Theme.ok, CircleShape))
                Text("The cheapest driver right now asks ${Fmt.eur(cheapest)}.", style = T.footnote, color = Theme.muted)
            }
        }
        ErrorText(booking.error)
        PrimaryButton("Place order for ${Fmt.eur(booking.bidCents)}", onClick = place)
    }
}

@Composable
private fun RoundStep(icon: ImageVector, label: String, onClick: () -> Unit) {
    Box(Modifier.size(52.dp).background(Theme.soft, CircleShape).clip(CircleShape).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Icon(icon, label, tint = Theme.ink, modifier = Modifier.size(22.dp))
    }
}

@Composable
// `onIcon`: where tapping the row does something else, the vehicle's picture opens their page.
fun DriverRow(driver: DriverCard, price: Int?, label: String? = null, note: String? = null, onIcon: (() -> Unit)? = null) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(if (onIcon != null) Modifier.clip(RoundedCornerShape(12.dp)).clickable(onClickLabel = "See driver", onClick = onIcon) else Modifier) { CarTile(driver.car, 54.dp) }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(driver.name ?: "Driver", style = T.callout.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (driver.verified == true) VerifiedMark(14.dp)
                if (label != null) StatusPill(label, Theme.ok, Theme.okSoft)
                if (driver.busy == true) StatusPill("On a drive", Theme.warn, Theme.warnSoft)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                RatingLabel(driver.rating, driver.ratingCount)
                driver.car?.seats?.let { seats ->
                    Text(
                        "· ${if (driver.car.kind == "car") "" else "${Vehicle.name(driver.car.kind)}, "}$seats ${if (seats == 1) "seat" else "seats"}",
                        style = T.footnote, color = Theme.muted, maxLines = 1,
                    )
                }
                if (driver.petsAllowed == true) Icon(Sym.paw, null, tint = Theme.muted, modifier = Modifier.size(12.dp))
            }
            if (note != null) Text(note, style = T.caption, color = Theme.muted)
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            if (price != null) {
                Text(Fmt.eur(price), style = T.size(18).bold.kern(-0.3f), color = Theme.ink)
                driver.pickupS?.let { Text("in ${Fmt.minutes(it)}", style = T.footnote, color = Theme.muted) }
            } else {
                Text("${Fmt.rate(driver.perKmCents)}/km", style = T.callout.bold.kern(-0.2f), color = Theme.ink)
                driver.distanceM?.let { Text(Fmt.km(it), style = T.footnote, color = Theme.muted) }
            }
        }
    }
}

// "Where to?" typed right in the panel: results show under it while the panel opens up. A pickup can be changed too.
@Composable
private fun WhereToSearch(booking: Booking, active: Boolean, onActive: (Boolean) -> Unit, onPicked: () -> Unit) {
    val scope = rememberCoroutineScope()
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    var text by remember { mutableStateOf("") }
    var pickupText by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Places.Completion>>(emptyList()) }
    var editingPickup by remember { mutableStateOf(false) }
    var recent by remember { mutableStateOf<List<Ride>>(emptyList()) }
    val current = if (editingPickup) pickupText else text

    LaunchedEffect(Unit) {
        attempt { ApiClient.get<RidesResponse>("/api/rides") }?.let { recent = it.rides ?: emptyList() }
    }
    // A moment after the last key, so a word isn't asked for letter by letter.
    LaunchedEffect(current, editingPickup) {
        if (current.isBlank()) {
            results = emptyList()
            return@LaunchedEffect
        }
        delay(250)
        results = Places.search(current, LocationService.location?.place)
    }
    LaunchedEffect(active) {
        if (active) focus.requestFocus() else {
            focusManager.clearFocus()
            editingPickup = false
        }
    }
    val uniqueRecent = remember(recent) {
        val seen = mutableSetOf<String>()
        recent.map { it.dropoff }.filter { p -> p.label != null && seen.add(p.label) }.take(5)
    }

    fun close() {
        focusManager.clearFocus()
        editingPickup = false
        onActive(false)
    }

    fun pick(place: Place) {
        booking.dropoff = place
        text = ""
        close()
        onPicked()
    }

    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(
            Modifier
                .fillMaxWidth()
                .height(60.dp)
                .background(Theme.soft, RoundedCornerShape(Theme.radius))
                .border(2.dp, if (active) Theme.accent else Color.Transparent, RoundedCornerShape(Theme.radius))
                .padding(horizontal = 18.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(if (editingPickup) Sym.pickup else Sym.search, null, tint = Theme.ink, modifier = Modifier.size(24.dp))
            BasicTextField(
                value = current,
                onValueChange = { if (editingPickup) pickupText = it else text = it },
                singleLine = true,
                textStyle = T.title3.semibold.kern(-0.3f).copy(color = Theme.ink),
                cursorBrush = SolidColor(Theme.accentInk),
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Search),
                // As on iOS, the keyboard's search key puts the keyboard away so all the results show. The search stays open.
                keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focus)
                    .testTag("where-to")
                    .onFocusChanged { if (it.isFocused) onActive(true) }
                    .semantics { contentDescription = if (editingPickup) "Pickup spot" else "Where to?" },
                decorationBox = { inner ->
                    Box {
                        if (current.isEmpty()) Text(if (editingPickup) "Pickup spot" else "Where to?", style = T.title3.semibold.kern(-0.3f), color = Theme.ink)
                        inner()
                    }
                },
            )
            if (active) TextAction("Cancel", { close() })
        }
        if (active) {
            Row(
                Modifier.fillMaxWidth().clickable {
                    editingPickup = !editingPickup
                    focus.requestFocus()
                }.padding(horizontal = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Sym.circle, null, tint = Theme.pickupPin, modifier = Modifier.size(10.dp))
                Text("From ${booking.pickup?.label ?: "your location"}", style = T.subheadline.medium, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(if (editingPickup) "Done" else "Change", style = T.footnote.semibold, color = Theme.accentInk)
            }
            Column {
                if (editingPickup) {
                    if (booking.pickup != null) ResultRow(Sym.location, "Use my location", null) {
                        booking.pickup = null
                        editingPickup = false
                    }
                    results.forEach { r ->
                        ResultRow(Sym.mapPin, r.title, r.subtitle) {
                            booking.pickup = r.place
                            editingPickup = false
                            pickupText = ""
                        }
                    }
                } else if (text.isEmpty()) {
                    uniqueRecent.forEach { p -> ResultRow(Sym.recent, p.label ?: "Place", null) { pick(p) } }
                    ResultRow(Sym.tap, "Choose on the map", "Close this and tap where you’re going") { close() }
                } else {
                    results.forEach { r -> ResultRow(Sym.mapPin, r.title, r.subtitle) { pick(r.place) } }
                }
            }
        } else if (uniqueRecent.isNotEmpty()) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                uniqueRecent.forEach { place ->
                    Row(
                        Modifier.height(36.dp).background(Theme.soft, CircleShape).clip(CircleShape).clickable { pick(place) }.padding(horizontal = 12.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Sym.recent, null, tint = Theme.ink, modifier = Modifier.size(15.dp))
                        Text(place.label ?: "Place", style = T.footnote.semibold, color = Theme.ink, maxLines = 1)
                    }
                }
            }
        }
    }
}

@Composable
private fun ResultRow(symbol: ImageVector, title: String, subtitle: String?, action: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = action).padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconTile(symbol, Theme.ink, Theme.soft)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = T.subheadline.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrEmpty()) Text(subtitle, style = T.caption, color = Theme.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

// A driver's page: pictures, plate, prices, reviews, when they're free. Book now or plan.
@Composable
fun DriverProfileScreen(driverId: String, card: DriverCard? = null, onBook: ((Boolean) -> Unit)? = null, close: () -> Unit) {
    val app = AppState
    var profile by remember { mutableStateOf<DriverProfile?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val driver = profile?.driver ?: card

    LaunchedEffect(driverId) {
        val opened = System.currentTimeMillis()
        try {
            val loaded: DriverProfile = ApiClient.get("/api/drivers/$driverId")
            // Not while the sheet is sliding up: the rest of the page would be laid out in the middle of it.
            if (card != null) delay(maxOf(0L, 700 - (System.currentTimeMillis() - opened)))
            profile = loaded
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.shown
        }
    }

    Screen(
        title = driver?.name ?: "Driver",
        close = close,
        actions = {
            if (app.user?.id != driverId && driver != null) PersonMenu(driver.id, driver.name ?: "this driver", onBlocked = close)
        },
        bottom = if (onBook != null && driver != null) ({
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                if ((profile?.availability?.allowsPlanning ?: driver.allowsPlanning) == true) {
                    GhostButton("Plan", modifier = Modifier.weight(1f), onClick = { onBook(true) })
                }
                PrimaryButton("Book now", modifier = Modifier.weight(1f), enabled = driver.online == true && driver.busy != true, onClick = { onBook(false) })
            }
        }) else null,
    ) {
        if (driver == null) {
            if (error != null) Text(error ?: "", color = Theme.muted, modifier = Modifier.padding(40.dp))
            else Box(Modifier.fillMaxWidth().padding(60.dp), contentAlignment = Alignment.Center) { Spinner() }
            return@Screen
        }
        driver.car?.let { car -> ProfileCarCard(car) }
        DriverIdCard(driver)
        driver.car?.let { car ->
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FactTile(Sym.vehicle(car.kind), Vehicle.name(car.kind), car.colorName ?: "")
                FactTile(Sym.people, "${car.seats ?: 1}", if ((car.seats ?: 1) == 1) "passenger" else "passengers")
                FactTile(Sym.paw, if (driver.petsAllowed == true) "Yes" else "No", "pets")
            }
        }
        Column(Modifier.fillMaxWidth().card(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Prices", style = T.title3.bold.kern(-0.3f), color = Theme.ink)
            Row(verticalAlignment = Alignment.CenterVertically) {
                PriceColumn(Fmt.rate(driver.perKmCents), "per km")
                VerticalHairline()
                PriceColumn(Fmt.rate(driver.perMinCents), "per minute")
                VerticalHairline()
                PriceColumn(Fmt.rate(driver.pickupPerKmCents), "to you, km")
            }
        }
        if (app.user?.id != driverId) MessageButton(driver.id, driver.name ?: "this driver", big = true)
        val p = profile
        if (p != null) {
            p.availability?.let { AvailabilityCard(it, driver.online == true) }
            ReviewsList(p.reviews ?: emptyList())
        } else if (error == null) {
            Box(Modifier.fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.Center) { Spinner() }
        }
    }
}

@Composable
private fun ProfileCarCard(car: Car) {
    Column(Modifier.fillMaxWidth().lifted(0.45f, 24.dp).background(Theme.card, RoundedCornerShape(24.dp))) {
        Box(Modifier.padding(10.dp)) { CarGallery(car, 200.dp) }
        Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(car.title, style = T.title3.bold, color = Theme.ink, maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                PlateView(car.shownPlate, 14.dp)
                // A plate found in the RDW is only checked: a green circle, so it can't look like a driver's blue check.
                if (car.verified == true) LabelRow(Sym.checkCircle, "Checked", T.caption.semibold, Theme.ok)
            }
        }
    }
}

@Composable
private fun DriverIdCard(d: DriverCard) {
    Column(Modifier.fillMaxWidth().card(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(56.dp).background(Theme.gradient, CircleShape), contentAlignment = Alignment.Center) {
                Text((d.name ?: "D").take(1).uppercase(), style = T.size(24).bold, color = Theme.onAccent)
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(d.name ?: "Driver", style = T.title3.bold, color = Theme.ink, maxLines = 1)
                if (d.verified == true) VerifiedBadge()
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Stars(kotlin.math.round(d.rating ?: 0.0).toInt(), 12.dp)
                    Text("${Fmt.rating(d.rating, d.ratingCount)} · ${d.ridesDone ?: 0} ${if (d.ridesDone == 1) "ride" else "rides"}", style = T.caption, color = Theme.muted, maxLines = 1)
                }
            }
            val free = d.online == true && d.busy != true
            StatusPill(if (d.busy == true) "On a ride" else if (d.online == true) "Online" else "Offline", if (free) Theme.ok else Theme.muted, if (free) Theme.okSoft else Theme.soft)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            StatTile(d.completedPercent?.let { "$it%" } ?: "–", "completed", T.title3.bold.digits.kern(-0.3f), 16.dp)
            StatTile(d.arrivalScore?.let { "$it%" } ?: "–", "on time", T.title3.bold.digits.kern(-0.3f), 16.dp)
            StatTile(d.rating?.let { String.format(Locale.US, "%.1f", it) } ?: "New", "rating", T.title3.bold.digits.kern(-0.3f), 16.dp)
        }
        if (!d.bio.isNullOrEmpty()) Text("“${d.bio}”", style = T.subheadline.italic, color = Theme.muted)
        val coins = d.coins?.filter { it in Coins.payWith }
        if (!coins.isNullOrEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Takes", style = T.caption.semibold, color = Theme.faint)
                coins.forEach { CoinBadge(it, 24.dp) }
            }
        }
    }
}

@Composable
private fun AvailabilityCard(a: Availability, online: Boolean) {
    Column(Modifier.fillMaxWidth().card(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("When you can book", style = T.title3.bold.kern(-0.3f), color = Theme.ink)
        Row(verticalAlignment = Alignment.CenterVertically) {
            LabelRow(if (online) Sym.radio else Sym.sleep, if (online) "Online now" else "Offline now", T.subheadline.semibold, if (online) Theme.ok else Theme.muted, modifier = Modifier.weight(1f))
            usualHours(a.usualHoursUtc)?.let { Text("Usually $it", style = T.caption, color = Theme.faint) }
        }
        LabelRow(
            Sym.calendar,
            if (a.allowsPlanning == true) (if ((a.planDays ?: 7) == 1) "Plan up to 1 day ahead" else "Plan up to ${a.planDays ?: 7} days ahead") else "Doesn’t take planned rides",
            T.subheadline, Theme.ink, Theme.accentInk,
        )
        if (a.allowsPlanning == true && a.bookable != true) {
            Text("Not online in the last 24 hours, so can’t be planned right now.", style = T.footnote, color = Theme.muted)
        }
        a.busy?.take(5)?.forEach { b ->
            val from = b.from
            val to = b.to
            if (from != null && to != null) LabelRow(Sym.badgeX, "Booked ${Fmt.dayTime(from)}–${Fmt.time(to)}", T.footnote, Theme.faint)
        }
    }
}

@Composable
fun ReviewsList(list: List<eu.drivezzz.app.core.DriverReview>) {
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text("What riders say", style = T.title3.bold.kern(-0.3f), color = Theme.ink, modifier = Modifier.padding(horizontal = 4.dp))
        if (list.isEmpty()) {
            Text("No reviews yet.", style = T.subheadline, color = Theme.muted, modifier = Modifier.fillMaxWidth().card(22.dp))
        }
        list.forEach { r ->
            Column(Modifier.fillMaxWidth().card(22.dp, 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Stars(r.stars ?: 0)
                    Spacer(Modifier.weight(1f))
                    r.at?.let { Text(Fmt.dayMonth(it), style = T.caption, color = Theme.faint) }
                }
                if (!r.text.isNullOrEmpty()) Text(r.text, style = T.subheadline, color = Theme.ink)
            }
        }
    }
}

// The longest stretch of hours they tend to be online, in this phone's time.
private fun usualHours(utc: List<Double>?): String? {
    if (utc == null || utc.size != 24) return null
    val shift = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 3_600_000
    val local = BooleanArray(24)
    for (h in 0 until 24) if (utc[h] >= 0.15) local[(h + shift + 24) % 24] = true
    var bestStart = 0
    var bestLength = 0
    var start = -1
    for (h in 0..24) {
        if (h < 24 && local[h]) {
            if (start < 0) start = h
        } else if (start >= 0) {
            if (h - start > bestLength) {
                bestStart = start
                bestLength = h - start
            }
            start = -1
        }
    }
    if (bestLength <= 0) return null
    return String.format(Locale.US, "%02d:00–%02d:00", bestStart, (bestStart + bestLength) % 24)
}
