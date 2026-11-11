package eu.drivezzz.app.features

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.Role
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.AppMode
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.LocationService
import eu.drivezzz.app.core.Phase
import eu.drivezzz.app.core.RideResponse
import eu.drivezzz.app.core.SavedRoutes
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.ui.AskDialog
import eu.drivezzz.app.ui.Choice
import eu.drivezzz.app.ui.DzSheet
import eu.drivezzz.app.ui.LocalBarHeight
import eu.drivezzz.app.ui.NavStack
import eu.drivezzz.app.ui.PrimaryButton
import eu.drivezzz.app.ui.Sym
import eu.drivezzz.app.ui.T
import eu.drivezzz.app.ui.Hairline
import eu.drivezzz.app.ui.Theme
import eu.drivezzz.app.ui.medium
import eu.drivezzz.app.ui.bold
import eu.drivezzz.app.ui.keptAlive
import eu.drivezzz.app.ui.openSettings
import eu.drivezzz.app.ui.openUrl
import eu.drivezzz.app.ui.pageWidth
import eu.drivezzz.app.ui.semibold
import kotlinx.coroutines.launch

@Composable
fun RootView(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxSize().background(Theme.page)) {
        Crossfade(AppState.phase, animationSpec = tween(250), label = "phase") { phase ->
            when (phase) {
                Phase.Loading -> LoadingScreen()
                Phase.Intro -> IntroScreen()
                Phase.Name -> NameScreen()
                Phase.Main -> MainView()
                Phase.Banned -> BanScreen()
            }
        }
    }
}

@Composable
private fun MainView() {
    if (LocationService.denied || LocationService.imprecise) {
        LocationNeededScreen(LocationService.imprecise)
    } else {
        MainTabs()
    }
}

// A tab that's been opened stays alive, as on iOS: its map and its state are there when you come back.
@Composable
private fun KeptTab(showing: Boolean, content: @Composable () -> Unit) {
    var seen by remember { mutableStateOf(showing) }
    if (showing) seen = true
    if (seen) Box(Modifier.fillMaxSize().keptAlive(showing)) { content() }
}

private class TabItem(val tag: Int, val title: String, val icon: ImageVector, val badge: Int = 0)

// The bar along the bottom, as on an iPhone: an icon over a small word, the colour says which tab you're on, and no pill. Material's
// own NavigationBar is half as tall again and looks like another app.
@Composable
private fun TabBar(items: List<TabItem>, selected: Int, modifier: Modifier = Modifier, select: (Int) -> Unit) {
    Column(modifier.fillMaxWidth().background(Theme.card)) {
        Hairline()
        Row(Modifier.fillMaxWidth().navigationBarsPadding().height(50.dp)) {
            items.forEach { item ->
                val on = selected == item.tag
                val colour = if (on) Theme.accentInk else Theme.faint
                Column(
                    Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .selectable(on, role = Role.Tab, interactionSource = null, indication = null) { select(item.tag) },
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center,
                ) {
                    BadgedBox(badge = { if (item.badge > 0) Badge(containerColor = Theme.danger, contentColor = androidx.compose.ui.graphics.Color.White) { Text(if (item.badge > 99) "99+" else "${item.badge}") } }) {
                        Icon(item.icon, null, tint = colour, modifier = Modifier.size(25.dp))
                    }
                    Text(item.title, style = T.caption2.copy(fontSize = 10.sp, lineHeight = 12.sp).medium, color = colour, maxLines = 1)
                }
            }
        }
    }
}

// Riding and driving are one set of tabs around one Profile, and the switch only swaps the tabs around it.
@Composable
private fun MainTabs() {
    val app = AppState
    val driving = app.mode == AppMode.Driver && app.user?.isDriver == true
    val selected = if (driving) app.driverTab else app.riderTab
    fun select(tab: Int) {
        if (driving) app.driverTab = tab else app.riderTab = tab
    }
    val items = if (driving) {
        listOf(
            TabItem(0, "Driving", Sym.steering),
            TabItem(1, "Map", Sym.map),
            // Chat is top right on Drives: there are five tabs already.
            TabItem(2, "Drives", Sym.list, app.unreadMessages),
            TabItem(3, "My page", Sym.garage),
            TabItem(AppState.PROFILE_TAB, "Profile", Sym.person),
        )
    } else {
        listOf(
            TabItem(0, "Home", Sym.car),
            TabItem(1, "Rides", Sym.list),
            TabItem(2, "Chat", Sym.chat, app.unreadMessages),
            TabItem(AppState.PROFILE_TAB, "Profile", Sym.person),
        )
    }
    // Saved routes are kept per account.
    LaunchedEffect(app.user?.id) { SavedRoutes.use(app.user?.id) }
    val density = LocalDensity.current
    var barHeight by remember { mutableStateOf(0.dp) }
    Column(Modifier.fillMaxSize()) {
        CompositionLocalProvider(LocalBarHeight provides barHeight) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (driving) {
                    KeptTab(selected == 0) { DrivingScreen() }
                    KeptTab(selected == 1) { DriverMapScreen() }
                    KeptTab(selected == 2) { DrivesScreen() }
                    KeptTab(selected == 3) { MyPageScreen() }
                } else {
                    KeptTab(selected == 0) { HomeScreen() }
                    KeptTab(selected == 1) { RidesScreen() }
                    KeptTab(selected == 2) { ChatTab() }
                }
                KeptTab(selected == AppState.PROFILE_TAB) { ProfileScreen() }
            }
        }
        TabBar(items, selected, Modifier.onSizeChanged { barHeight = with(density) { it.height.toDp() } }) { select(it) }
    }

    // Opens by itself when the driver is close. It can be dismissed, and opened again from Rides.
    val ride = app.ride
    if (!driving && ride != null && ride.canCheckIn == true && app.dismissedCheckIn != ride.id && app.showingRide == null && app.rideOnScreen != ride.id) {
        DzSheet(onDismiss = { app.dismissedCheckIn = ride.id }, background = Theme.card) { CheckInScreen(ride) { app.dismissedCheckIn = ride.id } }
    }
    val shown = app.showingRide
    if (!driving && shown != null) {
        DzSheet(onDismiss = { app.showingRide = null }) {
            NavStack { RideDetailScreen(shown, close = { app.showingRide = null }) }
        }
    }
    // A booked ride opened from a driver's map: its page, as on Drives.
    val mapRide = app.mapRide
    if (driving && mapRide != null) {
        DzSheet(onDismiss = { app.mapRide = null }) {
            NavStack { RideDetailScreen(mapRide, close = { app.mapRide = null }) }
        }
    }
    // Swiped down, a request stays in Current on Drives until its time is up.
    val offer = app.driving.offer
    if (driving && offer != null && offer.id != app.parkedOffer) {
        DzSheet(onDismiss = {
            app.parkedOffer = offer.id
            app.drivesPart = 0
        }, background = Theme.card) { OfferScreen(offer) }
    }
    // Driving in the Netherlands: going online opens it when the checks are needed, and so does Profile.
    if (app.checksOpen) {
        DzSheet(onDismiss = { app.checksOpen = false }) { eu.drivezzz.app.features.checks.DriverChecksSheet { app.checksOpen = false } }
    }
    SafetyQuestion()
}

// Is everything OK? Asked when the rider's phone and the car drift apart during a ride.
@Composable
private fun SafetyQuestion() {
    val app = AppState
    val context = LocalContext.current
    val ride = app.ride
    if (app.mode != AppMode.Rider || ride?.safetyAsked != true) return
    fun answer(ok: Boolean) {
        app.scope.launch {
            attempt { ApiClient.post<RideResponse>("/api/rides/${ride.id}/safety", mapOf("ok" to ok)) }
            app.syncNow()
        }
    }
    AskDialog(
        title = "Is everything OK?",
        message = "Your phone and the car seem to be going different ways.",
        choices = listOf(
            Choice("I’m OK") { answer(true) },
            Choice("Something’s wrong", destructive = true) {
                answer(false)
                openDialer(context, "112")
            },
        ),
        cancelText = "Not now",
        onDismiss = {},
    )
}

private fun openDialer(context: android.content.Context, number: String) {
    runCatching {
        context.startActivity(android.content.Intent(android.content.Intent.ACTION_DIAL, android.net.Uri.parse("tel:$number")).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}

@Composable
private fun LocationNeededScreen(imprecise: Boolean) {
    val context = LocalContext.current
    var showProfile by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().pageWidth().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Spacer(Modifier.weight(1f))
        Icon(Sym.locationOff, null, tint = Theme.accentInk, modifier = Modifier.size(46.dp))
        Text(if (imprecise) "We need your precise location" else "We need your location to use this app", style = T.title2.bold, textAlign = TextAlign.Center, color = Theme.ink)
        Text(
            if (imprecise) "Rides are checked in within 100 m of the car. In Settings → Permissions → Location, turn on Use precise location."
            else "Drivers and riders find each other by location, and rides are checked in and out with it.",
            style = T.subheadline, textAlign = TextAlign.Center, color = Theme.muted,
        )
        Spacer(Modifier.weight(1f))
        PrimaryButton("Open Settings", onClick = { openSettings(context) })
        Box(Modifier.heightIn(min = 36.dp).clickable { showProfile = true }, contentAlignment = Alignment.Center) {
            Text("Profile and account", style = T.subheadline.semibold, color = Theme.accentInk)
        }
    }
    if (showProfile) DzSheet(onDismiss = { showProfile = false }) { ProfileScreen() }
}
