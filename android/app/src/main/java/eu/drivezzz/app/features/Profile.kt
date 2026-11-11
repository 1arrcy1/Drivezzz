package eu.drivezzz.app.features

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.AppAccent
import eu.drivezzz.app.core.AppAppearance
import eu.drivezzz.app.core.AppMode
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.BlockedPerson
import eu.drivezzz.app.core.BlocksResponse
import eu.drivezzz.app.core.Fmt
import eu.drivezzz.app.core.ServerConfig
import eu.drivezzz.app.core.attempt
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.launch

// You and your account: riding or driving, your wallet, how the app looks.
@Composable
fun ProfileScreen() {
    val app = AppState
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var editingName by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    var showLogin by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var confirmLogout by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var becomingDriver by remember { mutableStateOf(false) }

    fun setMode(new: AppMode) {
        error = null
        if (new == app.mode || app.modeLock != null) return
        if (new == AppMode.Rider) {
            if (app.driveMode) app.stopDriving()
            // You stay on Profile: only what's around it changes.
            app.riderTab = AppState.PROFILE_TAB
            app.mode = AppMode.Rider
            return
        }
        // You stay on Profile here too, a new driver as well. Set first, so the Driving tab doesn't flash by.
        app.driverTab = AppState.PROFILE_TAB
        if (app.user?.isDriver == true) {
            app.mode = AppMode.Driver
        } else {
            becomingDriver = true
            scope.launch {
                try {
                    app.becomeDriver()
                } catch (e: Exception) {
                    error = e.shown
                }
                becomingDriver = false
            }
        }
    }

    NavStack {
        val nav = LocalNav.current
        Screen("Profile", large = true, spacing = 22.dp) {
            // You, in your colour, with the switch between riding and driving.
            HeroCard {
                Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(
                            Modifier.size(72.dp).border(3.dp, Theme.onAccent.copy(alpha = 0.35f), CircleShape).padding(4.dp).background(Color.White, CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text((app.user?.name ?: "D").take(1).uppercase(), style = T.size(28).bold, color = Theme.accentOnWhite)
                        }
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Row(
                                Modifier.clickable {
                                    name = app.user?.name ?: ""
                                    editingName = true
                                }.semantics { contentDescription = "Change your name" },
                                horizontalArrangement = Arrangement.spacedBy(6.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Text(app.user?.name ?: "", style = T.title2.bold, color = Theme.onAccent, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                                if (app.driver?.verified == true) VerifiedMark(18.dp, rim = true)
                                Box(Modifier.size(21.dp).background(Theme.onAccent.copy(alpha = 0.85f), CircleShape), contentAlignment = Alignment.Center) {
                                    Icon(Sym.pencil, null, tint = Theme.accent, modifier = Modifier.size(13.dp))
                                }
                            }
                            Text(app.user?.email ?: "Automatic account · no email yet", style = T.footnote, color = Theme.onAccent.copy(alpha = 0.85f), maxLines = 1)
                        }
                    }
                    Row(
                        Modifier.fillMaxWidth().background(Theme.onAccent.copy(alpha = 0.16f), CircleShape).padding(4.dp),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        val locked = app.modeLock != null || becomingDriver
                        ModeButton(app.mode == AppMode.Rider, "Riding", Sym.pickup, false, locked) { setMode(AppMode.Rider) }
                        ModeButton(app.mode == AppMode.Driver, "Driving", Sym.steering, becomingDriver, locked) { setMode(AppMode.Driver) }
                    }
                }
            }
            app.modeLock?.let { NoteBox(Sym.lock, Theme.accentInk, Theme.accentSoft, it) }
            // Wallet and standing, the two things people come here for.
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Shortcut(Sym.wallet, "Wallet", "Coins and addresses", onClick = { nav?.push { WalletScreen() } })
                val n = app.standing?.strikes ?: 0
                Shortcut(
                    if (n == 0) Sym.checkShield else Sym.warnShield, "Standing",
                    if (n == 0) "No strikes" else "$n of ${app.standing?.maxStrikes ?: 4} strikes",
                    if (n == 0) Theme.ok else Theme.warn, if (n == 0) Theme.okSoft else Theme.warnSoft,
                ) { nav?.push { StandingScreen() } }
            }
            // Automatic goes dark when it's dark outside; the other two stay as they are.
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Appearance", style = T.title3.bold.kern(-0.3f), color = Theme.ink, modifier = Modifier.padding(horizontal = 4.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    AppAppearance.entries.forEach { choice ->
                        val on = app.appearance == choice
                        val shape = RoundedCornerShape(22.dp)
                        Column(
                            Modifier
                                .weight(1f)
                                .lifted(0.45f, 22.dp)
                                .background(Theme.card, shape)
                                .border(2.5.dp, if (on) Theme.accent else Color.Transparent, shape)
                                .clip(shape)
                                .clickable { app.appearance = choice }
                                .padding(vertical = 12.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Icon(
                                when (choice) {
                                    AppAppearance.Auto -> Sym.sunHorizon
                                    AppAppearance.Light -> Sym.sun
                                    AppAppearance.Dark -> Sym.moon
                                },
                                choice.shownName,
                                tint = if (on) Theme.accentInk else Theme.muted,
                                modifier = Modifier.size(28.dp),
                            )
                            Text(choice.shownName, style = if (on) T.footnote.bold else T.footnote.medium, color = if (on) Theme.ink else Theme.muted)
                        }
                    }
                }
                if (app.appearance == AppAppearance.Auto) {
                    Text("Goes dark when it’s dark outside where you are.", style = T.footnote, color = Theme.faint, modifier = Modifier.padding(horizontal = 4.dp))
                }
                Colours()
            }
            // Account
            Column(verticalArrangement = Arrangement.spacedBy(18.dp)) {
                // A car in the Netherlands needs these before it goes online (DriverChecksSheet), and a blue check comes with them.
                // A motor or scooter needs none of it, so someone with only those isn't asked.
                val verified = app.driver?.verified == true
                if (app.user?.isDriver == true && (verified || app.driver?.cars?.any { it.kind == "car" } == true)) {
                    CardGroup("Driving") {
                        CardRow(
                            Sym.seal, "Driving in the Netherlands",
                            app.checksAttention ?: if (verified) "You’re verified" else "Your ID, chauffeurskaart, taxi permit and KvK",
                            onClick = { app.checksOpen = true },
                            trailing = if (verified) ({ VerifiedMark(20.dp) }) else null,
                        )
                    }
                }
                CardGroup("Account") {
                    CardRow(Sym.block, "Blocked people", onClick = { nav?.push { BlockedPeopleScreen() } })
                    if (app.user?.hasLogin != true) {
                        CardDivider()
                        CardRow(Sym.key, "Create a login", "Use your account on another phone", onClick = { showLogin = true })
                    }
                }
                CardGroup("Help") {
                    CardRow(Sym.help, "Support", onClick = { openUrl(context, "https://drivezzz.s3rver.nl/support") })
                    CardDivider()
                    CardRow(Sym.doc, "Terms", onClick = { openUrl(context, "https://drivezzz.s3rver.nl/terms") })
                    CardDivider()
                    CardRow(Sym.signature, "Licence agreement", onClick = { openUrl(context, "https://drivezzz.s3rver.nl/eula") })
                    CardDivider()
                    CardRow(Sym.lockShield, "Privacy", onClick = { openUrl(context, "https://drivezzz.s3rver.nl/privacy") })
                    CardDivider()
                    CardRow(Sym.code, "Open source licences", onClick = { nav?.push { LicencesScreen() } })
                }
                CardGroup {
                    // Without an email there's nothing to log back in with, so an account like that can only be deleted.
                    if (app.user?.hasLogin == true) {
                        CardRow(Sym.logout, "Log out", tint = Theme.danger, background = Theme.dangerSoft, chevron = false, onClick = { confirmLogout = true })
                        CardDivider()
                    }
                    CardRow(Sym.trash, "Delete account", tint = Theme.danger, background = Theme.dangerSoft, chevron = false, onClick = { confirmDelete = true })
                }
            }
            error?.let { Text(it, style = T.footnote, color = Theme.danger) }
            SelectionContainer(Modifier.fillMaxWidth()) {
                Text("Drivezzz · ${app.user?.id ?: ""}${ServerConfig.shownServer}", style = T.caption.mono, color = Theme.faint, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
            }
        }
    }
    if (showLogin) DzSheet(onDismiss = { showLogin = false }, background = Theme.card) { CreateLoginScreen { showLogin = false } }
    if (editingName) {
        DzAlert(
            "Your name",
            "Your user ID stays ${app.user?.id ?: "the same"}.",
            confirm = "Save",
            onDismiss = { editingName = false },
            onConfirm = {
                editingName = false
                scope.launch {
                    try {
                        app.rename(name.trim())
                    } catch (e: Exception) {
                        error = e.shown
                    }
                }
            },
        ) {
            // With the cursor at the end, ready to go on typing.
            var field by remember { mutableStateOf(TextFieldValue(name, TextRange(name.length))) }
            Box(Modifier.fillMaxWidth().background(Theme.soft, RoundedCornerShape(Theme.buttonRadius)).padding(14.dp)) {
                BasicTextField(
                    value = field,
                    onValueChange = {
                        field = it.copy(text = it.text.take(30))
                        name = field.text
                    },
                    singleLine = true,
                    textStyle = T.callout.copy(color = Theme.ink),
                    cursorBrush = SolidColor(Theme.accentInk),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
    if (confirmLogout) {
        AskDialog(
            "Log out?", "You can log back in with your email and password.",
            listOf(Choice("Log out", destructive = true) { scope.launch { app.logout() } }),
            onDismiss = { confirmLogout = false },
        )
    }
    if (confirmDelete) {
        AskDialog(
            "Delete your account?", "This can’t be undone.",
            listOf(
                Choice("Delete account", destructive = true) {
                    error = null
                    scope.launch {
                        try {
                            app.deleteAccount()
                        } catch (e: Exception) {
                            error = e.shown
                        }
                    }
                },
            ),
            onDismiss = { confirmDelete = false },
        )
    }
}

@Composable
private fun RowScope.ModeButton(on: Boolean, title: String, symbol: ImageVector, working: Boolean, locked: Boolean, onClick: () -> Unit) {
    val ink = if (on) Theme.accentOnWhite else Theme.onAccent
    Row(
        Modifier
            .weight(1f)
            .heightIn(min = 40.dp)
            .background(if (on) Color.White else Color.Transparent, CircleShape)
            .clip(CircleShape)
            .clickable(enabled = !locked, onClick = onClick)
            .then(if (locked) Modifier else Modifier),
        horizontalArrangement = Arrangement.spacedBy(7.dp, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Becoming a driver asks the server first: show that the tap landed.
        if (working) Spinner(Theme.onAccent, 16.dp) else Icon(symbol, null, tint = ink, modifier = Modifier.size(18.dp))
        Text(title, style = T.subheadline.bold, color = ink)
    }
}

@Composable
private fun RowScope.Shortcut(symbol: ImageVector, title: String, detail: String, tint: Color = Theme.accentInk, background: Color = Theme.accentSoft, onClick: () -> Unit) {
    Column(
        Modifier.weight(1f).lifted(0.45f, 22.dp).background(Theme.card, RoundedCornerShape(22.dp)).clip(RoundedCornerShape(22.dp)).clickable(onClick = onClick).padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        IconTile(symbol, tint, background)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = T.headline, color = Theme.ink)
            Text(detail, style = T.caption, color = Theme.faint, maxLines = 1)
        }
    }
}

// Blue, red or yellow, and the whole app follows. Set once and left alone, so it stays out of the way until it's asked for.
@Composable
private fun Colours() {
    val app = AppState
    Column(Modifier.padding(top = 2.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Theme.soft)) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { app.coloursOpen = !app.coloursOpen }.padding(horizontal = 14.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("Colour", style = T.subheadline.medium, color = Theme.ink, modifier = Modifier.weight(1f))
            Box(Modifier.size(14.dp).background(app.accent.color, CircleShape))
            Text(app.accent.shownName, style = T.subheadline, color = Theme.muted)
            Icon(if (app.coloursOpen) Sym.chevronUp else Sym.chevronDown, null, tint = Theme.faint, modifier = Modifier.size(18.dp))
        }
        if (app.coloursOpen) {
            Row(Modifier.fillMaxWidth().padding(bottom = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AppAccent.entries.forEach { choice ->
                    val on = app.accent == choice
                    Column(
                        Modifier.weight(1f).heightIn(min = 44.dp).clickable { app.accent = choice }.semantics { contentDescription = choice.shownName },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Box(Modifier.size(34.dp).background(choice.color, CircleShape), contentAlignment = Alignment.Center) {
                            if (on) Icon(Sym.check, null, tint = choice.onColor, modifier = Modifier.size(16.dp))
                        }
                        Text(choice.shownName, style = if (on) T.caption.semibold else T.caption, color = if (on) Theme.ink else Theme.muted)
                    }
                }
            }
        }
    }
}

@Composable
fun BlockedPeopleScreen() {
    val scope = rememberCoroutineScope()
    var people by remember { mutableStateOf<List<BlockedPerson>>(emptyList()) }
    var loaded by remember { mutableStateOf(false) }
    suspend fun load() {
        attempt { ApiClient.get<BlocksResponse>("/api/blocks") }?.let { people = it.blocks ?: emptyList() }
        loaded = true
    }
    LaunchedEffect(Unit) { load() }
    Screen("Blocked people") {
        if (people.isEmpty() && loaded) Text("Nobody. You can block someone from their page or a ride.", style = T.subheadline, color = Theme.muted)
        if (people.isNotEmpty()) {
            ListSection {
                people.forEachIndexed { i, person ->
                    if (i > 0) CardDivider(16.dp)
                    ListRow {
                        LabeledRow(person.name ?: person.id, trailing = {
                            Text("Unblock", style = T.subheadline, color = Theme.accentInk, modifier = Modifier.clickable {
                                scope.launch {
                                    attempt { ApiClient.call("DELETE", "/api/blocks/${person.id}") }
                                    load()
                                }
                            })
                        })
                    }
                }
            }
        }
    }
}

@Composable
fun StandingScreen() {
    val app = AppState
    val most = app.standing?.maxStrikes ?: 3
    Screen("Account standing") {
        ListSection(footer = "Every strike is a one-week ban, also on this phone. $most strikes is a permanent ban.") {
            ListRow { LabeledRow("Strikes", "${app.standing?.strikes ?: 0} of $most") }
        }
        val list = app.standing?.strikeList
        if (!list.isNullOrEmpty()) {
            ListSection("Your strikes") {
                list.forEachIndexed { i, s ->
                    if (i > 0) CardDivider(16.dp)
                    ListRow {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(s.reason ?: "", style = T.subheadline, color = Theme.ink)
                            s.at?.let { Text(Fmt.dayTime(it), style = T.caption, color = Theme.faint) }
                        }
                    }
                }
            }
        }
    }
}
