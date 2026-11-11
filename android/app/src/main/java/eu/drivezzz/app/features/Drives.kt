package eu.drivezzz.app.features

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.Ride
import eu.drivezzz.app.core.RidesResponse
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.launch
import java.time.LocalDate

fun driverStatus(ride: Ride): String = when (ride.status) {
    "awaiting_payment" -> "Waiting for payment"
    "accepted" -> "On the way to the pickup"
    "arrived" -> "At the pickup"
    "riding" -> "Riding to the drop-off"
    "scheduled" -> "Planned"
    "completed" -> "Completed"
    "cancelled" -> "Cancelled"
    else -> ride.statusTitle
}

// A driver's drives: the one on now, the planned ones as an agenda, and the finished ones. Chat is top right.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DrivesScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    var rides by remember { mutableStateOf<List<Ride>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }

    fun finishedAt(ride: Ride): Double = ride.checkedOutAt ?: ride.cancelledAt ?: ride.scheduledAt ?: ride.createdAt ?: 0.0
    val current = app.driving.drive ?: rides.firstOrNull { it.isLive }
    val planned = rides.filter { it.status == "scheduled" || (it.needsPayment && it.scheduledAt != null) }.sortedBy { it.scheduledAt ?: 0.0 }
    val finished = rides.filter { it.isOver }.sortedByDescending { finishedAt(it) }

    suspend fun load() {
        attempt { ApiClient.get<RidesResponse>("/api/driver/rides") }?.let { rides = it.rides ?: emptyList() }
        loaded = true
    }
    LaunchedEffect(app.rev) { load() }

    NavStack {
        val nav = LocalNav.current
        Screen(
            "Drives",
            large = true,
            scroll = false,
            padding = androidx.compose.foundation.layout.PaddingValues(0.dp),
            actions = {
                Box(Modifier.size(44.dp).clickable { nav?.push { MessagesScreen() } }, contentAlignment = Alignment.Center) { ChatButton(app.unreadMessages) }
            },
        ) {
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
                Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Segmented(listOf("Current", if (planned.isEmpty()) "Planned" else "Planned · ${planned.size}", "Completed"), app.drivesPart) { app.drivesPart = it }
                    when (app.drivesPart) {
                        0 -> {
                            app.driving.offer?.let { offer ->
                                Box(Modifier.fillMaxWidth().card(24.dp)) { OfferCard(offer, 170.dp) }
                            }
                            if (current != null) {
                                Column(Modifier.fillMaxWidth().card(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                                        RideStatusPill(driverStatus(current), current)
                                        if (current.needsPayment && current.scheduledAt == null) current.payBy?.let { Countdown(it) }
                                        Spacer(Modifier.weight(1f))
                                        Text(Fmt.eur(current.shownPriceCents), style = T.title2.bold.digits.kern(-0.5f), color = Theme.ink)
                                    }
                                    RouteStops(current.pickup.label, current.dropoff.label)
                                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                                        current.rider?.name?.let { Fact(Sym.person, it) }
                                        Fact(Sym.route, Fmt.km(current.distanceM))
                                        Fact(Sym.clock, Fmt.minutes(current.durationS))
                                    }
                                    PrimaryButton(
                                        if (current.navigationTarget == null || current.status == "riding") "Open the drive" else "Go to rider",
                                        onClick = {
                                            app.driveOpen = true
                                            app.driverTab = 0
                                        },
                                    )
                                }
                                Text("While you have a rider you can’t claim another drive.", style = T.footnote, color = Theme.faint)
                            } else if (app.driving.offer == null) {
                                EmptyPart(Sym.steering, "No drive right now", "Go online on the Driving tab and claim an order, or wait for one to be offered to you.") {
                                    PrimaryButton("Go to Driving", onClick = { app.driverTab = 0 })
                                }
                            }
                        }
                        1 -> if (planned.isEmpty()) {
                            EmptyPart(
                                Sym.calendar, "Nothing planned",
                                if (app.driver?.allowsPlanning == true) "Planned orders show on the map in yellow. Claim one and it shows here, by day."
                                else "Turn on planning on My page, and riders can book you for later.",
                            ) {
                                if (app.driver?.allowsPlanning != true) PrimaryButton("Open My page", onClick = { app.driverTab = 3 })
                            }
                        } else {
                            days(planned) { it.scheduledAt ?: 0.0 }.forEach { (day, group) ->
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    DayHeader(day)
                                    group.forEach { ride ->
                                        Box(Modifier.clickable { nav?.push { RideDetailScreen(ride) } }) { AgendaRow(ride) }
                                    }
                                }
                            }
                        }
                        else -> if (finished.isEmpty()) {
                            EmptyPart(Sym.seal, if (loaded) "No drives yet" else "Loading…", "Your finished drives and what you earned show here.") {}
                        } else {
                            days(finished) { finishedAt(it) }.forEach { (day, group) ->
                                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                    DayHeader(day, Fmt.eur(group.filter { it.status == "completed" }.mapNotNull { it.priceCents }.sum()))
                                    Column(Modifier.fillMaxWidth().lifted(0.45f, 22.dp).clip(RoundedCornerShape(22.dp)).background(Theme.card)) {
                                        group.forEachIndexed { i, ride ->
                                            if (i > 0) CardDivider(14.dp)
                                            Box(Modifier.clickable { nav?.push { RideDetailScreen(ride) } }) { FinishedRow(ride, finishedAt(ride)) }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun days(list: List<Ride>, at: (Ride) -> Double): List<Pair<LocalDate, List<Ride>>> {
    val out = ArrayList<Pair<LocalDate, MutableList<Ride>>>()
    for (ride in list) {
        val day = Fmt.localDay(at(ride))
        if (out.lastOrNull()?.first == day) out.last().second.add(ride) else out.add(day to mutableListOf(ride))
    }
    return out
}

// The chat bubble with the number of unread messages on it.
@Composable
fun ChatButton(unread: Int) {
    Box(Modifier.size(36.dp).semantics { contentDescription = if (unread > 0) "Chat, $unread unread" else "Chat" }, contentAlignment = Alignment.Center) {
        Icon(Sym.chat, null, tint = Theme.accentInk, modifier = Modifier.size(24.dp))
        if (unread > 0) {
            Box(
                Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-4).dp).heightIn(min = 18.dp).background(Theme.danger, CircleShape).padding(horizontal = 5.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(if (unread > 9) "9+" else "$unread", style = T.caption2.bold, color = Color.White)
            }
        }
    }
}

@Composable
private fun Fact(symbol: ImageVector, text: String) {
    LabelRow(symbol, text, T.footnote.medium, Theme.muted)
}

@Composable
private fun DayHeader(day: LocalDate, trailing: String? = null) {
    Row(Modifier.padding(start = 4.dp, end = 4.dp, top = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(Fmt.dayTitle(day), style = T.title3.bold.kern(-0.3f), color = Theme.ink, modifier = Modifier.weight(1f))
        if (trailing != null) Text(trailing, style = T.subheadline.bold.digits, color = Theme.ink)
    }
}

// One planned drive in the agenda: the time it starts and ends, then where to.
@Composable
private fun AgendaRow(ride: Ride) {
    val start = ride.scheduledAt ?: 0.0
    val end = start + (ride.durationS ?: 0) * 1000.0
    Row(
        Modifier.fillMaxWidth().height(IntrinsicSize.Min).lifted(0.45f, 22.dp).background(Theme.card, RoundedCornerShape(22.dp)).padding(14.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.width(58.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(Fmt.time(start), style = T.subheadline.bold.digits, color = Theme.ink, textAlign = TextAlign.End)
            Text(Fmt.time(end), style = T.caption.digits, color = Theme.faint, textAlign = TextAlign.End)
        }
        Box(Modifier.width(4.dp).fillMaxHeight().background(Theme.accent, RoundedCornerShape(2.dp)))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(ride.dropoff.label ?: "Drop-off", style = T.subheadline.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("From ${ride.pickup.label ?: "the pickup"}", style = T.footnote, color = Theme.muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Fact(Sym.people, Fmt.people(ride.passengers))
                Fact(Sym.route, Fmt.km(ride.distanceM))
                if (ride.pets == true) Fact(Sym.paw, "Pet")
            }
        }
        Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(Fmt.eur(ride.shownPriceCents), style = T.subheadline.bold.digits, color = Theme.ink)
            Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(18.dp))
        }
    }
}

@Composable
private fun FinishedRow(ride: Ride, at: Double) {
    val done = ride.status == "completed"
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(32.dp).background(if (done) Theme.okSoft else Theme.dangerSoft, CircleShape), contentAlignment = Alignment.Center) {
            Icon(if (done) Sym.check else Sym.close, null, tint = if (done) Theme.ok else Theme.danger, modifier = Modifier.size(16.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(ride.dropoff.label ?: "Drop-off", style = T.subheadline.semibold, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("${Fmt.time(at)} · ${if (done) Fmt.km(ride.distanceM) else "Cancelled"}${if (done && ride.isCash) " · Paid in cash" else ""}", style = T.caption, color = Theme.faint)
        }
        Text(if (done) Fmt.eur(ride.priceCents) else "–", style = T.subheadline.bold.digits, color = if (done) Theme.ink else Theme.faint)
    }
}

@Composable
private fun EmptyPart(symbol: ImageVector, title: String, text: String, action: @Composable () -> Unit) {
    Column(
        Modifier.fillMaxWidth().lifted(0.45f, 24.dp).background(Theme.card, RoundedCornerShape(24.dp)).padding(vertical = 32.dp, horizontal = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Box(Modifier.size(64.dp).background(Theme.accentSoft, CircleShape), contentAlignment = Alignment.Center) {
            Icon(symbol, null, tint = Theme.accentInk, modifier = Modifier.size(28.dp))
        }
        Text(title, style = T.title3.bold.kern(-0.3f), color = Theme.ink)
        Text(text, style = T.subheadline, color = Theme.muted, textAlign = TextAlign.Center)
        Box(Modifier.padding(top = 4.dp)) { action() }
    }
}
