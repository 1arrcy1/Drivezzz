package eu.drivezzz.app.features

import android.content.Context
import android.location.Location
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.ChatThread
import eu.drivezzz.app.core.DataMeter
import eu.drivezzz.app.core.DriverHome
import eu.drivezzz.app.core.E2E
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.LatLng
import eu.drivezzz.app.core.LocationService
import eu.drivezzz.app.core.MarketOrder
import eu.drivezzz.app.core.MarketResponse
import eu.drivezzz.app.core.Notifier
import eu.drivezzz.app.core.OnLocation
import eu.drivezzz.app.core.Permissions
import eu.drivezzz.app.core.Place
import eu.drivezzz.app.core.Ride
import eu.drivezzz.app.core.RideResponse
import eu.drivezzz.app.core.ServerClock
import eu.drivezzz.app.core.UnderReview
import eu.drivezzz.app.core.Vehicle
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.core.course
import eu.drivezzz.app.core.Coins
import eu.drivezzz.app.core.forYouFirst
import eu.drivezzz.app.core.place
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.core.speedOrNull
import eu.drivezzz.app.map.DzMap
import eu.drivezzz.app.map.MapAnchor
import eu.drivezzz.app.map.MapAnnotation
import eu.drivezzz.app.map.MapController
import eu.drivezzz.app.map.MapLine
import eu.drivezzz.app.map.Router
import eu.drivezzz.app.map.rememberMapController
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.min

// The Driving tab: the map, with a slide to go online or offline, and your earnings in a panel that stays minimized until you
// slide it up. Going online shares the phone's position with the notification on, also with the app in the background, until you
// slide back or tap Go offline in the notification. A drive happens on this same map: its route, directions and buttons take over from the panel.
@Composable
fun DrivingScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val density = LocalDensity.current
    var home by remember { mutableStateOf<DriverHome?>(null) }
    var orders by remember { mutableStateOf<List<MarketOrder>>(emptyList()) }
    var booked by remember { mutableStateOf<List<Ride>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var starting by remember { mutableStateOf(false) }
    var showRules by remember { mutableStateOf(false) }
    // Held here, so the map stays on it to show the end of a drive after the server has moved on.
    var drive by remember { mutableStateOf<Ride?>(null) }
    var openOrder by remember { mutableStateOf<MarketOrder?>(null) }
    val panel = rememberPanelState(PanelDetent.Peek)
    val controller = rememberMapController()
    val heading = remember { DriveHeading() }
    val nav = remember { DriveNavigator(context) }
    var following by remember { mutableStateOf(true) }
    val peek = 52.dp
    val navigating = app.driveOpen && drive != null

    fun recentre() {
        LocationService.location?.place?.let { controller.centre(it, 2500.0) }
    }

    suspend fun loadOrders() {
        val here = LocationService.location ?: return
        attempt { ApiClient.get<MarketResponse>("/api/driver/market?lat=${here.latitude}&lng=${here.longitude}&radiusKm=${app.driverRadiusKm.toInt()}") }?.let {
            orders = it.orders ?: emptyList()
            if (it.booked != null || booked.isNotEmpty()) booked = it.booked ?: emptyList()
        }
    }

    // A ride of your own, from its number on the map (Pieter, 8 November 2026): the one on now opens its directions, as its card
    // does; another opens its page, as on Drives.
    fun openBooked(ride: Ride) {
        val live = app.driving.drive
        if (live != null && live.id == ride.id) {
            drive = live
            following = true
            app.driveOpen = true
        } else {
            app.mapRide = ride
        }
    }

    suspend fun load() {
        val tz = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000
        attempt { ApiClient.get<DriverHome>("/api/driver/home?tzMinutes=$tz") }?.let {
            home = it
            // The connection is back: don't keep saying it's gone.
            if (error == eu.drivezzz.app.core.ApiError.OFFLINE_MESSAGE) error = null
        }
        app.loadDriver()
        loadOrders()
    }

    suspend fun goOnline() {
        // Without it there's no notification with Go offline, and no word of a new ride with the app closed. Someone who said no at
        // the start gets another chance here, the moment it matters, if Android still lets us ask.
        if (!Notifier.allowed) Permissions.ask(android.Manifest.permission.POST_NOTIFICATIONS)
        starting = true
        app.goOnline()?.let { error = it }
        starting = false
    }

    suspend fun toggle() {
        error = null
        if (app.driveMode) {
            if (app.driving.drive != null) {
                error = "You have a rider. Finish the drive, or cancel it, before you go offline."
                return
            }
            app.stopDriving()
            return
        }
        if (app.driver?.rulesSeenAt == null) {
            showRules = true
            return
        }
        goOnline()
    }

    LaunchedEffect(app.rev) { load() }
    LaunchedEffect(app.driverRadiusKm) { load() }
    LaunchedEffect(Unit) {
        // After the map's own first layout, which would otherwise win.
        delay(400)
        recentre()
        // Orders change often, your earnings hardly, and news comes through by itself. Only for someone looking at it.
        var round = 0
        while (true) {
            delay(30_000)
            if (!app.isActive) continue
            round++
            if (round % 4 == 0) load() else loadOrders()
        }
    }
    LaunchedEffect(LocationService.hasFix) { if (LocationService.hasFix) recentre() }
    OnLocation { heading.moved(it) }
    LaunchedEffect(Unit) { snapshotFlow { controller.bearing }.collect { heading.mapTurned(it.toDouble()) } }
    // A new drive shows its directions right away, on this map.
    LaunchedEffect(app.driving.drive?.id) {
        if (app.driving.drive?.id != null) {
            drive = app.driving.drive
            following = true
            app.driveOpen = true
        }
    }
    LaunchedEffect(app.driving.drive) {
        val fresh = app.driving.drive
        if (fresh != null && fresh.id == drive?.id) drive = fresh
    }
    LaunchedEffect(navigating) { if (!navigating) recentre() }
    LaunchedEffect(app.driveMode) { if (app.driveMode) error = null }
    // Another vehicle chosen: what was under review was about the one before.
    var reviewedCar by remember { mutableStateOf(app.driver?.activeCarId) }
    LaunchedEffect(app.driver?.activeCarId) {
        val now = app.driver?.activeCarId
        if (now != null && reviewedCar != null && now != reviewedCar) app.underReview = null
        reviewedCar = now
    }
    LaunchedEffect(orders) {
        val open = openOrder
        if (open != null) orders.firstOrNull { it.id == open.id }?.let { openOrder = it }
    }
    LaunchedEffect(Unit) {
        val live = app.driving.drive
        if (live != null && drive == null) {
            drive = live
            app.driveOpen = true
        }
    }
    DisposableEffect(Unit) { onDispose { nav.shutdown() } }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val wide = Room.wide(maxWidth)
        // Everything that floats over the map stays together at the side, where the panel is.
        val column = if (wide) Modifier.widthIn(max = Room.PANEL + Room.EDGE * 2).align(Alignment.TopEnd) else Modifier.fillMaxWidth()
        val statusTop = with(density) { WindowInsets.statusBars.getTop(density).toDp() }
        val current = drive

        val lines = buildList {
            if (navigating && current != null) {
                val line = if (nav.line.isEmpty()) current.route else nav.line
                addAll(routeLines(line, thick = true))
            }
        }
        val annotations = buildList<MapAnnotation> {
            if (navigating && current != null) {
                // Picked up: only the way to the drop-off is left.
                if (current.status != "riding") add(pickupAnnotation(current.pickup.coordinate))
                add(dropoffAnnotation(current.dropoff.coordinate))
            } else {
                addAll(driverMapPins(orders, booked, openOrder = { openOrder = it }, openRide = { openBooked(it) }))
            }
        }
        val headingUp = navigating && following && current?.navigationTarget != null
        LaunchedEffect(headingUp) { heading.pinned = headingUp }

        DzMap(
            modifier = Modifier.fillMaxSize(),
            controller = controller,
            lines = lines,
            annotations = annotations,
            gestures = !(navigating && following),
            bottomCover = if (wide) 0.dp else if (navigating) 230.dp else panelCover(panel.rest, peek, maxHeight),
            topCover = statusTop + 8.dp,
            // Standing still it stays put, whatever GPS does.
            user = {
                Box(contentAlignment = Alignment.Center) {
                    if (app.driveMode && !navigating) Radar(size = 150.dp)
                    OwnVehicle(app.driver?.activeCar?.kind, heading)
                }
            },
            userParked = { heading.parked },
        )
        if (navigating && current != null) {
            Box(if (wide) Modifier.fillMaxHeight().width(Room.PANEL + Room.EDGE * 2).align(Alignment.TopEnd) else Modifier.fillMaxSize()) {
                DriveOverlay(current, nav, controller, following, { following = it }, heading) {
                    app.driveOpen = false
                    drive = app.driving.drive
                }
            }
        } else {
            BottomPanel(state = panel, peek = peek) {
                DrivingPanel(home, orders, panel, onOrder = { openOrder = it })
            }
            if (panel.detent != PanelDetent.Full) {
                Box(column.statusBarsPadding()) {
                    DrivingTopBar(controller, starting, error, onSlide = { scope.launch { toggle() } }, onLocate = { recentre() }, onDrive = {
                        drive = it
                        following = true
                        app.driveOpen = true
                    })
                }
            }
        }
    }

    openOrder?.let { order -> DzSheet(onDismiss = { openOrder = null }) { OrderSheet(order) { openOrder = null } } }
    if (showRules) {
        DzSheet(onDismiss = { showRules = false }) {
            DriverRulesScreen(close = { showRules = false }) { scope.launch { goOnline() } }
        }
    }
}

@Composable
private fun DrivingTopBar(controller: MapController, starting: Boolean, error: String?, onSlide: () -> Unit, onLocate: () -> Unit, onDrive: (Ride) -> Unit) {
    val app = AppState
    Column(Modifier.padding(start = 12.dp, end = 12.dp, top = 6.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) {
                SlideControl(
                    title = if (starting) "Going online…" else if (app.driveMode) "Go offline" else "Go online",
                    fill = if (app.driveMode) Theme.road else Theme.accent,
                    ink = if (app.driveMode) Color.White else Theme.onAccent,
                    working = starting,
                    action = onSlide,
                )
            }
            MapRoundButton(Sym.location, "Back to my location", onLocate)
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.height(38.dp).lifted(1f, 19.dp).background(Theme.card, CircleShape).padding(horizontal = 14.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.size(9.dp).background(if (app.driveMode && !app.reconnecting) Theme.ok else Theme.faint, CircleShape))
                val since = app.driveStartedAt
                if (app.driveMode && since != null) {
                    val now = tickingNow()
                    Text("${if (app.reconnecting) "Reconnecting…" else "You’re online"} · ${Fmt.stopwatch(((now - since) / 1000).toInt())}", style = T.footnote.semibold.digits, color = Theme.ink)
                } else {
                    Text("You’re offline", style = T.footnote.semibold, color = Theme.ink)
                }
            }
            Spacer(Modifier.weight(1f))
            RangeButton()
        }
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.TopEnd) { MapCompass(controller) }
        app.driving.drive?.let { d -> CurrentDriveCard(d) { onDrive(d) } }
        val offer = app.driving.offer
        if (offer != null && app.parkedOffer == offer.id) {
            // A request swiped away: it's still theirs to answer until its time is up.
            Row(
                Modifier.fillMaxWidth().floating().clip(RoundedCornerShape(Theme.radius)).clickable { app.parkedOffer = null }.padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconTile(Sym.bell)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("New ride waiting", style = T.subheadline.bold, color = Theme.ink)
                    Text("${Fmt.eur(offer.priceCents)} · ${Fmt.km(offer.distanceM)}${if (offer.isCash) " · cash" else ""}", style = T.footnote, color = Theme.muted, maxLines = 1)
                }
                offer.offeredUntil?.let { Countdown(it) }
                Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(18.dp))
            }
        }
        if (app.driving.putOffline == true && !app.driveMode) {
            NoteBox(Sym.sleep, Theme.warn, Theme.warnSoft, "You were put offline: you didn’t answer a ride within 5 minutes. Go online again when you’re ready.", Modifier.lifted(1f, 14.dp))
        }
        // Going online found only a person's look left: what it is, how long, and what to do meanwhile.
        val review = app.underReview
        val attention = app.checksAttention
        if (!app.driveMode && review != null) {
            UnderReviewCard(review)
        } else if (!app.driveMode && app.driving.drive == null && attention != null) {
            // What the checks still need, where a driver looks before going online (Pieter, 8 November 2026). A tap opens them.
            NoteBox(Sym.alert, Theme.warn, Theme.warnSoft, "Driving in the Netherlands: $attention Tap to see it.", Modifier.lifted(1f, 14.dp).clickable { app.checksOpen = true })
        }
        if (error != null) {
            Text(error, style = T.footnote, color = Theme.danger, modifier = Modifier.fillMaxWidth().floating(14.dp).padding(12.dp))
        }
    }
}

// Going online found only a person's look left: the car's number plate (it couldn't be read from the back photo), the documents, or
// both (Pieter, 8 November 2026). Not the checks again, as there's nothing to send: what it is, usually within 24 hours, and what
// the driver can do meanwhile. The words are the server's (checksNeeded in server/src/checks.js).
@Composable
private fun UnderReviewCard(review: UnderReview) {
    val app = AppState
    Column(Modifier.fillMaxWidth().floating(18.dp).padding(14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.Top) {
            IconTile(Sym.hourglass)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(review.title, style = T.subheadline.bold, color = Theme.ink)
                Text(review.message, style = T.footnote, color = Theme.muted)
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            // Another vehicle, or the back photo again: both on My page. The documents: what a person is looking at.
            if (review.plate) {
                GhostButton("My page", onClick = {
                    app.underReview = null
                    app.driverTab = 3
                }, modifier = Modifier.weight(1f), height = 42.dp)
            } else {
                GhostButton("See your checks", onClick = {
                    app.underReview = null
                    app.checksOpen = true
                }, modifier = Modifier.weight(1f), height = 42.dp)
            }
            PrimaryButton("OK", onClick = { app.underReview = null }, modifier = Modifier.weight(1f), height = 42.dp)
        }
    }
}

@Composable
private fun CurrentDriveCard(ride: Ride, open: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().floating().clip(RoundedCornerShape(Theme.radius)).clickable(onClick = open).padding(12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconTile(Sym.turnSign, Theme.onAccent, Theme.accent)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(if (ride.navigationTarget == null || ride.status == "riding") driveTitle(ride) else "Go to rider", style = T.subheadline.bold, color = Theme.ink)
            Text(if (ride.status == "riding") ride.dropoff.label ?: "" else ride.pickup.label ?: "", style = T.footnote, color = Theme.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(18.dp))
    }
}

@Composable
private fun DrivingPanel(home: DriverHome?, orders: List<MarketOrder>, panel: PanelState, onOrder: (MarketOrder) -> Unit) {
    val app = AppState
    Column(Modifier.padding(horizontal = 14.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        // What shows with the panel down: slide up, or tap, for the rest.
        Row(
            Modifier.fillMaxWidth().clickable { panel.detent = if (panel.detent == PanelDetent.Peek) PanelDetent.Middle else PanelDetent.Peek },
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Earnings today", style = T.headline, color = Theme.ink, modifier = Modifier.weight(1f))
            Text(Fmt.eur(home?.earnedTodayCents ?: 0), style = T.title3.bold.digits.kern(-0.3f), color = Theme.ink)
            Icon(if (panel.detent == PanelDetent.Peek) Sym.chevronUp else Sym.chevronDown, null, tint = Theme.faint, modifier = Modifier.size(20.dp))
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .background(Theme.accent, RoundedCornerShape(22.dp))
                    .clip(RoundedCornerShape(22.dp))
                    .clickable {
                        app.drivesPart = 2
                        app.driverTab = 2
                    }
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    val on = Theme.onAccent
                    Text("Total earnings", style = T.footnote.medium, color = on.copy(alpha = 0.85f))
                    Text(Fmt.eur(home?.earnedTotalCents ?: 0), style = T.size(34).bold.digits.kern(-0.8f), color = on)
                    val n = home?.ridesToday ?: 0
                    Text(if (n == 1) "1 ride today" else "$n rides today", style = T.footnote, color = on.copy(alpha = 0.85f))
                }
                Icon(Sym.chevronRight, null, tint = Theme.onAccent.copy(alpha = 0.85f))
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                DrivingTile("On time", home?.onTimePercent?.let { "$it%" } ?: "–")
                DrivingTile("Completed", app.driver?.completedPercent?.let { "$it%" } ?: "–")
                DrivingTile("Accepted", home?.acceptancePercent?.let { "$it%" } ?: "–")
            }
        }
        if (app.driveMode || orders.isNotEmpty()) {
            PanelGroup("Orders nearby") {
                if (orders.isEmpty()) Text("Nothing to claim right now.", style = T.subheadline, color = Theme.muted)
                orders.sortedByDescending { it.bidCents ?: 0 }.forYouFirst.take(5).forEach { order ->
                    Box(Modifier.clickable { onOrder(order) }) { OrderRow(order) }
                }
            }
        }
        val planned = home?.planned
        if (!planned.isNullOrEmpty()) {
            PanelGroup("Planned drives") { planned.forEach { PlannedRow(it) } }
        }
        val n = home?.area?.driversOnline ?: 0
        PanelGroup("Prices around you", if (n == 0) "No other drivers online within 10 km." else "$n other drivers online within 10 km.") {
            LabeledRow("Your price", priceText(app.driver?.perKmCents, app.driver?.perMinCents))
            val a = home?.area
            if (a != null && (a.driversOnline ?: 0) > 0) {
                LabeledRow("Cheapest", priceText(a.cheapestPerKmCents, a.cheapestPerMinCents))
                LabeledRow("Middle", priceText(a.middlePerKmCents, a.middlePerMinCents))
            }
            Text("Change my price", style = T.subheadline, color = Theme.accentInk, modifier = Modifier.clickable { app.driverTab = 3 })
        }
        if (app.driveMode) {
            PanelGroup("While you’re online", "You can leave the app, or close it: you stay online until you slide back, or tap Go offline in the notification.") {
                LabeledRow("Location", if (app.reconnecting) "Reconnecting…" else "Shared")
                LabeledRow("Data", String.format(Locale.US, "%.2f MB an hour", DataMeter.megabytesPerHour))
            }
        }
    }
}

private fun priceText(km: Int?, min: Int?) = "${Fmt.rate(km)}/km · ${Fmt.rate(min)}/min"

@Composable
private fun androidx.compose.foundation.layout.RowScope.DrivingTile(title: String, value: String) {
    Column(
        Modifier.weight(1f).height(70.dp).background(Theme.soft, RoundedCornerShape(Theme.radius)).padding(horizontal = 14.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
    ) {
        Text(value, style = T.title3.bold.digits.kern(-0.3f), color = Theme.ink, maxLines = 1)
        Text(title, style = T.footnote, color = Theme.muted, maxLines = 1)
    }
}

// A titled group of rows in the Driving panel.
@Composable
private fun PanelGroup(title: String, footer: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = T.headline, color = Theme.ink)
        Column(
            Modifier.fillMaxWidth().background(Theme.soft, RoundedCornerShape(Theme.radius)).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            content = content,
        )
        if (footer != null) Text(footer, style = T.caption, color = Theme.muted)
    }
}

fun driveTitle(ride: Ride): String = when (ride.status) {
    "awaiting_payment" -> "Waiting for payment"
    "accepted" -> "Go to your rider"
    "arrived" -> "Waiting for check-in"
    "riding" -> "Drive to the drop-off"
    else -> ride.statusTitle
}

@Composable
fun OrderRow(order: MarketOrder) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(9.dp).background(if (order.isPlanned) Theme.planned else Theme.now, CircleShape))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(order.dropoffLabel ?: "Somewhere near", style = T.subheadline.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${Fmt.km(order.awayM)} away · ${Fmt.km(order.distanceM)} ride · ${Fmt.people(order.passengers)}${if (order.pets == true) " · pet" else ""}${order.vehicle?.let { " · ${Vehicle.name(it).lowercase()}" } ?: ""}",
                style = T.caption, color = Theme.muted,
            )
            order.scheduledAt?.let { Text(Fmt.dayTime(it), style = T.caption.medium, color = Theme.ink) }
            if (order.forYou == true) Box(Modifier.padding(top = 2.dp)) { StatusPill("A rider chose you") }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(Fmt.eur(order.bidCents), style = T.size(17).bold.kern(-0.2f), color = Theme.ink)
            Text(Fmt.coinSymbol(order.coin), style = T.caption, color = Theme.faint)
        }
    }
}

// Your way to the pickup, dashed, then the ride itself.
@Composable
private fun TwoPartRouteMap(
    from: LatLng?,
    pickup: LatLng,
    dropoff: LatLng?,
    known: List<LatLng> = emptyList(),
    height: androidx.compose.ui.unit.Dp,
    legend: Boolean,
) {
    val controller = rememberMapController()
    var toPickup by remember { mutableStateOf<List<LatLng>>(emptyList()) }
    var ride by remember { mutableStateOf(known) }
    LaunchedEffect(pickup, dropoff) {
        if (from != null) Router.route(from, pickup)?.let { toPickup = it.line }
        if (known.isEmpty() && dropoff != null) Router.route(pickup, dropoff)?.let { ride = it.line }
    }
    LaunchedEffect(toPickup, ride) {
        val all = toPickup + ride + listOfNotNull(from, pickup, dropoff)
        controller.fit(all, animated = false)
    }
    val ink = Theme.accentInk
    Box(Modifier.fillMaxWidth().height(height).clip(RoundedCornerShape(22.dp))) {
        DzMap(
            modifier = Modifier.fillMaxSize(),
            controller = controller,
            lines = buildList {
                if (toPickup.size > 1) add(MapLine(toPickup, ink.copy(alpha = 0.75f), 4f, listOf(0.5f, 1.8f)))
                addAll(routeLines(ride))
            },
            annotations = buildList {
                add(pickupAnnotation(pickup))
                if (dropoff != null) add(dropoffAnnotation(dropoff))
            },
            showUser = true,
        )
        if (legend) {
            Row(
                Modifier.align(Alignment.BottomStart).padding(10.dp).background(Theme.card.copy(alpha = 0.9f), CircleShape).padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                LegendItem(true, "To the pickup")
                LegendItem(false, "The ride")
            }
        }
    }
}

@Composable
private fun LegendItem(dashed: Boolean, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(width = if (dashed) 10.dp else 16.dp, height = 4.dp).background(Theme.accentInk.copy(alpha = if (dashed) 0.6f else 1f), CircleShape))
        Text(text, style = T.caption2.semibold, color = Theme.ink)
    }
}

@Composable
private fun OrderSheet(order: MarketOrder, close: () -> Unit) {
    val app = AppState
    val scope = rememberCoroutineScope()
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val dropoff = if (order.dropoffLat != null && order.dropoffLng != null) LatLng(order.dropoffLat, order.dropoffLng) else null
    Screen(
        title = "Order",
        close = close,
        bottom = {
            PrimaryButton(
                "Claim for ${Fmt.eur(order.bidCents)}",
                enabled = app.driving.drive == null,
                working = working,
                onClick = {
                    working = true
                    error = null
                    scope.launch {
                        try {
                            ApiClient.post<RideResponse>("/api/rides/${order.id}/claim")
                            app.syncNow()
                            close()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.shown
                        }
                        working = false
                    }
                },
            )
        },
        spacing = 14.dp,
    ) {
        TwoPartRouteMap(LocationService.location?.place, order.coordinate, dropoff, height = 230.dp, legend = true)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(Fmt.eur(order.bidCents), style = T.size(42).bold.kern(-1f), color = Theme.ink)
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(9.dp).background(if (order.isPlanned) Theme.planned else Theme.now, CircleShape))
                    Text(if (order.isPlanned) "Booked for a time" else "Looking for a driver now", style = T.footnote.medium, color = Theme.muted)
                }
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(Fmt.coinSymbol(order.coin), style = T.subheadline.bold, color = Theme.accentInk, modifier = Modifier.background(Theme.accentSoft, CircleShape).padding(horizontal = 10.dp, vertical = 4.dp))
                order.vehicle?.let { LabelRow(Sym.vehicle(it), Vehicle.name(it), T.caption.semibold, Theme.muted) }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OrderFact(Sym.north, Fmt.km(order.awayM), "to pickup")
            OrderFact(Sym.route, Fmt.km(order.distanceM), "ride")
            OrderFact(Sym.clock, Fmt.minutes(order.durationS), "time")
            OrderFact(if (order.pets == true) Sym.paw else Sym.people, "${order.passengers ?: 1}", if (order.pets == true) "+ pet" else if ((order.passengers ?: 1) == 1) "person" else "people")
        }
        Column(Modifier.fillMaxWidth().card(22.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            RouteStops(order.pickupLabel ?: "Near the pin", order.dropoffLabel ?: "Drop-off")
            order.scheduledAt?.let { LabelRow(Sym.calendar, "Pickup ${Fmt.dayTime(it)}", T.subheadline.semibold, Theme.accentInk) }
        }
        if (app.driving.drive != null) {
            NoteBox(Sym.alert, Theme.warn, Theme.warnSoft, "Finish the drive you’re on first: with a rider you can’t claim another drive.")
        } else if (order.canClaim == false) {
            NoteBox(Sym.alert, Theme.warn, Theme.warnSoft, "To claim this: turn on ${Fmt.coinSymbol(order.coin)} in Wallet, and on My page use a ${order.vehicle?.let { Vehicle.name(it).lowercase() } ?: "vehicle"} with enough seats${if (order.pets == true) " that allows pets" else ""}.")
        }
        if (order.forYou == true) {
            NoteBox(Sym.personCheck, Theme.accentInk, Theme.accentSoft, "This rider chose you, at your own price with your way to the pickup in it. Nobody else can claim it for now. ${if (order.coin == Coins.cash) "The rider pays you in cash." else "Once you do, the rider pays."}")
        } else {
            NoteBox(Sym.info, Theme.accentInk, Theme.accentSoft, "The rider named this price for the ride. Your way to the pickup (voorrijkosten, ${Fmt.km(order.awayM)}) isn’t paid on top: ${Fmt.eur(order.bidCents)} is all you get.")
        }
        error?.let { Text(it, style = T.footnote, color = Theme.danger) }
    }
}

@Composable
private fun PlannedRow(ride: Ride) {
    val app = AppState
    val scope = rememberCoroutineScope()
    var confirm by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            ride.scheduledAt?.let { Text(Fmt.dayTime(it), style = T.subheadline.semibold, color = Theme.ink) }
            Spacer(Modifier.weight(1f))
            Text(Fmt.eur(ride.priceCents), style = T.subheadline.bold, color = Theme.ink)
        }
        Text("${ride.pickup.label ?: "Pickup"} → ${ride.dropoff.label ?: "Drop-off"}", style = T.footnote, color = Theme.muted, maxLines = 2)
        if (ride.needsPayment) Text("Not paid yet. We tell you once it is.", style = T.caption.semibold, color = Theme.warn)
        Text("I can’t make it", style = T.footnote.semibold, color = Theme.danger, modifier = Modifier.padding(top = 2.dp).clickable { confirm = true })
    }
    if (confirm) {
        AskDialog(
            title = "Pass this drive on?",
            choices = listOf(
                Choice("Pass it on", destructive = true) {
                    scope.launch {
                        attempt { ApiClient.call("POST", "/api/rides/${ride.id}/release") }
                        app.syncNow()
                    }
                },
            ),
            cancelText = "Keep it",
            onDismiss = { confirm = false },
        )
    }
}

// A new ride, to decide whether it's worth it: the route, how far in all, what it pays. Swiped down, the sheet goes away and the
// request stays in Current on Drives, where its time runs on.
@Composable
fun OfferScreen(ride: Ride) {
    // The map takes the room that's left, so the buttons sit at the bottom on any phone.
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val mapHeight = max(200f, maxHeight.value - 400).dp
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(18.dp)) {
            OfferCard(ride, mapHeight)
        }
    }
}

@Composable
fun OfferCard(ride: Ride, mapHeight: androidx.compose.ui.unit.Dp = 220.dp) {
    val app = AppState
    val scope = rememberCoroutineScope()
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun answer(what: String) {
        working = true
        scope.launch {
            try {
                ApiClient.call("POST", "/api/rides/${ride.id}/$what")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.shown
            }
            app.syncNow()
            working = false
        }
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("New ride", style = T.subheadline.semibold, color = Theme.muted)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(Fmt.eur(ride.priceCents), style = T.size(42).bold.kern(-1f), color = Theme.ink)
                    if (ride.isCash) Text("Cash", style = T.subheadline.bold, color = Theme.accentInk, modifier = Modifier.background(Theme.accentSoft, CircleShape).padding(horizontal = 10.dp, vertical = 4.dp))
                }
            }
            ride.offeredUntil?.let { CountdownRing(it) }
        }
        TwoPartRouteMap(LocationService.location?.place, ride.pickup.coordinate, ride.dropoff.coordinate, ride.route, mapHeight, legend = false)
        RouteStops(ride.pickup.label ?: "Pickup", ride.dropoff.label ?: "Drop-off")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OrderFact(Sym.north, Fmt.km(ride.pickupM), "to pickup")
            OrderFact(Sym.route, Fmt.km(ride.distanceM), "ride")
            OrderFact(Sym.sum, Fmt.km((ride.pickupM ?: 0) + (ride.distanceM ?: 0)), "in total")
            OrderFact(Sym.clock, Fmt.minutes(ride.durationS), "ride time")
        }
        Text("${Fmt.people(ride.passengers)}${if (ride.pets == true) " · pet" else ""}. Not answering in time puts you offline.", style = T.footnote, color = Theme.muted)
        ErrorText(error)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            GhostButton("Decline", modifier = Modifier.weight(1f), enabled = !working, onClick = { answer("decline") })
            PrimaryButton("Accept", modifier = Modifier.weight(1f), enabled = !working, onClick = { answer("accept") })
        }
    }
}

// The drive, over the Driving tab's map: directions to the pickup, wait for check-in, to the drop-off, check out.
@Composable
private fun DriveOverlay(
    ride: Ride,
    nav: DriveNavigator,
    controller: MapController,
    following: Boolean,
    setFollowing: (Boolean) -> Unit,
    heading: DriveHeading,
    onClose: () -> Unit,
) {
    val app = AppState
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val view = LocalView.current
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var cancelling by remember { mutableStateOf(false) }
    var done by remember { mutableStateOf<Ride?>(null) }
    // From this phone, to tens of metres: check-out only opens at the drop-off (Pieter, 8 November 2026: not straight after check-in).
    // Kept to tens of metres, so this panel isn't drawn again for every fix. As DriveOverlay in Driving.swift.
    var toDropoffM by remember { mutableStateOf<Int?>(null) }
    fun measureDropoff(here: Location) {
        if (ride.status != "riding") return
        val metres = FloatArray(1)
        Location.distanceBetween(here.latitude, here.longitude, ride.dropoff.lat, ride.dropoff.lng, metres)
        val tens = (metres[0] / 10).toInt() * 10
        if (tens != toDropoffM) toDropoffM = tens
    }
    LaunchedEffect(ride.status) { LocationService.location?.let { measureDropoff(it) } }
    val reasons = listOf("Alcohol abuse", "Misbehaviour", "Rider not there", "Car trouble", "Other")
    val destination = if (done == null) ride.navigationTarget else null

    // Where the map last went to. Not state: it changes with every real move.
    val followed = remember { arrayOfNulls<Location>(1) }
    fun follow(here: Location, force: Boolean = false, on: Boolean = following) {
        if (!on) return
        if (destination == null) {
            val all = (if (nav.line.isEmpty()) ride.route else nav.line) + listOf(ride.pickup.coordinate, ride.dropoff.coordinate)
            controller.fit(all)
            return
        }
        val v = max(0.0, here.speedOrNull ?: 0.0)
        // Standing still the map stays where it is, or it would sway with every wobble of the GPS.
        val last = followed[0]
        if (!force && last != null && DriveHeading.wobble(here, last)) return
        followed[0] = here
        // Under walking pace a phone's own course is mostly noise.
        val way = here.course?.takeIf { v > DriveHeading.REAL_SPEED } ?: heading.course
        // Further out the faster you go.
        val zoom = max(15.2, 16.8 - v * 0.05)
        controller.follow(here.place, zoom, way, 50.0)
    }

    // A navigation screen stays on, and follows the road as closely as the phone can.
    DisposableEffect(Unit) {
        view.keepScreenOn = true
        LocationService.setNavigating(true)
        onDispose {
            view.keepScreenOn = false
            LocationService.setNavigating(false)
            nav.stop()
        }
    }
    LaunchedEffect(destination?.lat, destination?.lng) {
        if (destination != null) nav.go(destination.coordinate, LocationService.location) else nav.stop()
        LocationService.location?.let { follow(it, force = true) }
    }
    OnLocation { here ->
        nav.update(here)
        follow(here)
        measureDropoff(here)
    }
    // Over without a check-out: the rider or Drivezzz cancelled it.
    LaunchedEffect(app.driving.drive) {
        if (app.driving.drive == null && done == null) {
            val over = attempt { ApiClient.get<RideResponse>("/api/rides/${ride.id}") }?.ride
            if (over?.status == "cancelled") onClose()
        }
    }

    Box(Modifier.fillMaxSize()) {
        if (destination != null) {
            Column(Modifier.statusBarsPadding().padding(horizontal = 10.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                NavigationBanner(nav)
                if (nav.failed) {
                    Text("Directions aren’t available right now. Use Other maps below.", style = T.footnote, color = Theme.danger, modifier = Modifier.fillMaxWidth().floating(14.dp).padding(12.dp))
                }
                Column(Modifier.align(Alignment.End), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    MapRoundButton(if (nav.muted) Sym.volumeOff else Sym.volumeOn, if (nav.muted) "Turn the voice on" else "Turn the voice off") { nav.toggleMuted() }
                    MapRoundButton(if (following) Sym.map else Sym.north, if (following) "See the whole route" else "Follow my position") {
                        val now = !following
                        setFollowing(now)
                        if (now) {
                            LocationService.location?.let { follow(it, force = true, on = true) }
                        } else {
                            controller.fit((if (nav.line.isEmpty()) ride.route else nav.line) + listOf(ride.pickup.coordinate, ride.dropoff.coordinate))
                        }
                    }
                }
            }
        }
        Column(
            Modifier.align(Alignment.BottomCenter).padding(10.dp).fillMaxWidth().floating(28.dp).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val left = nav.secondsLeft
            val metres = nav.metresLeft
            if (destination != null && left != null && metres != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(Fmt.minutes(left.toInt()), style = T.size(28).bold.digits.kern(-0.5f), color = Theme.ink)
                    Text("${DriveNavigator.spoken(metres)} · there at ${Fmt.time(System.currentTimeMillis() + left * 1000)}", style = T.subheadline.digits, color = Theme.muted)
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(if (done == null) driveTitle(ride) else "Drive finished", style = T.title3.bold.kern(-0.3f), color = Theme.ink, modifier = Modifier.weight(1f))
                val by = ride.payBy
                if (done == null && ride.status == "awaiting_payment" && by != null) {
                    Countdown(by)
                } else {
                    Text(Fmt.eur(ride.priceCents), style = T.title3.bold.digits.kern(-0.3f), color = Theme.ink)
                }
            }
            val finished = done
            Text(
                when {
                    finished != null -> "${Fmt.km(finished.distanceM)} · ${finished.dropoff.label ?: ""}"
                    ride.status == "riding" -> "${ride.dropoff.label ?: "Drop-off"} · ${Fmt.km(toDropoffM ?: ride.driverToDropoffM)} away"
                    ride.status == "arrived" -> "The rider checks in once they’re inside the car."
                    ride.status == "awaiting_payment" -> "You can start driving to the pickup: ${ride.pickup.label ?: "see the map"}"
                    else -> ride.pickup.label ?: "Pickup"
                },
                style = T.subheadline, color = Theme.muted, maxLines = 2, overflow = TextOverflow.Ellipsis,
            )
            if (finished == null) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("${ride.rider?.name ?: "Rider"} · ${Fmt.people(ride.passengers)}${if (ride.pets == true) " · pet" else ""}${if (ride.isCash) " · pays in cash" else ""}", style = T.footnote, color = Theme.muted, modifier = Modifier.weight(1f))
                    ride.rider?.let { PersonMenu(it.id, it.name ?: "your rider", rideId = ride.id, canReportDropoff = true) }
                }
                ErrorText(error)
                DriveActions(ride, working, toDropoffM, onCheckOut = {
                    val here = LocationService.location
                    if (here == null) {
                        error = "We need your location to check out."
                    } else {
                        working = true
                        error = null
                        scope.launch {
                            try {
                                val r: RideResponse = ApiClient.post("/api/rides/${ride.id}/check-out", mapOf("lat" to here.latitude, "lng" to here.longitude))
                                done = r.ride
                                app.syncNow()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = e.shown
                            }
                            working = false
                        }
                    }
                }, onCancel = { cancelling = true }, context = context)
            } else {
                if (ride.isCash) {
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Sym.banknote, null, tint = Theme.ok, modifier = Modifier.size(18.dp))
                        Text("Paid in cash", style = T.subheadline.semibold, color = Theme.ok)
                    }
                } else {
                    Text("You’re paid to your wallet in 24 hours, if no one appeals.", style = T.footnote, color = Theme.muted)
                }
                if (finished.checkoutWarning == true) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(Sym.info, null, tint = Theme.muted, modifier = Modifier.size(16.dp))
                        Text("Heads-up: the rider’s phone wasn’t within 500 m of the drop-off when you checked out. If you dropped them off correctly, you can ignore this. They have 24 hours to appeal.", style = T.caption, color = Theme.muted)
                    }
                }
                PrimaryButton("Done", onClick = onClose)
            }
        }
    }
    if (cancelling) {
        val noShowOpen = ride.status == "arrived" && ride.noShowFrom != null && ServerClock.date(ride.noShowFrom) <= System.currentTimeMillis()
        AskDialog(
            title = "Why are you cancelling?",
            message = when {
                ride.isCash -> "This ride is paid in cash, so no money moves."
                ride.status == "awaiting_payment" -> "The rider hasn’t paid yet, so no money moves."
                ride.status == "riding" -> "The rider gets everything back, also now they’re checked in, and you aren’t paid."
                noShowOpen -> "“Rider not there” claims 50% of the price, as you waited 10 minutes. For any other reason the rider gets everything back."
                else -> "The rider gets everything back and you aren’t paid."
            },
            choices = reasons.filter { ride.status != "riding" || it != "Rider not there" }.map { reason ->
                Choice(reason, destructive = true) {
                    scope.launch {
                        working = true
                        try {
                            ApiClient.post<RideResponse>("/api/rides/${ride.id}/driver-cancel", mapOf("reason" to reason))
                            app.syncNow()
                            onClose()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.shown
                        }
                        working = false
                    }
                }
            },
            cancelText = "Keep the ride",
            onDismiss = { cancelling = false },
        )
    }
}

@Composable
private fun DriveActions(ride: Ride, working: Boolean, toDropoffM: Int?, onCheckOut: () -> Unit, onCancel: () -> Unit, context: Context) {
    val app = AppState
    when (ride.status) {
        "riding" -> {
            // Within 200 m of the drop-off, as the server checks it: grey until then.
            val radius = ride.checkOutM ?: 200
            val near = (toDropoffM ?: ride.driverToDropoffM ?: Int.MAX_VALUE) <= radius
            PrimaryButton("Check out", working = working, enabled = near, onClick = onCheckOut)
            if (!near) {
                Text("Check out at the drop-off: it opens within $radius m${toDropoffM?.let { ", you’re ${Fmt.km(it)} away" } ?: ""}.", style = T.footnote.digits, color = Theme.muted)
            }
        }
        "arrived" -> {
            val from = ride.noShowFrom
            if (from != null) {
                val now = tickingNow()
                if (ServerClock.date(from) > now) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("No check-in: you can claim 50% in", style = T.footnote, color = Theme.muted, modifier = Modifier.weight(1f))
                        Countdown(from, redBelow = 0)
                    }
                } else {
                    Text("No check-in after 10 minutes: cancel with “Rider not there” to claim 50%.", style = T.footnote.semibold, color = Theme.ok)
                }
            } else if (!ride.isCash) {
                Text("Stop at the pickup: your 10 minutes of waiting start when the car stands still.", style = T.footnote, color = Theme.muted)
            }
        }
        "awaiting_payment" -> Text("Check-out: ${ride.dropoff.label ?: "see the map"}", style = T.footnote, color = Theme.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    if (ride.driverLate == true) {
        Text("You’re late: the rider can cancel for a full refund until they check in.", style = T.footnote.semibold, color = Theme.warn)
    }
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        // Another navigation app you may prefer.
        val place = if (ride.status == "riding") ride.dropoff else ride.pickup
        Box(Modifier.weight(1f)) {
            MenuFrom({ open -> GhostButton("Other maps", height = 46.dp, onClick = open) }) {
                OtherMaps(context, place, if (ride.status == "riding") "Drop-off" else "Pickup")
            }
        }
        GhostButton("Cancel ride", height = 46.dp, color = Theme.danger, modifier = Modifier.weight(1f), onClick = onCancel)
    }
    Box(Modifier.fillMaxWidth().clickable { app.driveOpen = false }.heightIn(min = 28.dp), contentAlignment = Alignment.Center) {
        Text("Back", style = T.footnote.semibold, color = Theme.accentInk)
    }
}

@Composable
private fun MenuScope.OtherMaps(context: Context, place: Place, fallback: String) {
    val pm = context.packageManager
    val hasGoogle = pm.getLaunchIntentForPackage("com.google.android.apps.maps") != null
    val hasWaze = pm.getLaunchIntentForPackage("com.waze") != null
    if (hasGoogle) Item("Google Maps") { openUrl(context, "google.navigation:q=${place.lat},${place.lng}&mode=d", "com.google.android.apps.maps") }
    if (hasWaze) Item("Waze") { openUrl(context, "waze://?ll=${place.lat},${place.lng}&navigate=yes", "com.waze") }
    Item("Another map app") { openInMaps(context, place, place.label ?: fallback) }
}

// The Map tab: orders closest and highest first; swipe down for the map. Green is now, yellow is booked for a time.
@Composable
fun DriverMapScreen() {
    val app = AppState
    var orders by remember { mutableStateOf<List<MarketOrder>>(emptyList()) }
    var booked by remember { mutableStateOf<List<Ride>>(emptyList()) }
    val panel = rememberPanelState(PanelDetent.Middle)
    val controller = rememberMapController()
    var sort by remember { mutableIntStateOf(0) }
    var open by remember { mutableStateOf<MarketOrder?>(null) }
    var centred by remember { mutableStateOf(false) }
    val heading = remember { DriveHeading() }

    val sorted = (if (sort == 0) orders.sortedBy { it.awayM ?: 0 } else orders.sortedByDescending { it.bidCents ?: 0 }).forYouFirst

    suspend fun load() {
        val here = LocationService.location ?: return
        attempt { ApiClient.get<MarketResponse>("/api/driver/market?lat=${here.latitude}&lng=${here.longitude}&radiusKm=${app.driverRadiusKm.toInt()}") }?.let {
            orders = it.orders ?: emptyList()
            if (it.booked != null || booked.isNotEmpty()) booked = it.booked ?: emptyList()
        }
    }

    // The drive on now opens on Driving, with its directions; another ride opens its page.
    fun openBooked(ride: Ride) {
        if (app.driving.drive?.id == ride.id) {
            app.driveOpen = true
            app.driverTab = 0
        } else {
            app.mapRide = ride
        }
    }

    LaunchedEffect(LocationService.hasFix) {
        // After the map's own first layout, which would otherwise win.
        delay(400)
        val here = LocationService.location?.place
        if (!centred && here != null) {
            centred = true
            // All of the area orders come from.
            controller.centre(here, app.driverRadiusKm * 2000, animated = false)
        }
    }
    LaunchedEffect(app.rev, app.driverRadiusKm) { load() }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            if (app.isActive) load()
        }
    }
    OnLocation { heading.moved(it) }
    LaunchedEffect(Unit) { snapshotFlow { controller.bearing }.collect { heading.mapTurned(it.toDouble()) } }
    LaunchedEffect(orders) {
        val o = open
        if (o != null) orders.firstOrNull { it.id == o.id }?.let { open = it }
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        DzMap(
            modifier = Modifier.fillMaxSize(),
            controller = controller,
            annotations = driverMapPins(orders, booked, openOrder = { open = it }, openRide = { openBooked(it) }),
            user = { OwnVehicle(app.driver?.activeCar?.kind, heading) },
            userParked = { heading.parked },
            bottomCover = if (Room.wide(maxWidth)) 0.dp else panelCover(panel.rest, 90.dp, maxHeight),
        )
        Column(
            Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(top = 8.dp, end = 12.dp),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            RangeButton()
            MapCompass(controller)
        }
        BottomPanel(state = panel, peek = 90.dp) {
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    MapLegend(Theme.now, "Now")
                    MapLegend(Theme.planned, "For a time")
                    if (booked.isNotEmpty()) {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Sym.check, null, tint = Theme.muted, modifier = Modifier.size(14.dp))
                            Text("Yours", style = T.footnote, color = Theme.muted)
                        }
                    }
                    Spacer(Modifier.weight(1f))
                    Text(if (orders.size == 1) "1 order" else "${orders.size} orders", style = T.footnote, color = Theme.faint)
                }
                Segmented(listOf("Closest", "Highest bid"), sort) { sort = it }
                if (sorted.isEmpty()) {
                    Text("No orders within ${app.driverRadiusKm.toInt()} km right now.", style = T.subheadline, color = Theme.muted, modifier = Modifier.padding(top = 6.dp))
                }
                sorted.forEachIndexed { i, order ->
                    Box(Modifier.fillMaxWidth().clickable { open = order }.padding(vertical = 8.dp)) { OrderRow(order) }
                    if (i < sorted.lastIndex) Hairline()
                }
            }
        }
    }
    open?.let { order -> DzSheet(onDismiss = { open = null }) { OrderSheet(order) { open = null } } }
}

// The orders on a driver's map, and their own booked rides with a check, at the pickup they have (Pieter, 8 November 2026: a tap on
// a booked one's number opens that ride, as from the list). A tap goes through the map, which asks which pin was under the finger
// (DzMap's pinAt, at least 44 dp to aim at). An order the market still had a moment ago may be booked by now: it shows once, as booked.
private fun driverMapPins(orders: List<MarketOrder>, booked: List<Ride>, openOrder: (MarketOrder) -> Unit, openRide: (Ride) -> Unit): List<MapAnnotation> {
    val mine = booked.map { it.id }.toSet()
    return orders.filter { it.id !in mine }.map { order ->
        MapAnnotation("o-${order.id}", order.coordinate, onTap = { openOrder(order) }) { OrderPin(order.isPlanned, order.bidCents) }
    } + booked.map { ride ->
        MapAnnotation("b-${ride.id}", ride.pickup.coordinate, onTap = { openRide(ride) }) { OrderPin(ride.scheduledAt != null, ride.shownPriceCents, booked = true) }
    }
}

@Composable
private fun MapLegend(color: Color, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.size(9.dp).background(color, CircleShape))
        Text(text, style = T.footnote, color = Theme.muted)
    }
}

// Report or block someone, from their page or a ride with them.
@Composable
fun PersonMenu(
    userId: String,
    name: String,
    rideId: String? = null,
    canReportDropoff: Boolean = false,
    offersChat: Boolean = true,
    onRemoveChat: (() -> Unit)? = null,
    onBlocked: () -> Unit = {},
) {
    val scope = rememberCoroutineScope()
    var chatting by remember { mutableStateOf(false) }
    var reporting by remember { mutableStateOf(false) }
    var confirmBlock by remember { mutableStateOf(false) }
    MenuFrom({ open -> IconRound(Sym.more, "More", onClick = open) }) {
        if (offersChat) Item("Message $name", Sym.chatBubble) { chatting = true }
        Item("Report $name", Sym.flagOutline) { reporting = true }
        Item("Block $name", Sym.block, destructive = true) { confirmBlock = true }
        if (onRemoveChat != null) Item("Remove chat", Sym.trash, destructive = true) { onRemoveChat() }
    }
    if (reporting) {
        DzSheet(onDismiss = { reporting = false }) { ReportSheet(userId, name, rideId, canReportDropoff) { reporting = false } }
    }
    if (chatting) {
        DzSheet(onDismiss = { chatting = false }) { NavStack { ChatScreen(userId, name, close = { chatting = false }) } }
    }
    if (confirmBlock) {
        AskDialog(
            title = "Block $name?",
            message = "You won’t be matched with each other any more. A ride under way carries on. You can undo this in Profile.",
            choices = listOf(
                Choice("Block", destructive = true) {
                    scope.launch {
                        attempt { ApiClient.call("POST", "/api/blocks", mapOf("userId" to userId)) }
                        onBlocked()
                    }
                },
            ),
            onDismiss = { confirmBlock = false },
        )
    }
}

// Sending a report. Only this phone can open a chat: it hands over the keys to it, so that the report can be read.
object Reporting {
    const val IMPOSSIBLE_DROPOFF = "Impossible drop-off location"

    suspend fun send(userId: String, reason: String, message: String, rideId: String?) {
        val body = mutableMapOf<String, Any?>("userId" to userId, "reason" to reason, "message" to message)
        if (rideId != null) body["rideId"] = rideId
        val messages = attempt { ApiClient.get<ChatThread>("/api/messages/$userId") }?.messages
        if (!messages.isNullOrEmpty()) body["chatKeys"] = E2E.reportKeys(messages)
        ApiClient.call("POST", "/api/reports", body)
    }
}

@Composable
private fun ReportSheet(userId: String, name: String, rideId: String?, canReportDropoff: Boolean, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var reason by remember { mutableStateOf("Unsafe driving") }
    var message by remember { mutableStateOf("") }
    var sent by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val reasons = listOf("Unsafe driving", "Harassment or abuse", "Offensive photo or text", "Fraud or wrong car") +
        (if (canReportDropoff && rideId != null) listOf(Reporting.IMPOSSIBLE_DROPOFF) else emptyList()) + listOf("Something else")
    Screen(
        title = "Report $name",
        close = close,
        closeText = if (sent) "Done" else "Close",
        actions = {
            if (!sent) {
                TextAction("Send", {
                    scope.launch {
                        try {
                            Reporting.send(userId, reason, message, rideId)
                            sent = true
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.shown
                        }
                    }
                })
            }
        },
    ) {
        if (sent) {
            ListSection { ListRow { LabelRow(Sym.checkCircle, "Thanks. We look at reports within 24 hours.", iconTint = Theme.ok) } }
        } else {
            ListSection("What’s wrong?") {
                reasons.forEachIndexed { i, r ->
                    if (i > 0) CardDivider(16.dp)
                    ListRow(onClick = { reason = r }) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(r, style = T.subheadline, color = Theme.ink, modifier = Modifier.weight(1f))
                            if (reason == r) Icon(Sym.check, null, tint = Theme.accentInk, modifier = Modifier.size(20.dp))
                        }
                    }
                }
            }
            ListSection(
                "Anything to add?",
                if (reason == Reporting.IMPOSSIBLE_DROPOFF) "This drive is added to the report, so we can see the planned route on a map. If you’ve messaged $name, your chat is added too."
                else "Messages are end-to-end encrypted. If you’ve messaged $name, your chat is added to this report so we can read it.",
            ) {
                Box(Modifier.padding(4.dp)) { DzField(message, { message = it }, "Optional", minLines = 3, maxLines = 6) }
            }
            error?.let { Text(it, style = T.footnote, color = Theme.danger) }
        }
    }
}

@Composable
private fun androidx.compose.foundation.layout.RowScope.OrderFact(symbol: ImageVector, value: String, label: String) {
    Column(
        Modifier.weight(1f).background(Theme.ink.copy(alpha = 0.045f), RoundedCornerShape(16.dp)).padding(vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(symbol, null, tint = Theme.muted, modifier = Modifier.size(16.dp))
        Text(value, style = T.subheadline.bold.digits, color = Theme.ink, maxLines = 1)
        Text(label, style = T.caption2, color = Theme.faint, maxLines = 1)
    }
}

// How far you look for orders: 1 to 40 km. Shared by Driving and Map.
@Composable
fun RangeButton() {
    val app = AppState
    var open by remember { mutableStateOf(false) }
    Row(
        Modifier
            .height(38.dp)
            .lifted(0.8f, 19.dp)
            .background(Theme.card, CircleShape)
            .clip(CircleShape)
            .clickable { open = true }
            .padding(horizontal = 14.dp)
            .semantics { contentDescription = "Orders within ${app.driverRadiusKm.toInt()} kilometres" },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Sym.filter, null, tint = Theme.accentInk, modifier = Modifier.size(16.dp))
        Text("${app.driverRadiusKm.toInt()} km", style = T.footnote.semibold, color = Theme.ink)
    }
    if (open) {
        DzSheet(onDismiss = { open = false }, tall = false) {
            Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Orders within", style = T.headline, color = Theme.ink)
                Text("${app.driverRadiusKm.toInt()} km", style = T.size(44).bold.digits.kern(-1f), color = Theme.ink)
                DzSlider(app.driverRadiusKm.toFloat(), 1f..40f) { app.driverRadiusKm = it.toInt().toDouble() }
                Row {
                    Text("1 km", style = T.caption, color = Theme.faint)
                    Spacer(Modifier.weight(1f))
                    Text("40 km", style = T.caption, color = Theme.faint)
                }
                Text("Further away means a longer way to the pickup, which isn’t paid on a rider’s named price.", style = T.footnote, color = Theme.muted)
            }
        }
    }
}
