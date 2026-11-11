package eu.drivezzz.app.features

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.Coins
import eu.drivezzz.app.core.AppMode
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.WalletCoin
import eu.drivezzz.app.core.WalletMove
import eu.drivezzz.app.core.WalletView
import eu.drivezzz.app.core.Wallets
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.min

// Your wallet. Drivezzz holds no money: a ride's payment waits in its own escrow on Solana until the ride is done.
// What shows here: money on hold going out and coming to you, per wallet with why and when, in red, green and orange (going
// out, coming in, still pending), then the wallet your addresses came from and what has already moved.
@Composable
fun WalletScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var wallet by remember { mutableStateOf<WalletView?>(null) }
    var addressFor by remember { mutableStateOf<WalletCoin?>(null) }
    var showConnect by remember { mutableStateOf(false) }
    var requestingChange by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    // Which side you're on now: someone who also drives can be riding, with money on hold.
    val isDriver = app.mode == AppMode.Driver && app.user?.isDriver == true
    val coins = wallet?.usedCoins ?: emptyList()
    val connected = coins.filter { it.address != null }
    // Gray until support says yes, and gray again once it's changed. The server decides this, and checks it again on saving.
    val locked = wallet?.change?.locked == true
    val moves = wallet?.moves ?: emptyList()
    val goingOut = moves.filter { it.pending == true && it.direction == "out" }
    val comingIn = moves.filter { it.pending == true && it.direction == "in" }
    val history = moves.filter { it.pending != true }
    // What's coming in, per wallet it lands in, soonest first.
    val perWallet = comingIn.groupBy { it.wallet ?: "" }
        .map { (w, list) -> w to list.sortedBy { it.`when` ?: Double.POSITIVE_INFINITY } }
        .sortedBy { it.second.firstOrNull()?.`when` ?: Double.POSITIVE_INFINITY }

    suspend fun load() {
        try {
            wallet = ApiClient.get<WalletView>("/api/wallet")
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = e.shown
        }
    }
    LaunchedEffect(app.rev) { load() }

    Screen("Wallet", spacing = 20.dp) {
        HeroCard {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(Sym.wallet, null, tint = Theme.onAccent.copy(alpha = 0.9f), modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(8.dp))
                    Text("Drivezzz wallet", style = T.subheadline.semibold, color = Theme.onAccent.copy(alpha = 0.9f), modifier = Modifier.weight(1f))
                    if (wallet?.demo == true) WalletPill("Demo") else if (wallet?.network == "testnet") WalletPill("Test network")
                }
                Row(Modifier.height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TotalTile("On hold, going out", sum(goingOut), "−", Theme.danger, Sym.arrowOutUp)
                    TotalTile("On hold, coming to you", sum(comingIn), "+", Theme.ok, Sym.arrowInDown)
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Sym.lockShield, null, tint = Theme.onAccent.copy(alpha = 0.9f), modifier = Modifier.size(16.dp))
                    Text("Drivezzz holds no money. Each ride’s payment waits in its own escrow on Solana until the ride is done.", style = T.caption.medium, color = Theme.onAccent.copy(alpha = 0.9f))
                }
            }
        }
        // What's on its way to you, per wallet it lands in, each with why and a timer.
        if (perWallet.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                perWallet.forEachIndexed { i, (address, list) ->
                    CardGroup(
                        if (i == 0) "Coming to your wallets" else null,
                        if (i == perWallet.lastIndex) "Refunds go back to the wallet you paid with. Pay for driving goes to the wallet you connected." else null,
                    ) {
                        Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(34.dp).background(Theme.accentSoft, CircleShape), contentAlignment = Alignment.Center) {
                                Icon(Sym.wallet, null, tint = Theme.accentInk, modifier = Modifier.size(18.dp))
                            }
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                Text(Fmt.shortAddress(address), style = T.subheadline.semibold.mono, color = Theme.ink)
                                val via = coins.firstOrNull { it.address == address }?.via
                                if (via != null) ViaPill(via) else Text("The wallet you paid with", style = T.caption, color = Theme.faint)
                            }
                            Text("+${Fmt.eur(sum(list))}", style = T.headline.bold.digits, color = Theme.ok)
                        }
                        list.forEach { move ->
                            CardDivider()
                            WalletMoveRow(move)
                        }
                    }
                }
            }
        }
        if (goingOut.isNotEmpty()) {
            CardGroup("Going out", "Held in escrow until the ride is done, then paid to your driver.") {
                goingOut.forEachIndexed { i, move ->
                    if (i > 0) CardDivider()
                    WalletMoveRow(move)
                }
            }
        }
        // Each address with the wallet app it came from, and whether you use that coin.
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Your wallet", style = T.headline, color = Theme.ink, modifier = Modifier.padding(horizontal = 4.dp))
            Column(Modifier.fillMaxWidth().lifted(0.45f, 22.dp).clip(RoundedCornerShape(22.dp)).background(Theme.card)) {
                coins.forEachIndexed { i, coin ->
                    if (i > 0) CardDivider()
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        CoinBadge(coin.id, 34.dp)
                        Column(
                            Modifier.weight(1f).clickable { if (coin.address == null) showConnect = true else addressFor = coin },
                            verticalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Text(coin.symbol ?: coin.id, style = T.subheadline.semibold, color = Theme.ink)
                            if (coin.address != null) {
                                Text(Fmt.shortAddress(coin.address), style = T.caption.mono, color = Theme.muted)
                                coin.via?.let { ViaPill(it) }
                                if (coin.needsTokenAccount == true) {
                                    Text("No USDC account yet, so USDC can’t reach this wallet. Swap a little SOL to USDC in your wallet once, then turn this on.", style = T.caption, color = Theme.warn)
                                }
                            } else {
                                Text("Not connected", style = T.caption.semibold, color = Theme.accentInk)
                            }
                        }
                        if (coin.address != null) {
                            DzSwitch(coin.enabled == true, if (isDriver) "Get paid in ${coin.symbol ?: ""}" else "Use ${coin.symbol ?: ""}") { on ->
                                scope.launch {
                                    try {
                                        wallet = ApiClient.post<WalletView>("/api/wallet/enable", mapOf("coin" to coin.id, "enabled" to on))
                                    } catch (e: CancellationException) {
                                        throw e
                                    } catch (e: Exception) {
                                        error = e.shown
                                    }
                                }
                            }
                        }
                    }
                }
                if (isDriver) {
                    if (coins.isNotEmpty()) CardDivider()
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        CoinBadge(Coins.cash, 34.dp)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text("Cash", style = T.subheadline.semibold, color = Theme.ink)
                            Text("Your rider pays you in the car", style = T.caption, color = Theme.muted)
                        }
                        DzSwitch(wallet?.takesCash == true, "Take cash") { on ->
                            scope.launch {
                                try {
                                    wallet = ApiClient.post<WalletView>("/api/wallet/cash", mapOf("enabled" to on))
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    error = e.shown
                                }
                            }
                        }
                    }
                }
            }
            Text(
                if (isDriver) "You’re paid to this wallet, in the coin your rider paid with. Turn on the coins you take."
                else "You don’t need a wallet here to ride: you pick one when you pay. Only drivers connect one, to get paid.",
                style = T.footnote, color = Theme.faint, modifier = Modifier.padding(horizontal = 4.dp),
            )
            Box(Modifier.padding(top = 6.dp)) {
                PrimaryButton(enabled = !locked, onClick = { showConnect = true }) {
                    Icon(if (connected.isEmpty()) Sym.link else Sym.sync, null, modifier = Modifier.size(20.dp))
                    Text(if (connected.isEmpty()) "Connect a wallet" else "Change wallet", style = T.size(17).semibold.kern(-0.2f))
                }
            }
            if (connected.isNotEmpty()) ChangeStatus(wallet, locked) { requestingChange = true }
            if (connected.isNotEmpty()) {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                    Text("Want an address removed? ", style = T.footnote, color = Theme.faint)
                    Text("Ask support", style = T.footnote, color = Theme.accentInk, modifier = Modifier.clickable { openUrl(context, "https://drivezzz.s3rver.nl/support") })
                }
            }
        }
        error?.let { Text(it, style = T.footnote, color = Theme.danger) }
        if (history.isNotEmpty()) {
            CardGroup("History") {
                history.take(30).forEachIndexed { i, move ->
                    if (i > 0) CardDivider()
                    WalletMoveRow(move)
                }
            }
        }
    }
    addressFor?.let { coin ->
        DzSheet(onDismiss = {
            addressFor = null
            scope.launch { load() }
        }, tall = false) {
            AddressSheet(coin, locked) {
                addressFor = null
                scope.launch { load() }
            }
        }
    }
    if (requestingChange) {
        DzSheet(onDismiss = { requestingChange = false }, tall = false) { WalletChangeSheet({ wallet = it }) { requestingChange = false } }
    }
    if (showConnect) {
        val close = {
            Wallets.stopWaiting()
            showConnect = false
            scope.launch { load() }
            Unit
        }
        DzSheet(onDismiss = close) { ConnectWalletSheet(wallet?.network, coins, close) }
    }
}

private fun sum(list: List<WalletMove>): Int = list.mapNotNull { it.eurCents }.sum()

@Composable
private fun WalletPill(text: String) {
    Text(text, style = T.caption.bold, color = Theme.onAccent, modifier = Modifier.background(Theme.onAccent.copy(alpha = 0.18f), CircleShape).padding(horizontal = 9.dp, vertical = 4.dp))
}

@Composable
private fun RowScope.TotalTile(title: String, cents: Int, sign: String, colour: Color, symbol: androidx.compose.ui.graphics.vector.ImageVector) {
    Column(
        Modifier.weight(1f).fillMaxHeight().background(Theme.card, RoundedCornerShape(16.dp)).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
            Icon(symbol, null, tint = Theme.accentInk, modifier = Modifier.size(14.dp))
            Text(title, style = T.caption.semibold, color = Theme.muted)
        }
        Text(if (cents == 0) Fmt.eur(0) else "$sign${Fmt.eur(cents)}", style = T.size(22).bold.digits.kern(-0.5f), color = if (cents == 0) Theme.muted else colour, maxLines = 1)
    }
}

// Under the button: what it takes to change your wallet, and how far that is.
@Composable
private fun ChangeStatus(wallet: WalletView?, locked: Boolean, onRequest: () -> Unit) {
    val request = wallet?.change?.request
    if (!locked) {
        // A server from before the lock says nothing at all, and has nothing to say here either.
        if (request?.status == "allowed") {
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                LabelRow(Sym.checkCircle, "Support said yes: you can change your wallet once.", T.footnote.medium, Theme.ok)
            }
        }
    } else if (request?.status == "open") {
        Column(Modifier.fillMaxWidth().background(Theme.soft, RoundedCornerShape(Theme.buttonRadius)).padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            LabelRow(Sym.clock, "Your request is with support", T.subheadline.semibold, Theme.ink, Theme.accentInk)
            Text("You’ll get a notification when it’s decided.", style = T.footnote, color = Theme.muted)
            request.message?.let { Text("“$it”", style = T.footnote, color = Theme.muted) }
        }
    } else {
        GhostButton("Request wallet change", height = 46.dp, onClick = onRequest, icon = { Icon(Sym.send, null, modifier = Modifier.size(18.dp)) })
        Text(
            if (request?.status == "declined") "Support didn’t allow your last request. You can ask again and explain more."
            else "Your wallet is locked, so someone who gets into your account can’t send your money elsewhere. Support can unlock it for one change.",
            style = T.footnote, color = Theme.faint, modifier = Modifier.padding(horizontal = 4.dp),
        )
    }
}

// One line of money: why, how much, which way, and when it clears.
@Composable
private fun WalletMoveRow(move: WalletMove) {
    val context = LocalContext.current
    val isOut = move.direction == "out"
    val title = when {
        move.direction == "in" && move.reason == "refund" -> "Refund"
        move.direction == "in" && move.reason == "half" -> "Half back: ride cancelled"
        move.direction == "in" && move.reason == "drive" -> "Pay for driving"
        move.direction == "in" && move.reason == "driveHalf" -> "Half for a cancelled drive"
        move.direction == "out" && move.reason == "half" -> "Half to your driver: ride cancelled"
        move.pending == true -> "Paying for your ride"
        else -> "Paid for your ride"
    }
    Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CoinBadge(move.coin, 34.dp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(title, style = T.subheadline.semibold, color = Theme.ink, modifier = Modifier.weight(1f))
                move.eurCents?.let { cents ->
                    Text("${if (isOut) "−" else "+"}${Fmt.eur(cents)}", style = T.subheadline.bold.digits, color = if (isOut) Theme.danger else Theme.ok)
                }
            }
            Text(move.to?.let { "Ride to $it" } ?: "A ride", style = T.caption, color = Theme.faint, maxLines = 1)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(Fmt.amount(move.amount, Fmt.coinSymbol(move.coin)), style = T.caption.digits, color = Theme.muted, maxLines = 1, modifier = Modifier.weight(1f))
                val explorer = move.explorer
                val at = move.at
                val clears = move.`when`
                when {
                    move.pending == true -> when {
                        move.needsUsdcAccount == true -> PendingPill("Needs a USDC account")
                        move.onHold == true -> PendingPill("Being checked")
                        move.settling == true -> PendingPill("On its way")
                        clears != null -> ClearTimer(clears)
                        else -> PendingPill(if (move.rideStatus == "scheduled") "Until your ride" else "Until the ride is done")
                    }
                    move.demo == true -> Text("Demo", style = T.caption2.semibold, color = Theme.faint)
                    explorer != null -> Text(at?.let { Fmt.dayTime(it) } ?: "On the chain", style = T.caption2.semibold, color = Theme.accentInk, modifier = Modifier.clickable { openUrl(context, explorer) })
                    at != null -> Text(Fmt.dayTime(at), style = T.caption2, color = Theme.faint)
                }
            }
        }
    }
}

// Orange: it hasn't happened yet.
@Composable
private fun PendingPill(text: String, timer: Boolean = false) {
    Row(
        Modifier.background(Theme.warnSoft, CircleShape).padding(horizontal = 8.dp, vertical = 3.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (timer) Icon(Sym.timer, null, tint = Theme.warn, modifier = Modifier.size(12.dp))
        Text(text, style = T.caption2.bold.digits, color = Theme.warn, maxLines = 1)
    }
}

// How long until money clears: hours, minutes and seconds, or days once it's that far off.
@Composable
private fun ClearTimer(until: Double) {
    val left = secondsUntil(until)
    if (left <= 0) {
        PendingPill("Any moment now")
    } else if (left >= 86_400) {
        PendingPill("${left / 86_400}d ${left % 86_400 / 3600}h", timer = true)
    } else {
        PendingPill(String.format(Locale.US, "%d:%02d:%02d", left / 3600, left % 3600 / 60, left % 60), timer = true)
    }
}

// Which wallet app an address came from.
@Composable
fun ViaPill(via: String) {
    Row(
        Modifier.background(Theme.accentSoft, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(3.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Sym.link, null, tint = Theme.accentInk, modifier = Modifier.size(11.dp))
        Text("via $via", style = T.caption2.semibold, color = Theme.accentInk)
    }
}

// An address only ever comes from a wallet, so it can't be mistyped. Changing it is connecting another wallet;
// removing it goes through support.
@Composable
private fun AddressSheet(coin: WalletCoin, locked: Boolean, close: () -> Unit) {
    val context = LocalContext.current
    var showConnect by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
            CoinBadge(coin.id, 44.dp)
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("${coin.symbol ?: ""} address", style = T.title3.bold, color = Theme.ink)
                coin.via?.let { ViaPill(it) }
            }
        }
        SelectionContainer {
            Text(coin.address ?: "", style = T.footnote.mono, color = Theme.ink, modifier = Modifier.fillMaxWidth().background(Theme.soft, RoundedCornerShape(Theme.buttonRadius)).padding(16.dp))
        }
        Text("Where your ${coin.symbol ?: "coins"} go. It came from your wallet, so it can’t be wrong.", style = T.footnote, color = Theme.muted)
        GhostButton("Change wallet", height = 46.dp, enabled = !locked, onClick = { showConnect = true }, icon = { Icon(Sym.sync, null, modifier = Modifier.size(18.dp)) })
        if (locked) Text("Locked: request a change on the Wallet screen.", style = T.footnote, color = Theme.faint, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text("To remove it, ", style = T.footnote, color = Theme.faint)
            Text("ask support", style = T.footnote, color = Theme.accentInk, modifier = Modifier.clickable { openUrl(context, "https://drivezzz.s3rver.nl/support") })
        }
    }
    if (showConnect) {
        val done = {
            Wallets.stopWaiting()
            showConnect = false
            close()
        }
        DzSheet(onDismiss = done) { ConnectWalletSheet(null, listOf(coin), done) }
    }
}

// Asking support to unlock your wallet for one change, with a message for whoever decides.
@Composable
private fun WalletChangeSheet(onSent: (WalletView) -> Unit, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Request wallet change", style = T.title3.bold, color = Theme.ink)
        Text("Tell support why you need another wallet. Once they say yes you can change it once, and then it locks again.", style = T.footnote, color = Theme.muted)
        DzField(message, { message = it }, "Why do you want to change it?", minLines = 4)
        error?.let { Text(it, style = T.footnote, color = Theme.danger) }
        PrimaryButton(if (sending) "Sending…" else "Send request", enabled = !sending, onClick = {
            sending = true
            scope.launch {
                try {
                    val view: WalletView = ApiClient.post("/api/wallet/change-request", mapOf("message" to message))
                    onSent(view)
                    close()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    error = e.shown
                }
                sending = false
            }
        })
    }
}

// Your wallet app shares its Solana address. Nothing can be typed or pasted here: no wallet, no address.
@Composable
fun ConnectWalletSheet(network: String?, initial: List<WalletCoin>, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var coins by remember { mutableStateOf(initial) }
    var error by remember { mutableStateOf<String?>(null) }
    var missingApp by remember { mutableStateOf<Wallets.App?>(null) }
    val notSaved = remember { mutableStateMapOf<String, String>() }
    val missing = coins.filter { it.address == null }
    val connected = coins.filter { it.address != null }

    fun connect(wallet: Wallets.App) {
        error = null
        missingApp = null
        scope.launch {
            try {
                val addresses = Wallets.connect(wallet, network)
                if (addresses.isEmpty()) {
                    error = "${wallet.name} didn’t share an address for any of our coins."
                    return@launch
                }
                for ((coin, address) in addresses.toSortedMap()) {
                    try {
                        val w: WalletView = ApiClient.post("/api/wallet/address", mapOf("coin" to coin, "address" to address, "via" to if (wallet.id == "other") "WalletConnect" else wallet.name))
                        coins = w.usedCoins
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        notSaved[coin] = e.shown
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = Wallets.problem(e)
                if (Wallets.isMissingApp(e)) missingApp = wallet
            }
        }
    }

    Screen("Connect a wallet", actions = { TextAction("Done", close) }) {
        Text("Your wallet app opens to approve this. If it stays there afterwards, come back here yourself. Your keys stay in your wallet.", style = T.subheadline, color = Theme.muted)
        if (Wallets.waitingFor != null) {
            WalletWaitingSections()
        } else {
            ListSection("Wallets") {
                Wallets.apps.forEachIndexed { i, wallet ->
                    if (i > 0) CardDivider(16.dp)
                    WalletAppRow(wallet) { connect(wallet) }
                }
            }
        }
        error?.let { Text(it, style = T.subheadline, color = Theme.danger) }
        missingApp?.let { app ->
            app.store?.let { store ->
                ListSection { ListRow(onClick = { openUrl(context, store) }) { Text("Get ${app.name} on Google Play", style = T.subheadline, color = Theme.accentInk) } }
            }
        }
        if (connected.isNotEmpty()) {
            ListSection("Connected") {
                connected.forEachIndexed { i, coin ->
                    if (i > 0) CardDivider(16.dp)
                    ListRow {
                        LabeledRow(coin.symbol ?: coin.id, trailing = {
                            LabelRow(Sym.check, Fmt.shortAddress(coin.address), T.footnote.mono, Theme.ok)
                        })
                    }
                }
            }
        }
        if (missing.isNotEmpty()) {
            ListSection("Still missing", "Addresses only come from your wallet, so they can’t be wrong. Connect a wallet that holds these coins to use them.") {
                missing.forEachIndexed { i, coin ->
                    if (i > 0) CardDivider(16.dp)
                    ListRow {
                        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(coin.name ?: coin.id, style = T.subheadline, color = Theme.ink)
                            notSaved[coin.id]?.let { Text(it, style = T.footnote, color = Theme.danger) }
                        }
                    }
                }
            }
        }
    }
}

// Waiting for a wallet app to answer: for connecting and for paying.
@Composable
fun WalletWaitingSections() {
    val context = LocalContext.current
    val waiting = Wallets.waitingFor ?: return
    ListSection {
        ListRow {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Spinner(size = 18.dp)
                Text("Waiting for $waiting. Approve it there, then come back.", style = T.subheadline, color = Theme.ink)
            }
        }
        CardDivider(16.dp)
        ListRow(onClick = { Wallets.stopWaiting() }) { Text("Stop", style = T.subheadline, color = Theme.danger) }
    }
    val link = Wallets.manualLink ?: return
    ListSection("Another wallet", "“Open a wallet app” lets your phone pick the app for WalletConnect links. For MetaMask, go back and pick it in the list: it only shares Solana that way.") {
        ListRow { Text("Scan this with your wallet’s WalletConnect scanner, or copy the link and paste it there.", style = T.footnote, color = Theme.muted) }
        Box(Modifier.fillMaxWidth().padding(vertical = 6.dp), contentAlignment = Alignment.Center) { QRCode(link, 190.dp) }
        CardDivider(16.dp)
        ListRow(onClick = {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("WalletConnect", link))
        }) { LabelRow(Sym.copy, "Copy the link", iconTint = Theme.accentInk) }
        CardDivider(16.dp)
        ListRow(onClick = { openUrl(context, link) }) { LabelRow(Sym.openApp, "Open a wallet app", iconTint = Theme.accentInk) }
    }
}

// A wallet app in its own colour, so the list reads at a glance.
@Composable
fun WalletAppRow(wallet: Wallets.App, action: () -> Unit) {
    val sharesOurCoins = wallet.kind is Wallets.Kind.Link || wallet.kind is Wallets.Kind.MetaMask
    Row(
        Modifier.fillMaxWidth().clickable(onClick = action).padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val tile = when (wallet.id) {
            "trust" -> hexColor(0x0500FF)
            "phantom" -> hexColor(0xAB9FF2)
            "solflare" -> hexColor(0xFC7227)
            "metamask" -> Theme.soft
            else -> Theme.ink
        }
        Box(Modifier.size(36.dp).background(tile, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
            when (wallet.id) {
                "trust" -> Icon(Sym.lockShield, null, tint = Color.White, modifier = Modifier.size(20.dp))
                "solflare" -> Icon(Sym.sun, null, tint = Color.White, modifier = Modifier.size(20.dp))
                "phantom" -> PhantomGhost()
                "metamask" -> MetaMaskFox()
                else -> Icon(Sym.qr, null, tint = Theme.card, modifier = Modifier.size(20.dp))
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(wallet.name, style = T.callout, color = Theme.ink)
            if (sharesOurCoins) Text("SOL and USDC", style = T.caption, color = Theme.faint)
        }
        Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(18.dp))
    }
}

// Phantom's ghost: a dome, three legs, two eyes cut out.
@Composable
private fun PhantomGhost() {
    Canvas(Modifier.size(width = 21.dp, height = 19.dp)) {
        val w = size.width
        val h = size.height
        val path = Path().apply {
            fillType = PathFillType.EvenOdd
            moveTo(0f, h)
            lineTo(0f, h * 0.48f)
            cubicTo(0f, -h * 0.14f, w, -h * 0.14f, w, h * 0.48f)
            lineTo(w, h)
            for (i in 2 downTo 0) {
                val left = w * i / 3
                quadraticTo(left + w / 6, h * 0.7f, left, h)
            }
            close()
            addOval(androidx.compose.ui.geometry.Rect(Offset(w * 0.3f, h * 0.3f), Size(w * 0.13f, h * 0.24f)))
            addOval(androidx.compose.ui.geometry.Rect(Offset(w * 0.57f, h * 0.3f), Size(w * 0.13f, h * 0.24f)))
        }
        drawPath(path, Color.White)
    }
}

// MetaMask's fox, from its own brand page (metamask.com/assets): flat polygons, back to front, as x, y pairs.
private val foxParts: List<Pair<Long, FloatArray>> = listOf(
    0xFA4B00L to floatArrayOf(111.57f, 134.75f, 86.34f, 149.85f, 68.79f, 149.85f, 43.56f, 134.75f, 10.16f, 144.72f, 0f, 110.36f, 10.16f, 72.22f, 0f, 39.97f, 10.16f, 0f, 62.35f, 31.24f, 92.78f, 31.24f, 144.97f, 0f, 155.13f, 39.97f, 144.97f, 72.22f, 155.13f, 110.36f, 144.97f, 144.72f),
    0x5C1600L to floatArrayOf(68.79f, 136.17f, 86.34f, 136.17f, 88.61f, 127.89f, 84.07f, 122.82f, 71.06f, 122.82f, 66.52f, 127.89f),
    0xC0C4CDL to floatArrayOf(86.34f, 136.17f, 68.79f, 136.17f, 68.79f, 149.85f, 86.34f, 149.85f),
    0x5C1600L to floatArrayOf(92.9f, 99.77f, 112.05f, 95.01f, 106.66f, 89.72f, 96.76f, 89.72f),
    0xE34807L to floatArrayOf(84.07f, 122.82f, 92.9f, 99.77f, 96.76f, 89.72f, 106.66f, 89.72f, 112.05f, 95.01f, 123.04f, 92.28f, 111.58f, 81.39f, 90.44f, 81.39f),
    0xE1E3EAL to floatArrayOf(88.61f, 127.89f, 111.57f, 134.76f, 86.34f, 149.85f, 86.34f, 136.17f),
    0xFF5C16L to floatArrayOf(111.57f, 134.75f, 111.57f, 110.35f, 88.61f, 127.89f),
    0xFF8552L to floatArrayOf(88.61f, 127.89f, 111.57f, 110.35f, 155.13f, 110.36f, 144.97f, 72.22f, 123.12f, 72.22f, 123.04f, 92.28f, 92.9f, 99.77f, 84.07f, 122.82f),
    0xFF5C16L to floatArrayOf(111.58f, 81.39f, 90.44f, 81.39f, 94.86f, 52.72f, 123.12f, 72.22f, 123.04f, 92.28f),
    0x5C1600L to floatArrayOf(123.12f, 72.22f, 144.97f, 72.22f, 155.13f, 39.97f, 144.97f, 0f, 94.86f, 52.72f),
    0xFF5C16L to floatArrayOf(94.86f, 52.72f, 144.97f, 0f, 92.78f, 31.24f),
    0xE34807L to floatArrayOf(144.97f, 144.72f, 155.13f, 110.36f, 111.57f, 110.35f, 111.57f, 134.75f),
    0x5C1600L to floatArrayOf(62.23f, 99.77f, 43.08f, 95.01f, 48.47f, 89.72f, 58.37f, 89.72f),
    0xE34807L to floatArrayOf(71.06f, 122.82f, 62.23f, 99.77f, 58.37f, 89.72f, 48.47f, 89.72f, 43.08f, 95.01f, 32.09f, 92.28f, 43.55f, 81.39f, 64.69f, 81.39f),
    0xE1E3EAL to floatArrayOf(66.52f, 127.89f, 43.56f, 134.76f, 68.79f, 149.85f, 68.79f, 136.17f),
    0xFF5C16L to floatArrayOf(43.56f, 134.75f, 43.56f, 110.35f, 66.52f, 127.89f),
    0xFF8552L to floatArrayOf(66.52f, 127.89f, 43.56f, 110.35f, 0f, 110.36f, 10.16f, 72.22f, 32.01f, 72.22f, 32.09f, 92.28f, 62.23f, 99.77f, 71.06f, 122.82f),
    0xFF5C16L to floatArrayOf(43.55f, 81.39f, 64.69f, 81.39f, 60.27f, 52.72f, 32.01f, 72.22f, 32.09f, 92.28f),
    0x5C1600L to floatArrayOf(32.01f, 72.22f, 10.16f, 72.22f, 0f, 39.97f, 10.16f, 0f, 60.27f, 52.72f),
    0xFF5C16L to floatArrayOf(60.27f, 52.72f, 10.16f, 0f, 62.35f, 31.24f),
    0xE34807L to floatArrayOf(10.16f, 144.72f, 0f, 110.36f, 43.56f, 110.35f, 43.56f, 134.75f),
    0xFF8552L to floatArrayOf(84.07f, 122.82f, 94.86f, 52.72f, 92.78f, 31.24f, 62.35f, 31.24f, 60.27f, 52.72f, 71.06f, 122.82f),
)

@Composable
private fun MetaMaskFox() {
    Canvas(Modifier.size(width = 27.dp, height = 26.dp)) {
        val scale = min(size.width / 155.13f, size.height / 149.85f)
        for ((colour, points) in foxParts) {
            val path = Path()
            var i = 0
            while (i < points.size) {
                val x = points[i] * scale
                val y = points[i + 1] * scale
                if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                i += 2
            }
            path.close()
            drawPath(path, hexColor(colour))
        }
    }
}
