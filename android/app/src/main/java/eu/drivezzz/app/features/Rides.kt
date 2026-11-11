package eu.drivezzz.app.features

import android.annotation.SuppressLint
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import eu.drivezzz.app.core.SavedRoute
import eu.drivezzz.app.core.SavedRoutes
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import eu.drivezzz.app.core.ChainQueue
import eu.drivezzz.app.ui.NoteBox
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.BuildConfig
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.LocationService
import eu.drivezzz.app.core.Ride
import eu.drivezzz.app.core.RideDriver
import eu.drivezzz.app.core.RideEscrow
import eu.drivezzz.app.core.RidePayout
import eu.drivezzz.app.core.RideResponse
import eu.drivezzz.app.core.RidesResponse
import eu.drivezzz.app.core.ServerClock
import eu.drivezzz.app.core.Vehicle
import eu.drivezzz.app.core.Wallets
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.map.DzMap
import eu.drivezzz.app.map.MapAnchor
import eu.drivezzz.app.map.MapAnnotation
import eu.drivezzz.app.map.rememberMapController
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RidesScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    var rides by remember { mutableStateOf<List<Ride>>(emptyList()) }
    var tab by remember { mutableIntStateOf(0) }
    var loaded by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var renaming by remember { mutableStateOf<SavedRoute?>(null) }

    suspend fun load() {
        attempt { ApiClient.get<RidesResponse>("/api/rides") }?.let { rides = it.rides ?: emptyList() }
        loaded = true
    }
    LaunchedEffect(app.rev) { load() }

    val list = when (tab) {
        0 -> rides.filter { (it.isLive || it.isWaiting) && !(it.status == "open" && it.scheduledAt != null) }
        1 -> rides.filter { it.status == "scheduled" || (it.status == "open" && it.scheduledAt != null) }
        else -> rides.filter { it.isOver }
    }

    NavStack {
        val nav = LocalNav.current
        Screen("Rides", large = true, scroll = false, padding = androidx.compose.foundation.layout.PaddingValues(0.dp)) {
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    scope.launch {
                        load()
                        refreshing = false
                    }
                },
                modifier = Modifier.fillMaxSize(),
            ) {
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Segmented(listOf("Current", "Booked", "Completed"), tab) { tab = it }
                    if (tab == 1) SavedRoutesSection(onRename = { renaming = it })
                    if (list.isEmpty() && loaded) {
                        Column(Modifier.fillMaxWidth().padding(vertical = 40.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Icon(if (tab == 0) Sym.car else if (tab == 1) Sym.calendar else Sym.seal, null, tint = Theme.faint, modifier = Modifier.size(40.dp))
                            Text(if (tab == 0) "No ride right now" else if (tab == 1) "Nothing booked" else "No rides yet", style = T.title3.bold, color = Theme.ink)
                            Text(
                                if (tab == 0) "Where you’re going starts on Home." else if (tab == 1) "Plan a ride on Home, up to a week ahead." else "Your finished rides show here.",
                                style = T.subheadline, color = Theme.muted, textAlign = TextAlign.Center,
                            )
                        }
                    }
                    if (list.isNotEmpty()) {
                        ListSection {
                            list.forEachIndexed { i, ride ->
                                if (i > 0) CardDivider(16.dp)
                                ListRow(onClick = { nav?.push { RideDetailScreen(ride) } }) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Box(Modifier.weight(1f)) { RideRow(ride) }
                                        Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.padding(start = 6.dp).size(18.dp))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    renaming?.let { route ->
        RouteNameDialog("Rename this route", null, initial = route.name, onDismiss = { renaming = null }) { name ->
            SavedRoutes.rename(route, name)
            renaming = null
        }
    }
}

// A tap fills in Home, with the price of right now.
@Composable
private fun SavedRoutesSection(onRename: (SavedRoute) -> Unit) {
    val app = AppState
    val routes = SavedRoutes.routes
    val footer = "Tap the bookmark on a route on Home to keep it here, with a name. A ride’s page can save its route too."
    if (routes.isEmpty()) {
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text("Saved routes", style = T.footnote.semibold, color = Theme.muted, modifier = Modifier.padding(horizontal = 16.dp))
            Text(footer, style = T.footnote, color = Theme.faint, modifier = Modifier.padding(horizontal = 16.dp))
        }
        return
    }
    ListSection("Saved routes") {
        routes.forEachIndexed { i, route ->
            if (i > 0) CardDivider(68.dp)
            ListRow(onClick = {
                app.routeToUse = route
                app.riderTab = 0
            }) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Box(Modifier.size(40.dp).background(Theme.accentSoft, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                        Icon(Sym.bookmarkFill, null, tint = Theme.accentInk, modifier = Modifier.size(18.dp))
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(route.name, style = T.callout.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${route.pickup.label ?: "Pickup"} to ${route.dropoff.label ?: "drop-off"}", style = T.footnote, color = Theme.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                    MenuFrom({ open ->
                        Box(Modifier.size(36.dp).clip(CircleShape).clickable(onClick = open).semantics { contentDescription = "More for ${route.name}" }, contentAlignment = Alignment.Center) {
                            Icon(Sym.more, null, tint = Theme.faint, modifier = Modifier.size(20.dp))
                        }
                    }) {
                        Item("Rename", Sym.pencil) { onRename(route) }
                        Item("Delete", Sym.trash, destructive = true) { SavedRoutes.remove(route) }
                    }
                }
            }
        }
    }
}

// Asks a name for a route, to keep it in Rides. With the cursor at the end, ready to go on typing.
@Composable
fun RouteNameDialog(title: String, message: String?, initial: String = "", confirm: String = "Save", onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var field by remember { mutableStateOf(TextFieldValue(initial, TextRange(initial.length))) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    DzAlert(title, message, confirm = confirm, onDismiss = onDismiss, onConfirm = { onSave(field.text) }) {
        Box(Modifier.fillMaxWidth().background(Theme.soft, RoundedCornerShape(Theme.buttonRadius)).padding(14.dp)) {
            if (field.text.isEmpty()) Text("Like Home to work", style = T.callout, color = Theme.faint)
            BasicTextField(
                value = field,
                onValueChange = { field = it.copy(text = it.text.take(40)) },
                singleLine = true,
                textStyle = T.callout.copy(color = Theme.ink),
                cursorBrush = SolidColor(Theme.accentInk),
                modifier = Modifier.fillMaxWidth().focusRequester(focus).semantics { contentDescription = "Name" },
            )
        }
    }
}

@Composable
fun RideRow(ride: Ride) {
    val whenAt = ride.scheduledAt ?: ride.checkedOutAt ?: ride.createdAt
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CarTile(ride.driver?.car, 46.dp)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(ride.dropoff.label ?: "Drop-off", style = T.callout.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Spacer(Modifier.width(8.dp))
                Text(Fmt.eur(ride.shownPriceCents), style = T.callout.bold.kern(-0.2f), color = Theme.ink)
            }
            Text("From ${ride.pickup.label ?: "pickup"}", style = T.footnote, color = Theme.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                RideStatusPill(ride.statusTitle, ride)
                if (whenAt != null) Text("${Fmt.dayTime(whenAt)}${if (ride.isCash && ride.status == "completed") " · Paid in cash" else ""}", style = T.caption, color = Theme.faint, maxLines = 1)
            }
        }
    }
}

// A ride's page, for the rider and for the driver afterwards.
@SuppressLint("ClickableViewAccessibility")
@Composable
fun RideDetailScreen(initial: Ride, close: (() -> Unit)? = null) {
    val app = AppState
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val nav = LocalNav.current
    var ride by remember(initial.id) { mutableStateOf(initial) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showCheckIn by remember { mutableStateOf(false) }
    var showReview by remember { mutableStateOf(false) }
    var showAppeal by remember { mutableStateOf(false) }
    var adding by remember { mutableStateOf<Int?>(null) } // what the rider is asked to confirm adding to the order
    var showDriver by remember { mutableStateOf(false) }
    var namingRoute by remember { mutableStateOf(false) }
    val isRider = ride.role != "driver"

    suspend fun refresh() {
        attempt { ApiClient.get<RideResponse>("/api/rides/${ride.id}") }?.let { ride = it.ride }
    }

    val other: Pair<String, String>? = when {
        isRider && ride.driver != null -> ride.driver!!.id to (ride.driver!!.name ?: "your driver")
        !isRider && ride.rider != null -> ride.rider!!.id to (ride.rider!!.name ?: "your rider")
        else -> null
    }

    // A ride shown as a sheet follows what the app hears; a page in a list has its own copy.
    LaunchedEffect(app.rev) { refresh() }
    // A payment shows up on the chain without the app having to be told.
    LaunchedEffect(ride.status) {
        if (ride.status != "awaiting_payment") return@LaunchedEffect
        while (true) {
            delay(8000)
            refresh()
        }
    }
    DisposableEffect(ride.id) {
        app.rideOnScreen = ride.id
        onDispose { if (app.rideOnScreen == ride.id) app.rideOnScreen = null }
    }
    // Opens by itself when the driver is close. Dismissed, it stays closed; the button brings it back.
    LaunchedEffect(ride.canCheckIn) {
        if (isRider && ride.canCheckIn == true && app.dismissedCheckIn != ride.id && !showCheckIn) showCheckIn = true
    }
    // The ride that just ended asks for a review, once. Dismissed, it stays available on this page.
    LaunchedEffect(app.reviewPrompt) {
        if (isRider && app.reviewPrompt == ride.id) {
            // Not in this effect itself: clearing the prompt ends it.
            scope.launch {
                refresh()
                if (ride.review == null) showReview = true
            }
            app.reviewPrompt = null
        }
    }

    Screen(
        title = if (isRider) "Your ride" else "Your drive",
        close = if (app.showingRide != null || app.mapRide != null) close else null,
        actions = {
            if (other != null) PersonMenu(other.first, other.second, rideId = ride.id, canReportDropoff = !isRider)
        },
        bottom = if (isRider && (ride.status == "accepted" || ride.status == "arrived")) ({
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                PrimaryButton("Check in", enabled = ride.canCheckIn == true, onClick = { showCheckIn = true })
                if (ride.canCheckIn != true) Text("You can check in within 100 m of your driver.", style = T.footnote, color = Theme.faint)
            }
        }) else null,
    ) {
        if (!ride.isOver) RideMap(ride, isRider)
        RideHeader(ride, isRider)
        if (isRider && rideStateCardShows(ride)) {
            Box(Modifier.fillMaxWidth().background(Theme.card, RoundedCornerShape(14.dp)).padding(16.dp)) {
                RideStateCard(ride) { fresh -> ride = fresh }
            }
        }
        if (ride.needsPayment && isRider) {
            Box(Modifier.fillMaxWidth().background(Theme.card, RoundedCornerShape(14.dp)).padding(16.dp)) { PayRideCard(ride) }
        }
        if (ride.status == "open" && isRider) {
            ListSection("Nobody took it yet? Offer more") {
                Row(Modifier.padding(12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOf(100, 200, 500).forEach { extra ->
                        GhostButton("+${Fmt.eur(extra)}", height = 40.dp, modifier = Modifier.weight(1f), enabled = !working, onClick = { adding = extra })
                    }
                }
            }
        }
        val driver = ride.driver
        if (driver != null && isRider) DriverSection(ride, driver, onOpen = { showDriver = true })
        if (other != null && !isRider) {
            ListSection {
                ListRow(onClick = { nav?.push { ChatScreen(other.first, other.second) } }) {
                    LabelRow(Sym.chatBubble, "Message ${other.second}", iconTint = Theme.accentInk)
                }
            }
        }
        RouteSection(ride, isRider)
        if (isRider && !SavedRoutes.has(ride.pickup, ride.dropoff)) {
            ListSection {
                ListRow(onClick = { namingRoute = true }) { LabelRow(Sym.bookmark, "Save this route", color = Theme.accentInk) }
            }
        }
        error?.let { Text(it, style = T.footnote, color = Theme.danger) }
        AfterRide(ride, isRider, onReview = { showReview = true }, onAppeal = { showAppeal = true })
        if (isRider && rideCancelShows(ride)) {
            RideCancelButton(ride) { fresh -> ride = fresh }
        }
    }

    EscrowMomentOver(if (isRider) ride.status else null, Fmt.eur(ride.shownPriceCents), ride.coin)

    if (showCheckIn) {
        val dismiss = {
            showCheckIn = false
            app.dismissedCheckIn = ride.id
        }
        DzSheet(onDismiss = dismiss, background = Theme.card) { CheckInScreen(ride, onDone = { ride = it }, close = dismiss) }
    }
    if (showReview) DzSheet(onDismiss = { showReview = false }, tall = false) { ReviewSheet(ride, { ride = it }) { showReview = false } }
    if (showAppeal) DzSheet(onDismiss = { showAppeal = false }, tall = false) { AppealSheet(ride, { ride = it }) { showAppeal = false } }
    adding?.let { extra ->
        AskDialog(
            title = "Add ${Fmt.eur(extra)} to your order?",
            message = "Your order will be ${Fmt.eur((ride.maxCents ?: 0) + extra)}.",
            choices = listOf(
                Choice("Add ${Fmt.eur(extra)}") {
                    scope.launch {
                        working = true
                        error = null
                        try {
                            val r: RideResponse = ApiClient.post("/api/rides/${ride.id}/bid", mapOf("bidCents" to (ride.maxCents ?: 0) + extra))
                            ride = r.ride
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.shown
                        }
                        working = false
                    }
                },
            ),
            cancelText = "Not now",
            onDismiss = { adding = null },
        )
    }
    if (showDriver) {
        val id = ride.driver?.id
        if (id != null) DzSheet(onDismiss = { showDriver = false }) { NavStack { DriverProfileScreen(id, close = { showDriver = false }) } }
    }
    if (namingRoute) {
        RouteNameDialog(
            title = "Save this route",
            message = "It keeps the pickup and the drop-off. Find it in Rides, under Booked. It stays on this phone.",
            onDismiss = { namingRoute = false },
        ) { name ->
            SavedRoutes.add(name, ride.pickup, ride.dropoff)
            namingRoute = false
        }
    }
}

@Composable
private fun RideMap(ride: Ride, isRider: Boolean) {
    val controller = rememberMapController()
    // Your driver's car: still for GPS wobble, gliding to a real move.
    val steady = remember { SteadyCar() }
    val car = steady.follow(ride.driver?.coordinate, ride.id)
    val line = remember(ride.polyline) { ride.route }
    LaunchedEffect(ride.id) {
        controller.fit(line.ifEmpty { listOf(ride.pickup.coordinate, ride.dropoff.coordinate) }, animated = false)
    }
    val annotations = buildList {
        if (ride.status in listOf("searching", "offered", "open")) add(MapAnnotation("radar", ride.pickup.coordinate, MapAnchor.Center) { Radar(size = 120.dp) })
        add(pickupAnnotation(ride.pickup.coordinate))
        add(dropoffAnnotation(ride.dropoff.coordinate))
        if (isRider && car != null) add(MapAnnotation("driver", car, MapAnchor.Center, glide = true) { DriverPin(ride.driver?.car?.kind, ride.etaShort) })
    }
    DzMap(
        modifier = Modifier.fillMaxWidth().height(210.dp).clip(RoundedCornerShape(14.dp)),
        controller = controller,
        lines = routeLines(line),
        annotations = annotations,
        showUser = true,
    )
}

@Composable
private fun RideHeader(ride: Ride, isRider: Boolean) {
    Column(Modifier.fillMaxWidth().background(Theme.card, RoundedCornerShape(14.dp)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(if (isRider) ride.statusTitle else driverStatus(ride), style = T.title2.bold.kern(-0.4f), color = Theme.ink)
        val line: String? = when (ride.status) {
            "awaiting_payment" -> if (!isRider) "You can start driving to the pickup." else null
            "accepted" -> if (ride.driverLate == true) {
                (ride.apartM ?: ride.driverToPickupM)?.let { "${Fmt.km(it)} from you" } ?: "See on the map where they are."
            } else {
                ride.pickupEtaAt?.let { eta -> "Around ${Fmt.time(ServerClock.date(eta))}${(ride.driverToPickupM ?: ride.apartM)?.let { " · ${Fmt.km(it)} away" } ?: ""}" }
            }
            "arrived" -> "Check the number plate, get in, then check in."
            "scheduled" -> ride.scheduledAt?.let { "Pickup ${Fmt.dayTime(it)}" }
            "open" -> {
                val paying = if (ride.isCash) "You pay your driver in cash." else if (ride.scheduledAt == null) "You pay once one claims it." else "You pay once a driver claims it."
                ride.scheduledAt?.let { "Pickup ${Fmt.dayTime(it)}. $paying" } ?: "Drivers nearby can see your order. $paying"
            }
            "cancelled" -> cancelLine(ride, isRider)
            "completed" -> ride.checkedOutAt?.let { Fmt.dayTime(it) }
            else -> null
        }
        if (line != null) Text(line, style = T.subheadline, color = Theme.muted)
        if (ride.isCash && ride.status == "completed") Text("Paid in cash", style = T.subheadline.semibold, color = Theme.ok)
        if (!ride.isOver) Box(Modifier.padding(top = 8.dp)) { RideSteps(ride) }
    }
}

private fun cancelLine(ride: Ride, isRider: Boolean): String {
    var s = if (ride.cancelledBy == "driver") "Your driver cancelled." else if (ride.cancelledBy == "rider") "You cancelled." else "Cancelled by Drivezzz."
    if (!isRider) s = if (ride.cancelledBy == "driver") "You cancelled." else "Cancelled."
    ride.cancelReason?.let { s += " $it." }
    if (isRider && ride.escrow != null) s += if (ride.escrow.outcome == "split") " Half goes back to your wallet." else " Everything goes back to your wallet."
    return s
}

@Composable
private fun DriverSection(ride: Ride, d: RideDriver, onOpen: () -> Unit) {
    val nav = LocalNav.current
    ListSection("Your driver") {
        Row(
            Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 16.dp, vertical = 11.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CarTile(d.car)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(d.name ?: "Your driver", style = T.subheadline.semibold, color = Theme.ink)
                RatingLabel(d.rating, d.ratingCount)
            }
            Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(18.dp))
        }
        d.car?.let { car ->
            CardDivider(16.dp)
            ListRow {
                LabeledRow("${car.colorName ?: ""} ${car.title}".trim(), trailing = { PlateView(car.shownPlate, 15.dp) })
            }
        }
        CardDivider(16.dp)
        if (!ride.isOver) {
            Box(Modifier.padding(horizontal = 16.dp, vertical = 10.dp)) { MessageButton(d.id, d.name ?: "your driver", big = true) }
        } else {
            ListRow(onClick = { nav?.push { ChatScreen(d.id, d.name ?: "your driver") } }) {
                LabelRow(Sym.chatBubble, "Message ${d.name ?: "your driver"}", iconTint = Theme.accentInk)
            }
        }
    }
}

@Composable
private fun RouteSection(ride: Ride, isRider: Boolean) {
    val context = LocalContext.current
    ListSection {
        ListRow {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Sym.circle, null, tint = Theme.pickupPin, modifier = Modifier.padding(top = 5.dp).size(9.dp))
                Text(ride.pickup.label ?: "Pickup", style = T.subheadline.medium, color = Theme.ink)
            }
        }
        CardDivider(16.dp)
        ListRow {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(Sym.flag, null, tint = Theme.accentInk, modifier = Modifier.padding(top = 3.dp).size(12.dp))
                Text(ride.dropoff.label ?: "Drop-off", style = T.subheadline.medium, color = Theme.ink)
            }
        }
        CardDivider(16.dp)
        ListRow { LabeledRow("Distance", "${Fmt.km(ride.distanceM)} · ${Fmt.minutes(ride.durationS)}") }
        CardDivider(16.dp)
        ListRow {
            LabeledRow("Price", trailing = {
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
                    Text(Fmt.eur(ride.shownPriceCents), style = T.subheadline.semibold, color = Theme.ink)
                    // The amount in the coin is only fixed when it's paid.
                    val note = if (ride.isCash) (if (ride.status == "completed") "Paid in cash" else "in cash") else ride.coinAmount?.let { Fmt.amount(it, Fmt.coinSymbol(ride.coin)) } ?: "in ${Fmt.coinSymbol(ride.coin)}"
                    Text(note, style = T.caption, color = Theme.faint)
                }
            })
        }
        ride.escrow?.let { e ->
            CardDivider(16.dp)
            val link = e.settleExplorer ?: e.explorer
            ListRow(onClick = link?.let { url -> { openUrl(context, url) } }) {
                LabeledRow(if (e.status == "settled") "Escrow" else "In escrow", style = T.footnote, trailing = {
                    Text(escrowState(e), style = T.footnote, color = if (link != null) Theme.accentInk else Theme.muted)
                })
            }
            if (ride.role == "driver" && e.driverAmount != null) {
                ListRow { Text("You get ${Fmt.amount(e.driverAmount, Fmt.coinSymbol(e.coin))}.", style = T.caption, color = Theme.faint) }
            }
        }
        if (ride.checkoutWarning == true) {
            CardDivider(16.dp)
            ListRow {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Sym.info, null, tint = Theme.muted, modifier = Modifier.size(16.dp))
                    Text(
                        if (isRider) "Heads-up: your phone wasn’t within 500 m of the drop-off when you were checked out. If you were dropped off correctly, you can ignore this. If not, you have 24 hours to appeal."
                        else "Heads-up: the rider’s phone wasn’t within 500 m of the drop-off at check-out. If you dropped them off correctly, you can ignore this. They have 24 hours to appeal.",
                        style = T.caption, color = Theme.muted,
                    )
                }
            }
        }
    }
}

private fun escrowState(e: RideEscrow): String {
    if (e.onHold == true && e.status == "paid") return "On hold: being checked"
    return when {
        e.status == "settled" && e.outcome == "payout" -> "Paid out"
        e.status == "settled" && e.outcome == "split" -> "Split 50/50"
        e.status == "settled" -> "Refunded"
        e.outcome == "payout" -> e.settleAfter?.let { "Pays out ${Fmt.dayTime(it)}" } ?: "Paying out"
        e.outcome == "split" -> e.settleAfter?.let { "Splits 50/50 ${Fmt.dayTime(it)}" } ?: "Splits 50/50 soon"
        e.outcome == "refund" || e.outcome == "expired" -> "Refunding"
        else -> "${Fmt.amount(e.amount, Fmt.coinSymbol(e.coin))} held"
    }
}

@Composable
private fun AfterRide(ride: Ride, isRider: Boolean, onReview: () -> Unit, onAppeal: () -> Unit) {
    if (ride.status == "completed") {
        ListSection {
            if (isRider) {
                val review = ride.review
                if (review != null) {
                    ListRow { LabeledRow("Your review", trailing = { Stars(review.stars ?: 0) }) }
                } else {
                    ListRow(onClick = onReview) { LabelRow(Sym.starOutline, "Rate your driver", T.subheadline, Theme.accentInk) }
                }
            } else {
                ride.payout?.takeUnless { ride.isCash }?.let { p ->
                    ListRow {
                        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(payoutTitle(p), style = T.subheadline.semibold, color = Theme.ink)
                            if (p.status == "held" && p.dueAt != null) Text("Paid to your wallet around ${Fmt.dayTime(p.dueAt)}, if no one appeals.", style = T.footnote, color = Theme.muted)
                            p.txid?.let { Text(Fmt.shortAddress(it), style = T.caption.mono, color = Theme.faint) }
                        }
                    }
                }
            }
            if (ride.syncScore != null && !isRider) {
                ListRow { LabeledRow("You and your rider together", "${(ride.syncScore * 100).toInt()}%", T.footnote) }
            }
        }
    }
    if (ride.isOver) {
        val d = ride.dispute
        if (d != null) {
            ListSection {
                ListRow {
                    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        Text(
                            if (d.status == "open") "Appeal being looked at" else if (d.status == "closed") "Appeal closed" else if (d.status == "refund_rider") "Appeal decided: rider refunded" else "Appeal decided: driver paid",
                            style = T.subheadline.semibold, color = Theme.ink,
                        )
                        d.answer?.let { Text(it, style = T.footnote, color = Theme.muted) }
                    }
                }
            }
        } else {
            // A rider who cancelled paid half: a driver who touched the pickup and left can be appealed, while the money still waits.
            val canAppeal = when {
                // Cash has no escrow to wait on: 24 hours after check-out, to reach a person.
                ride.isCash -> ride.status == "completed" && ride.payout?.dueAt?.let { ServerClock.date(it) > System.currentTimeMillis() } == true
                isRider && ride.status == "cancelled" -> ride.escrow?.outcome == "split" && ride.escrow.status == "paid"
                isRider -> ride.payout?.status == "held"
                else -> true
            }
            if (canAppeal) {
                ListSection(footer = if (isRider) ride.payout?.dueAt?.let { "You can appeal until ${Fmt.dayTime(it)}." } else null) {
                    ListRow(onClick = onAppeal) { LabelRow(Sym.alert, "Something went wrong", T.subheadline, Theme.ink, Theme.accentInk) }
                }
            }
        }
    }
}

private fun payoutTitle(p: RidePayout): String = when (p.status) {
    "held" -> "Payout waiting 24 hours"
    "queued", "sending", "sent" -> "Payout on its way"
    "confirmed" -> "Paid out"
    "demo" -> "Demo ride: no real payout"
    "cancelled" -> "Not paid: refunded to the rider"
    else -> "Payout being checked"
}

fun rideStateCardShows(ride: Ride): Boolean {
    if (ride.status in listOf("searching", "offered")) return true
    if (ride.status == "awaiting_payment") return ride.scheduledAt == null
    return ride.status in listOf("accepted", "arrived")
}

// What's going on with the order and what cancelling does right now, in words, for the rider.
@Composable
fun RideStateCard(ride: Ride, onCancelled: (Ride) -> Unit = {}) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        @Composable fun line(text: String) = Text(text, style = T.footnote, color = Theme.muted)
        @Composable fun eta() {
            ride.etaLine?.let { LabelRow(Sym.car, it, T.subheadline.semibold, Theme.accentInk) }
        }
        when (ride.status) {
            "searching", "offered" -> {
                ride.offeredUntil?.let { until ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("Time left", style = T.subheadline.semibold, color = Theme.ink, modifier = Modifier.weight(1f))
                        Countdown(until)
                    }
                }
                line("You can still cancel, for free.")
            }
            "awaiting_payment" -> {
                eta()
                line("You can still cancel, for free.")
            }
            else -> {
                if (ride.status == "accepted") eta()
                val by = ride.pickupDeadlineAt
                when {
                    ride.isCash -> line("You pay ${Fmt.eur(ride.shownPriceCents)} in cash, in the car. You can still cancel, for free.")
                    ride.driverLate == true -> {
                        Text(if (ride.status == "arrived") "Your driver came late" else "Your driver is late", style = T.subheadline.semibold, color = Theme.ok)
                        line(
                            if (ride.status == "arrived") "You can cancel for a full refund until you check in."
                            else "You can cancel for a full refund until you check in. Check the map first: if your driver is clearly coming, we recommend waiting.",
                        )
                        RideCancelButton(ride, onCancelled)
                    }
                    ride.refundPercent == 100 && ride.freeCancelUntil != null -> line("Free to cancel until ${Fmt.time(ServerClock.date(ride.freeCancelUntil))}.")
                    ride.status == "arrived" -> line("Check in once you’re inside the car. Cancelling now gives 50% back.")
                    by != null -> line("Cancelling now gives 50% back. If your driver isn’t here by ${Fmt.time(ServerClock.date(by))}, you get everything back.")
                }
            }
        }
    }
}

// A late driver's is on the state card, in green, right under what it means.
fun rideCancelShows(ride: Ride): Boolean =
    ride.status in listOf("searching", "awaiting_payment", "offered", "open", "scheduled", "accepted", "arrived") && ride.driverLate != true

// Cancelling, for the rider: asks first, and says what comes back. Green when the driver is late, as it's a full refund then.
@Composable
fun RideCancelButton(ride: Ride, onDone: (Ride) -> Unit = {}) {
    val app = AppState
    val scope = rememberCoroutineScope()
    var asking by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val message = when {
        ride.driverLate == true -> "Your driver is late, so everything goes back to the wallet you paid with, and your driver gets nothing."
        ride.refundPercent == 50 -> "50% goes back to your wallet and your driver gets the other 50%."
        ride.status == "scheduled" && ride.freeCancelUntil != null -> "Free until ${Fmt.dayTime(ServerClock.date(ride.freeCancelUntil))}: everything goes back to your wallet. After that, 50% goes to your driver."
        ride.escrow?.status == "paid" -> "Everything goes back to the wallet you paid with."
        else -> "You haven’t paid anything: cancelling is free."
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (ride.driverLate == true) {
            PrimaryButton("Cancel for a full refund", color = Theme.okFill, textColor = Color.White, enabled = !working, onClick = { asking = true })
        } else {
            GhostButton(if (ride.status in listOf("searching", "offered", "open")) "Cancel order" else "Cancel ride", height = 48.dp, color = Theme.danger, enabled = !working, onClick = { asking = true })
        }
        ErrorText(error)
    }
    if (asking) {
        AskDialog(
            title = "Cancel this ride?",
            message = message,
            choices = listOf(
                Choice("Cancel ride", destructive = true) {
                    scope.launch {
                        working = true
                        error = null
                        try {
                            val r: RideResponse = ApiClient.post("/api/rides/${ride.id}/cancel")
                            onDone(r.ride)
                            app.syncNow()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            error = e.shown
                        }
                        working = false
                    }
                },
            ),
            cancelText = "Keep it",
            onDismiss = { asking = false },
        )
    }
}

// Which wallet pays: it opens with the payment ready to approve, then comes back here.
@Composable
fun PayWalletSheet(ride: Ride, onSent: () -> Unit, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var error by remember { mutableStateOf<String?>(null) }
    var missingApp by remember { mutableStateOf<Wallets.App?>(null) }

    fun pay(wallet: Wallets.App) {
        error = null
        missingApp = null
        scope.launch {
            try {
                Wallets.pay(ride.id, wallet, ride.network)
                onSent()
                close()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = Wallets.problem(e)
                if (Wallets.isMissingApp(e)) missingApp = wallet
            }
        }
    }

    Screen(
        title = "Pay ${Fmt.eur(ride.shownPriceCents)}",
        close = {
            Wallets.stopWaiting()
            close()
        },
    ) {
        ride.payAmount?.let { amount ->
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(Fmt.coinAmount(amount, ride.coin), style = T.title2.bold.digits, color = Theme.ink)
                Text("${Fmt.eur(ride.shownPriceCents)} in value${ride.eurPerCoin?.let { " · 1 ${Fmt.coinSymbol(ride.coin)} is ${Fmt.eurPrice(it)}" } ?: ""}", style = T.subheadline.digits, color = Theme.muted)
            }
        }
        Text("Pick the wallet with the money. It opens with the payment ready: approve it there, then come back. Refunds go back to this wallet.", style = T.subheadline, color = Theme.muted)
        ChainQueueNote()
        // Up here: below the wallets and the code it would be out of sight.
        error?.let { Text(it, style = T.subheadline, color = Theme.danger) }
        missingApp?.let { app ->
            app.store?.let { store ->
                ListSection { ListRow(onClick = { openUrl(context, store) }) { Text("Get ${app.name} on Google Play", style = T.subheadline, color = Theme.accentInk) } }
            }
        }
        if (Wallets.waitingFor != null) {
            WalletWaitingSections()
        } else {
            ListSection("Pay with") {
                Wallets.apps.forEachIndexed { i, wallet ->
                    if (i > 0) CardDivider(16.dp)
                    WalletAppRow(wallet) { pay(wallet) }
                }
            }
            ride.payUrl?.let { raw ->
                ListSection("Or with Solana Pay", "Scan it with a wallet on another device. The link opens whichever wallet your phone picks.") {
                    Box(Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) { QRCode(raw, 170.dp) }
                    CardDivider(16.dp)
                    ListRow(onClick = { openUrl(context, raw) }) { LabelRow(Sym.openApp, "Open as a Solana Pay link", iconTint = Theme.accentInk) }
                }
            }
        }
    }
}

// When the Solana connection is busy, the server lines up what it asks the network (server/src/rpcqueue.js), riders paying first,
// so a payment can wait its turn: this says so, and about how long. It asks the server every few seconds while it's on screen,
// which costs nothing on the network. Nothing shows while there's no line.
@Composable
fun ChainQueueNote() {
    var seconds by remember { mutableStateOf<Int?>(null) }
    LaunchedEffect(Unit) {
        while (true) {
            if (AppState.isActive) attempt { ApiClient.get<ChainQueue>("/api/chain/queue") }?.let { seconds = it.seconds }
            delay(4000)
        }
    }
    val s = seconds ?: 0
    AnimatedVisibility(visible = s >= 3, enter = fadeIn(tween(200)) + expandVertically(tween(200)), exit = fadeOut(tween(200)) + shrinkVertically(tween(200))) {
        NoteBox(
            Sym.hourglass,
            tint = Theme.warn,
            background = Theme.warnSoft,
            text = "Busy on Solana right now: payments wait in a queue, about ${Fmt.queueWait(s)}. Yours goes through by itself when it’s its turn, so keep Drivezzz open.",
        )
    }
}

// Paying a ride once a driver has it: the rider picks a wallet app, which opens with the payment ready to approve. The
// money waits in the ride's own escrow on Solana until the ride is done; refunds go back to that wallet.
@Composable
fun PayRideCard(ride: Ride) {
    val app = AppState
    val scope = rememberCoroutineScope()
    var choosing by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    var testPayError by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            // What you pay in the coin, and what that's worth (Pieter, 8 November 2026: clearly, both). As PayRideCard in Rides.swift.
            val amount = ride.payAmount
            if (amount != null) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(Fmt.coinAmount(amount, ride.coin), style = T.size(34).bold.kern(-0.8f).digits, color = Theme.ink, maxLines = 1)
                    Text("${Fmt.eur(ride.shownPriceCents)} in value", style = T.title3.semibold.digits, color = Theme.ink)
                }
            } else {
                Text(Fmt.eur(ride.shownPriceCents), style = T.size(40).bold.kern(-1f), color = Theme.ink)
                Spacer(Modifier.width(8.dp))
                Text("in ${Fmt.coinSymbol(ride.coin)}", style = T.subheadline.semibold, color = Theme.muted, modifier = Modifier.weight(1f))
            }
            ride.payBy?.let { by ->
                if (ride.scheduledAt == null) {
                    Countdown(by, redBelow = 120)
                } else {
                    Text("Pay by ${Fmt.dayTime(ServerClock.date(by))}", style = T.subheadline.semibold, color = Theme.accentInk, textAlign = TextAlign.End)
                }
            }
        }
        val rate = ride.eurPerCoin
        if (ride.payAmount != null && rate != null) {
            Text("1 ${Fmt.coinSymbol(ride.coin)} is ${Fmt.eurPrice(rate)} now. Your wallet asks for the exact amount, at the price when you pay.", style = T.caption, color = Theme.muted)
        }
        // Only a debug build can reach a test server, and only a test server says this.
        if (BuildConfig.TEST_BUTTONS && ride.testPay == true) {
            PrimaryButton("Pay (test, no real money)", onClick = {
                testPayError = null
                scope.launch {
                    try {
                        ApiClient.call("POST", "/api/rides/${ride.id}/pretend-pay")
                        sent = true
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        testPayError = e.shown
                    }
                    app.syncNow()
                }
            })
            ErrorText(testPayError)
            // The way a real wallet pays, for trying it against a stand-in wallet: android/fakewallet.
            GhostButton("Try a wallet instead (test)", height = 44.dp, onClick = { choosing = true })
        } else {
            PrimaryButton(onClick = { choosing = true }) {
                Icon(Sym.wallet, null, modifier = Modifier.size(20.dp))
                Text(if (sent) "Pay again" else "Pay with your wallet", style = T.size(17).semibold.kern(-0.2f))
            }
        }
        ChainQueueNote()
        if (sent) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Spinner(size = 16.dp)
                Text("Sent. Waiting for it on the chain…", style = T.footnote, color = Theme.muted)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            PayNote(Sym.lockShield, "Held in escrow on Solana until your ride is done.")
            PayNote(Sym.undo, if (ride.scheduledAt != null) "Free to cancel until 3 hours before." else "Once you’ve paid, cancelling gives 50% back, or everything if your driver is late.")
            PayNote(Sym.bolt, "Network fee about €0.001, plus a small deposit (about €0.20) that comes back to you.")
        }
    }
    if (choosing) {
        DzSheet(onDismiss = {
            Wallets.stopWaiting()
            choosing = false
        }) {
            PayWalletSheet(ride, onSent = {
                sent = true
                scope.launch { app.syncNow() }
            }, close = { choosing = false })
        }
    }
}

@Composable
private fun PayNote(symbol: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Icon(symbol, null, tint = Theme.accentInk, modifier = Modifier.padding(top = 1.dp).size(15.dp))
        Text(text, style = T.caption, color = Theme.muted)
    }
}

// Opens by itself when the driver is within 100 m.
@Composable
fun CheckInScreen(ride: Ride, onDone: (Ride) -> Unit = {}, close: () -> Unit) {
    val app = AppState
    val scope = rememberCoroutineScope()
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // As on iOS, the button always shows: on a small phone the top scrolls, not the whole sheet.
    Column(
        Modifier.fillMaxSize().padding(22.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Column(
            Modifier.weight(1f).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { TextAction("Not yet", close) }
            Text("Check the number plate", style = T.size(28).bold.kern(-0.5f), color = Theme.ink, textAlign = TextAlign.Center)
            PlateView(ride.driver?.car?.shownPlate ?: "", 30.dp)
            ride.driver?.car?.let { car ->
                Text("${car.colorName ?: ""} ${car.title}".trim(), style = T.headline, color = Theme.muted)
                CarGallery(car, 150.dp)
            }
            ride.driver?.name?.let { Text("Your driver is $it", style = T.subheadline, color = Theme.muted) }
        }
        LabelRow(Sym.warning, "Only check in when you’re ${Vehicle.riding(ride.driver?.car?.kind)}.", T.subheadline.semibold, Theme.ink, Theme.ink)
        ErrorText(error)
        PrimaryButton("I’m ${Vehicle.riding(ride.driver?.car?.kind)}: check in", working = working, onClick = {
            val here = LocationService.location
            if (here == null) {
                error = "We need your location to check in."
                return@PrimaryButton
            }
            working = true
            error = null
            scope.launch {
                try {
                    val r: RideResponse = ApiClient.post("/api/rides/${ride.id}/check-in", mapOf("lat" to here.latitude, "lng" to here.longitude, "plateChecked" to true))
                    // Riding, straight from the answer.
                    app.use(r.ride)
                    onDone(r.ride)
                    close()
                    app.syncNow()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = e.shown
                }
                working = false
            }
        })
    }
}

@Composable
private fun ReviewSheet(ride: Ride, onDone: (Ride) -> Unit, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var stars by remember { mutableIntStateOf(5) }
    var text by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Row {
            Box(Modifier.weight(1f)) { ScreenTitle("How was your ride?", "Your review shows on your driver’s profile.") }
            TextAction("Not now", close)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            for (i in 1..5) {
                Icon(
                    Sym.star, "$i stars",
                    tint = if (i <= stars) Theme.route else Theme.line,
                    modifier = Modifier.size(40.dp).clickable { stars = i },
                )
            }
        }
        DzField(text, { text = it }, "Anything to add? (optional)", minLines = 3, maxLines = 5)
        ErrorText(error)
        PrimaryButton("Send", onClick = {
            scope.launch {
                try {
                    val r: RideResponse = ApiClient.post("/api/rides/${ride.id}/review", mapOf("stars" to stars, "text" to text))
                    onDone(r.ride)
                    close()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = e.shown
                }
            }
        })
    }
}

@Composable
private fun AppealSheet(ride: Ride, onDone: (Ride) -> Unit, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var text by remember { mutableStateOf("") }
    var impossibleDropoff by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    // Only a driver can say the rider's drop-off couldn't be reached.
    val canReportDropoff = ride.role == "driver" && ride.rider != null
    val hasText = text.trim().length >= 5
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        ScreenTitle("What went wrong?", if (canReportDropoff) "We look at your route and the rider’s, and answer here." else "We look at your route and the driver’s, and answer here.")
        if (canReportDropoff) {
            Row(Modifier.clickable { impossibleDropoff = !impossibleDropoff }, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Icon(if (impossibleDropoff) Sym.boxChecked else Sym.box, null, tint = if (impossibleDropoff) Theme.accentInk else Theme.faint, modifier = Modifier.size(24.dp))
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(Reporting.IMPOSSIBLE_DROPOFF, style = T.subheadline.semibold, color = Theme.ink)
                    Text("Reports the rider and adds this drive, so we can see the planned route on a map.", style = T.caption, color = Theme.muted)
                }
            }
        }
        DzField(text, { text = it }, "Tell us what happened", minLines = 4)
        ErrorText(error)
        PrimaryButton(if (hasText) "Send appeal" else "Send report", enabled = hasText || impossibleDropoff, working = working, onClick = {
            working = true
            error = null
            scope.launch {
                try {
                    val rider = ride.rider
                    if (impossibleDropoff && rider != null) Reporting.send(rider.id, Reporting.IMPOSSIBLE_DROPOFF, text, ride.id)
                    if (hasText) {
                        val r: RideResponse = ApiClient.post("/api/rides/${ride.id}/appeal", mapOf("message" to text))
                        onDone(r.ride)
                    }
                    close()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = e.shown
                }
                working = false
            }
        })
    }
}
