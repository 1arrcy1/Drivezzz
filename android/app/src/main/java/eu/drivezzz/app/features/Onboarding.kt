package eu.drivezzz.app.features

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.ClickableText
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.Eula
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.Standing
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.ui.DzField
import eu.drivezzz.app.ui.DzSheet
import eu.drivezzz.app.ui.ErrorText
import eu.drivezzz.app.ui.GhostButton
import eu.drivezzz.app.ui.LabelRow
import eu.drivezzz.app.ui.MarkTile
import eu.drivezzz.app.ui.PrimaryButton
import eu.drivezzz.app.ui.ScreenTitle
import eu.drivezzz.app.ui.Screen
import eu.drivezzz.app.ui.Sym
import eu.drivezzz.app.ui.T
import eu.drivezzz.app.ui.TextAction
import eu.drivezzz.app.ui.Theme
import eu.drivezzz.app.ui.bold
import eu.drivezzz.app.ui.card
import eu.drivezzz.app.ui.drawZDashes
import eu.drivezzz.app.ui.drawZRoad
import eu.drivezzz.app.ui.digits
import eu.drivezzz.app.ui.kern
import eu.drivezzz.app.ui.medium
import eu.drivezzz.app.ui.mono
import eu.drivezzz.app.ui.pageWidth
import eu.drivezzz.app.ui.rememberDashPhase
import eu.drivezzz.app.ui.semibold
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

// The loading screen: the road drives.
@Composable
fun LoadingScreen() {
    val shown = remember { Animatable(0f) }
    LaunchedEffect(Unit) { shown.animateTo(1f, androidx.compose.animation.core.tween(350)) }
    val phase by rememberDashPhase(0.7f)
    val on = Theme.onAccent
    val dash = Theme.roadDash
    Box(Modifier.fillMaxSize().background(Theme.gradient), contentAlignment = Alignment.Center) {
        Column(
            Modifier.graphicsLayer {
                alpha = shown.value
                val s = 0.94f + 0.06f * shown.value
                scaleX = s
                scaleY = s
            },
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            Canvas(Modifier.size(170.dp)) {
                drawZRoad(on, 26.dp.toPx())
                drawZDashes(dash, 3.dp.toPx(), 8.dp.toPx(), 9.dp.toPx(), -17.dp.toPx() * phase)
            }
            Text("Drivezzz", style = T.size(38).bold.kern(-0.5f), color = on)
        }
    }
}

// The first screen: the biggest features, then Continue, which opens the EULA, or log in.
@Composable
fun IntroScreen() {
    val scope = rememberCoroutineScope()
    var showLogin by remember { mutableStateOf(false) }
    var showEula by remember { mutableStateOf(false) }
    var eula by remember { mutableStateOf<Eula?>(null) }
    // Fetched here so it's there as soon as the sheet opens.
    LaunchedEffect(Unit) { eula = attempt { ApiClient.get<Eula>("/api/eula") } }
    val features = listOf<Triple<ImageVector, String, String>>(
        Triple(Sym.euro, "Cheapest driver nearby", "Drivers set their own rates. The quote includes their way to you."),
        Triple(Sym.block, "Name your price", "Say what you’ll pay. A driver near you can claim it."),
        Triple(Sym.calendar, "Plan a ride", "Book up to a week ahead, at the best price of all planned drives."),
        Triple(Sym.checkShield, "Check the plate", "Check in once you’re in the car. Your route is followed by both phones."),
        Triple(Sym.coin, "Pay your way", "USDC or SOL from your own wallet, once a driver takes your ride: it waits in escrow until the ride is done. Or cash, in the car."),
        Triple(Sym.steering, "Drive when you want", "Set your price and get paid to your own wallet within 24 hours."),
    )
    Column(Modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(24.dp)) {
            IntroHero()
            Column(Modifier.pageWidth().padding(horizontal = 24.dp).padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                features.forEach { (icon, title, text) ->
                    Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                        Box(Modifier.size(44.dp).background(Theme.accentSoft, RoundedCornerShape(13.dp)), contentAlignment = Alignment.Center) {
                            Icon(icon, null, tint = Theme.accentInk, modifier = Modifier.size(22.dp))
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(title, style = T.headline, color = Theme.ink)
                            Text(text, style = T.subheadline, color = Theme.muted)
                        }
                    }
                }
            }
        }
        Column(
            Modifier.pageWidth().padding(horizontal = 24.dp, vertical = 12.dp).navigationBarsPadding(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            PrimaryButton("Continue", onClick = { showEula = true })
            Box(Modifier.heightIn(min = 36.dp).clickable { showLogin = true }, contentAlignment = Alignment.Center) {
                Text("I already have an account", style = T.subheadline.semibold, color = Theme.accentInk)
            }
        }
    }
    if (showLogin) DzSheet(onDismiss = { showLogin = false }, background = Theme.card) { LoginScreen { showLogin = false } }
    if (showEula) DzSheet(onDismiss = { showEula = false }) { EulaSheet(eula, scope) { showEula = false } }
}

// Your colour, the road from the logo large behind it, and what Drivezzz is in one line.
@Composable
private fun IntroHero() {
    val on = Theme.onAccent
    val shape = RoundedCornerShape(bottomStart = 32.dp, bottomEnd = 32.dp)
    Box(Modifier.fillMaxWidth().heightIn(min = 340.dp).clip(shape).background(Theme.accent)) {
        Canvas(Modifier.align(Alignment.TopEnd).offset(x = 130.dp, y = (-40).dp).size(400.dp)) {
            drawZRoad(on.copy(alpha = 0.1f), 64.dp.toPx())
        }
        Column(
            Modifier.align(Alignment.BottomStart).pageWidth().statusBarsPadding().padding(horizontal = 24.dp).padding(bottom = 30.dp),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Canvas(Modifier.size(44.dp)) { drawZRoad(on, 5.dp.toPx()) }
                Text("Drivezzz", style = T.size(24).bold.kern(-0.4f), color = on)
            }
            Text("Rides at the price drivers set themselves", style = T.size(36).bold.kern(-0.9f), color = on)
        }
    }
}

// After Continue: the ID is made. The name can be anything; the ID stays.
@Composable
fun NameScreen() {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var focused by remember { mutableStateOf(false) }
    fun start() {
        if (working) return
        working = true
        error = null
        scope.launch {
            try {
                AppState.finishName(name)
            } catch (e: Exception) {
                error = e.shown
            }
            working = false
        }
    }
    Column(Modifier.fillMaxSize().statusBarsPadding().imePadding().navigationBarsPadding().pageWidth()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp), verticalArrangement = Arrangement.spacedBy(22.dp)) {
            Spacer(Modifier.size(8.dp))
            MarkTile(44.dp)
            ScreenTitle("What’s your name?", "Drivers and riders see it. Keep the ID if you like; you can change this later.")
            Box(
                Modifier
                    .fillMaxWidth()
                    .background(Theme.soft, RoundedCornerShape(Theme.radius))
                    .border(2.dp, if (focused) Theme.accent else androidx.compose.ui.graphics.Color.Transparent, RoundedCornerShape(Theme.radius))
                    .padding(18.dp),
            ) {
                DzField(
                    value = name,
                    onChange = { name = it.take(30) },
                    placeholder = AppState.user?.id ?: "Your name",
                    style = T.title3.semibold,
                    filled = false,
                    modifier = Modifier.onFocusChanged { focused = it.isFocused },
                    keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Words, autoCorrectEnabled = false, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(onGo = { start() }),
                )
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Your user ID", style = T.subheadline, color = Theme.muted)
                Text(AppState.user?.id ?: "", style = T.subheadline.mono.semibold, color = Theme.ink)
            }
            Text("Your ID stays yours. Add an email and password in Profile to use your account on another phone.", style = T.footnote, color = Theme.faint)
        }
        Column(Modifier.padding(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            ErrorText(error)
            PrimaryButton("Start", working = working, onClick = { start() })
        }
    }
}

@Composable
fun LoginScreen(close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { TextAction("Close", close) }
        ScreenTitle("Log in", "With the email and password you added in Profile.")
        DzField(email, { email = it }, "Email", keyboard = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None))
        DzField(password, { password = it }, "Password", password = true)
        ErrorText(error)
        PrimaryButton(
            "Log in",
            enabled = email.isNotEmpty() && password.isNotEmpty(),
            working = working,
            onClick = {
                working = true
                error = null
                scope.launch {
                    try {
                        AppState.login(email.trim(), password.trim('\n'))
                        close()
                    } catch (e: Exception) {
                        error = e.shown
                    }
                    working = false
                }
            },
        )
    }
}

@Composable
fun CreateLoginScreen(close: () -> Unit) {
    val scope = rememberCoroutineScope()
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxSize().padding(24.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) { TextAction("Close", close) }
        ScreenTitle("Create a login", "Keeps your account and user ID, so you can use them on another phone.")
        DzField(email, { email = it }, "Email", keyboard = KeyboardOptions(keyboardType = KeyboardType.Email, autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None))
        DzField(password, { password = it }, "Password (at least 8 characters)", password = true)
        ErrorText(error)
        PrimaryButton(
            "Create login",
            enabled = email.isNotEmpty() && password.length >= 8,
            working = working,
            onClick = {
                working = true
                error = null
                scope.launch {
                    try {
                        AppState.register(email.trim(), password)
                        close()
                    } catch (e: Exception) {
                        error = e.shown
                    }
                    working = false
                }
            },
        )
    }
}

// Banned: why, for how long, and an appeal once per 24 hours, until a decision is made.
@Composable
fun BanScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf("") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    var checked by remember { mutableStateOf<String?>(null) }
    var nextCheck by remember { mutableStateOf<Long?>(null) }
    val ban = app.standing?.ban
    LaunchedEffect(Unit) {
        while (true) {
            app.refreshMe()
            delay(30_000)
        }
    }
    Column(
        Modifier.fillMaxSize().statusBarsPadding().imePadding().navigationBarsPadding().pageWidth().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Icon(Sym.blocked, null, tint = Theme.danger, modifier = Modifier.padding(top = 40.dp).size(44.dp))
        ScreenTitle(if (ban?.endsAt == null) "You’re banned" else "You’re banned for a week", ban?.reason)
        ban?.endsAt?.let { ends -> LabelRow(Sym.clock, "Until ${Fmt.dayTime(ends)}", T.subheadline.medium, Theme.ink) }
        val strikes = app.standing?.strikes ?: 0
        if (strikes > 0) {
            val most = app.standing?.maxStrikes ?: 3
            Text("$strikes of $most strikes. At $most, the ban is permanent.", style = T.footnote, color = Theme.muted)
        }
        // No way out but the appeal: a ban stays on the phone, whichever account or install asks.
        if (ban?.decided == true) {
            Column(Modifier.fillMaxWidth().card(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("A decision was made", style = T.headline, color = Theme.ink)
                ban.answer?.let { Text(it, style = T.subheadline, color = Theme.muted) }
                Text("You can’t appeal again from the app.", style = T.footnote, color = Theme.faint)
            }
        } else {
            Column(Modifier.fillMaxWidth().card(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Appeal", style = T.headline, color = Theme.ink)
                ban?.appeals?.forEach { appeal ->
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(appeal.message ?: "", style = T.subheadline, color = Theme.ink)
                        appeal.at?.let { Text("Sent ${Fmt.dayTime(it)}", style = T.caption, color = Theme.faint) }
                    }
                }
                if (ban?.canAppeal == true) {
                    DzField(message, { message = it }, "Tell us what happened", minLines = 4)
                    ErrorText(error)
                    PrimaryButton(
                        "Send appeal",
                        enabled = message.trim().length >= 5,
                        working = working,
                        onClick = {
                            working = true
                            error = null
                            scope.launch {
                                try {
                                    val s: Standing = ApiClient.post("/api/appeals", mapOf("message" to message))
                                    app.standing = s
                                    message = ""
                                } catch (e: Exception) {
                                    error = e.shown
                                }
                                working = false
                            }
                        },
                    )
                    Text("One appeal per 24 hours.", style = T.footnote, color = Theme.faint)
                } else {
                    ban?.nextAppealAt?.let { next ->
                        Text("We have your appeal. You can send another after ${Fmt.dayTime(next)}.", style = T.footnote, color = Theme.muted)
                    }
                }
            }
        }
        // Once every half a minute, like the check that runs by itself: asking more often can't change the answer any sooner.
        val now = eu.drivezzz.app.ui.tickingNow()
        val wait = nextCheck?.let { ((it - now + 999) / 1000).toInt() } ?: 0
        GhostButton(
            if (wait > 0) "Check again in ${wait}s" else "Check again",
            enabled = !checking && wait <= 0,
            working = checking,
            onClick = {
                checking = true
                scope.launch {
                    try {
                        app.checkStanding()
                        checked = "Still banned. Checked at ${Fmt.time(System.currentTimeMillis().toDouble())}."
                    } catch (e: Exception) {
                        checked = e.shown
                    }
                    checking = false
                    nextCheck = System.currentTimeMillis() + 30_000
                }
            },
        )
        checked?.let { Text(it, style = T.footnote, color = Theme.muted) }
    }
}
