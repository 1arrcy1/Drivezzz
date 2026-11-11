package eu.drivezzz.app.features.checks

import android.view.HapticFeedbackConstants
import androidx.compose.ui.platform.LocalView
import androidx.compose.animation.animateColorAsState
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.BuildConfig
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.ApiError
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.ui.CardDivider
import eu.drivezzz.app.ui.CardGroup
import eu.drivezzz.app.ui.CardRow
import eu.drivezzz.app.ui.DzField
import eu.drivezzz.app.ui.DzSheet
import eu.drivezzz.app.ui.DzSwitch
import eu.drivezzz.app.ui.ErrorText
import eu.drivezzz.app.ui.GhostButton
import eu.drivezzz.app.ui.HeroCard
import eu.drivezzz.app.ui.IconTile
import eu.drivezzz.app.ui.LocalNav
import eu.drivezzz.app.ui.NavStack
import eu.drivezzz.app.ui.NoteBox
import eu.drivezzz.app.ui.PrimaryButton
import eu.drivezzz.app.ui.Screen
import eu.drivezzz.app.ui.Spinner
import eu.drivezzz.app.ui.StatusPill
import eu.drivezzz.app.ui.Sym
import eu.drivezzz.app.ui.T
import eu.drivezzz.app.ui.Theme
import eu.drivezzz.app.ui.bold
import eu.drivezzz.app.ui.card
import eu.drivezzz.app.ui.mono
import eu.drivezzz.app.ui.openSettings
import eu.drivezzz.app.ui.openUrl
import eu.drivezzz.app.ui.semibold
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import java.security.MessageDigest
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlin.math.roundToLong

// Driving in the Netherlands: what a driver hands in before a car can go online there (server/src/checks.js,
// docs/driver-checks-nl.md), as DriverChecksView.swift. It opens by itself when going online needs it, and from Profile. Four things
// to hand in, checked automatically: approved by itself when everything checks out, and whatever can't be confirmed lands on the
// admin panel. After that the driver is verified, with a blue check, and can go online. A motor or scooter doesn't need it: the taxi
// law only covers cars. Consent isn't one of the four: its page comes up once, before the first of them.
// What the iPhone signs with App Attest is signed here with Android's Key Attestation (AppAttest.kt). Where this phone can't (an
// emulator, an unlocked bootloader) nothing is signed, and a person looks at it (`signedByApp` in checks.js).
private enum class ChecksStep { Id, Chauffeurskaart, Permit, Kvk }

private const val PRIVACY = "https://drivezzz.s3rver.nl/privacy#checks"

@Composable
fun DriverChecksSheet(close: () -> Unit) {
    NavStack { ChecksHome(close) }
}

@Composable
private fun ChecksHome(close: () -> Unit) {
    val app = AppState
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var checks by remember { mutableStateOf<DriverChecks?>(null) }
    var loadFailed by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var working by remember { mutableStateOf(false) }

    suspend fun load() {
        loadFailed = null
        try {
            checks = ApiClient.get<ChecksResponse>("/api/checks").checks
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            loadFailed = if (e.status == 404) "This server doesn’t do these checks yet." else e.message
        }
    }
    // Again whenever the sync says the checks changed (a person decided while this was open). As DriverChecksView.swift.
    LaunchedEffect(app.driving.checks) { load() }

    // Something a person has to look at goes to them once everything is in (Pieter: "when everything has been filled"), so until
    // then it's only sent; and once a person approved, it's done.
    fun shown(item: String?): String? {
        if (item != "waiting") return item
        return when (checks?.status) {
            "review" -> "waiting"
            "approved" -> "done"
            else -> "sent"
        }
    }
    // Null is still loading: a question that failed mustn't look like one. A photo that couldn't be read is to send again.
    fun state(key: String): String? =
        if (checks?.retake?.contains(key) == true) "again" else shown(checks?.item(key)) ?: if (loadFailed == null) null else "unknown"
    val idState: String? = checks?.let { c ->
        val id = c.item("id")
        val face = c.item("face")
        when {
            id == "expired" -> "expired"
            id == "missing" || face == "missing" -> "missing"
            else -> shown(if (id == "waiting" || face == "waiting") "waiting" else "done")
        }
    } ?: if (loadFailed == null) null else "unknown"

    fun done(new: DriverChecks?) {
        if (new != null) checks = new
        nav?.popToRoot()
        scope.launch { app.loadDriver() }
    }

    @Composable
    fun StepScreen(step: ChecksStep) {
        when (step) {
            ChecksStep.Id -> IdStep { done(it) }
            ChecksStep.Chauffeurskaart -> DocumentStep("chauffeurskaart", checks?.chauffeurskaart) { done(it) }
            ChecksStep.Permit -> DocumentStep("permit", checks?.permit) { done(it) }
            ChecksStep.Kvk -> KvkStep(checks?.kvk?.number) { done(it) }
        }
    }

    // Having agreed, on to what they tapped.
    fun open(step: ChecksStep) {
        val n = nav ?: return
        if (checks?.item("consent") == "done") {
            n.push { StepScreen(step) }
        } else {
            n.push {
                ConsentStep { new ->
                    if (new != null) checks = new
                    n.pop()
                    n.push { StepScreen(step) }
                }
            }
        }
    }

    val c = checks
    val activeVehicle = c?.vehicles?.firstOrNull { it.id == app.driver?.activeCarId }
    val canDrive = c?.status == "approved" && c.verified == true && app.driver?.online != true && (activeVehicle?.ok == true || c.fake == true)

    Screen(
        "Driving in the Netherlands",
        close = close,
        bottom = if (canDrive) ({
            PrimaryButton("Go online", working = working, onClick = {
                working = true
                scope.launch {
                    val problem = app.goOnline()
                    working = false
                    if (problem != null) error = problem else if (app.driveMode) close()
                }
            })
        }) else null,
    ) {
        val failed = loadFailed
        if (failed != null) {
            NoteBox(Sym.warning, Theme.warn, Theme.warnSoft, "Your checks couldn’t be loaded. $failed")
            GhostButton("Try again", onClick = { scope.launch { load() } })
        } else {
            StatusCard(c)
        }
        // Until approved: what waits for review and what to send again, in the server's words, and never why (Pieter, 8 November
        // 2026). Once approved, every row shows done instead. As DriverChecksView.swift.
        val open = c?.open.orEmpty()
        if (c?.status != "approved" && open.isNotEmpty()) {
            CardGroup("Still open") {
                open.forEachIndexed { i, point ->
                    if (i > 0) CardDivider()
                    Row(Modifier.fillMaxWidth().padding(14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Icon(Sym.alert, null, tint = Theme.warn, modifier = Modifier.size(18.dp))
                        Text(point, style = T.subheadline, color = Theme.ink)
                    }
                }
            }
        }
        // Done is done: a check instead of the arrow, and nothing to send over it (Pieter, 8 November 2026). Open again only for what
        // runs out within 30 days (`renew`), and after a decline, when anything may be sent again. What a person asks for again is
        // missing, so it's open anyway. As DriverChecksView.swift.
        fun locked(key: String, state: String?) = state == "done" && c?.status != "declined" && key !in c?.renew.orEmpty()
        // A done row that runs out within 30 days says until when instead of done (Pieter, 8 November 2026: "Done" comes with the green check).
        fun endsSoon(key: String, state: String?, expires: String?) = if (state == "done" && !locked(key, state) && c?.status != "declined") expires else null
        CardGroup("What we check", "These are checked automatically. If something can’t be confirmed, a person looks at it once you’ve sent all four. Then you’re verified, with a blue check on your profile, and you can go online as a taxi driver.") {
            CheckRow(Sym.idCard, "Your ID and a selfie", idState, c != null, locked("id", idState), endsSoon("id", idState, c?.id?.expires)) { open(ChecksStep.Id) }
            CardDivider()
            CheckRow(Sym.creditCard, "Chauffeurskaart", state("chauffeurskaart"), c != null, locked("chauffeurskaart", state("chauffeurskaart")), endsSoon("chauffeurskaart", state("chauffeurskaart"), c?.chauffeurskaart?.expires)) { open(ChecksStep.Chauffeurskaart) }
            CardDivider()
            CheckRow(Sym.doc, "Taxi permit (Kiwa)", state("permit"), c != null, locked("permit", state("permit")), endsSoon("permit", state("permit"), c?.permit?.expires)) { open(ChecksStep.Permit) }
            CardDivider()
            CheckRow(Sym.business, "KvK number", state("kvk"), c != null, locked("kvk", state("kvk"))) { open(ChecksStep.Kvk) }
        }
        if (c != null) Vehicles(c)
        ErrorText(error)
        Text("Your face is compared on this phone and never sent. We never read your BSN or address. Photos of your documents are deleted 30 days after the decision.", style = T.caption, color = Theme.faint)
        Text("How we handle your data", style = T.footnote.semibold, color = Theme.accentInk, modifier = Modifier.clickable { openUrl(context, PRIVACY) })
    }
}

@Composable
private fun StatusCard(c: DriverChecks?) {
    when {
        c?.status == "approved" && c.verified == true ->
            NoteBox(Sym.seal, Theme.verified, Theme.verifiedSoft, "You’re verified: you can go online as a taxi driver in the Netherlands. Riders see your blue check.")
        c?.status == "approved" -> NoteBox(Sym.alert, Theme.warn, Theme.warnSoft, "Something is missing or has run out. Send it below to keep driving.")
        c?.status == "review" -> NoteBox(Sym.clock, Theme.warn, Theme.warnSoft, "A person is checking your documents, usually within a day. You’ll get a notification.")
        c?.status == "declined" -> NoteBox(Sym.cancel, Theme.danger, Theme.dangerSoft, "Not approved${c.note?.let { ": $it" } ?: "."} Fix it below and send it again.")
        // A person asked for one thing again (the panel's "Ask again for…"): not the first-time card.
        c?.status == "started" && c.againWhat != null ->
            NoteBox(Sym.refresh, Theme.warn, Theme.warnSoft, "A person asked you to send ${c.againWhat} again${c.note?.let { ": $it" } ?: "."}")
        else -> HeroCard {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(Sym.checkShield, null, tint = Theme.onAccent, modifier = Modifier.size(32.dp))
                Text("Before you drive a car", style = T.title2.bold, color = Theme.onAccent)
                Text(
                    "In the Netherlands a taxi needs a licensed driver and a registered car. It takes about 10 minutes: have your passport or ID card, chauffeurskaart, taxi permit and KvK number at hand.",
                    style = T.subheadline, color = Theme.onAccent.copy(alpha = 0.9f),
                )
            }
        }
    }
}

@Composable
// "Done" always comes with the green check; a done row that runs out soon says until when, in orange, and opens to send the new one.
private fun CheckRow(symbol: ImageVector, title: String, state: String?, enabled: Boolean, done: Boolean, endsSoon: String? = null, onClick: () -> Unit) {
    CardRow(symbol, title, chevron = !done, onClick = if (enabled && !done) onClick else null, trailing = {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            if (endsSoon != null) {
                StatusPill("Ends ${ChecksDate.showShort(endsSoon)}", Theme.warn, Theme.warnSoft)
            } else {
                ChecksPill(state)
                if (state == "done") Icon(Sym.checkCircle, null, tint = Theme.ok, modifier = Modifier.size(22.dp))
            }
        }
    })
}

// Missing, sent (a person looks once everything is in), waiting for review, to send again, expired or done.
@Composable
fun ChecksPill(state: String?) {
    when (state) {
        "done" -> StatusPill("Done", Theme.ok, Theme.okSoft)
        "sent" -> StatusPill("Sent", Theme.ok, Theme.okSoft)
        "waiting" -> StatusPill("In review", Theme.warn, Theme.warnSoft)
        "again" -> StatusPill("Send again", Theme.warn, Theme.warnSoft)
        "expired" -> StatusPill("Expired", Theme.danger, Theme.dangerSoft)
        "unknown" -> Text("–", style = T.subheadline, color = Theme.faint)
        null -> Spinner(size = 18.dp)
        else -> StatusPill("To do", Theme.muted, Theme.soft)
    }
}

@Composable
private fun Vehicles(c: DriverChecks) {
    val app = AppState
    val cars = c.vehicles ?: emptyList()
    CardGroup("Your car", "Only a car registered as a taxi at the RDW (blue plates), insured and through its APK can drive in the Netherlands. A motor or scooter doesn’t need any of this.") {
        if (cars.isEmpty()) Text("Add a car on My page.", style = T.subheadline, color = Theme.muted, modifier = Modifier.padding(14.dp))
        cars.forEachIndexed { i, car ->
            if (i > 0) CardDivider()
            Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                IconTile(Sym.car, if (car.ok) Theme.ok else Theme.warn, if (car.ok) Theme.okSoft else Theme.warnSoft)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(car.plate ?: "", style = T.subheadline.semibold.mono, color = Theme.ink)
                    Text(carLine(c, car), style = T.caption, color = Theme.muted)
                }
                if (car.id == app.driver?.activeCarId) Text("In use", style = T.caption.semibold, color = Theme.faint)
            }
        }
    }
}

private fun carLine(c: DriverChecks, car: CheckedVehicle): String {
    if (car.checkedAt == null) return "Not looked up yet: use it, then open this again."
    if (car.found == false) return if (c.fake == true) "Not in the RDW’s register (fine on the test server)" else "Not in the RDW’s register"
    if (car.exported == true) return "Exported, says the RDW"
    val parts = mutableListOf(if (car.taxi == true) "Taxi" else "Not a taxi", if (car.insured == true) "insured" else "not insured")
    parts += car.apkUntil?.let { "APK until ${ChecksDate.show(it)}" } ?: "no APK"
    if (car.plateSeen == false) parts += "a person checks its plate"
    return parts.joinToString(" · ")
}

// ---------- 1. Consent ----------

@Composable
private fun ConsentStep(done: (DriverChecks?) -> Unit) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Screen(
        "Agree to the checks",
        bottom = {
            PrimaryButton("I agree", working = working, onClick = {
                working = true
                scope.launch {
                    try {
                        done(ApiClient.post<ChecksResponse>("/api/checks/consent", mapOf("version" to 1)).checks)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = e.shown
                    }
                    working = false
                }
            })
        },
    ) {
        Explain(Sym.idCard, "Your ID’s chip", "Your phone reads the chip in your passport or ID card. That shows it’s genuine and gives your name, date of birth and until when it’s valid. We never read or keep your BSN or address.")
        Explain(Sym.face, "Your face", "A selfie, turning your head, is compared with the photo in the chip. That happens on this phone: the photos never leave it, only how well they match is sent.")
        Explain(Sym.doc, "Your documents", "Photos of your chauffeurskaart and taxi permit, and your KvK number. What’s on them is read on this phone and compared with your ID and KvK. Kiwa has no register we can check, so a person may look at the photos. They’re deleted 30 days after the decision.")
        Explain(Sym.car, "Your car", "We look up its plate in the RDW’s open register: registered as a taxi, insured, APK. The plate must be readable on the photo of its back.")
        Explain(Sym.people, "Who decides", "When everything checks out you can drive straight away. When something doesn’t, a person looks. Nothing is turned down by a computer.")
        Text("Read how we handle your data", style = T.footnote.semibold, color = Theme.accentInk, modifier = Modifier.clickable { openUrl(context, PRIVACY) })
        ErrorText(error)
    }
}

@Composable
private fun Explain(symbol: ImageVector, title: String, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        IconTile(symbol)
        Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = T.subheadline.semibold, color = Theme.ink)
            Text(text, style = T.footnote, color = Theme.muted)
        }
    }
}

// ---------- 2. ID and face ----------

private enum class IdStage { Key, Reading, Selfie, Matching, Finished }

private val isEmulator: Boolean
    get() = Build.FINGERPRINT.startsWith("generic") || Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish" || Build.PRODUCT.contains("sdk")

private fun Context.activity(): Activity? {
    var c: Context? = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

@Composable
private fun IdStep(done: (DriverChecks?) -> Unit) {
    val context = LocalContext.current
    val activity = remember { context.activity() }
    val scope = rememberCoroutineScope()
    val view = LocalView.current
    var stage by remember { mutableStateOf(IdStage.Key) }
    var number by remember { mutableStateOf("") }
    var birth by remember { mutableStateOf(LocalDate.now().minusYears(30)) }
    var expiry by remember { mutableStateOf(LocalDate.now().plusYears(5)) }
    val hasCamera = remember { CameraAccess.has(context) }
    // The scan read all three parts the chip needs. Its dates aren't shown: they're printed on the front of an ID card, and
    // showing them made it look like the side to scan (Pieter, 5 November 2026). Typing it in shows them, as a way out.
    var scanned by remember { mutableStateOf(false) }
    var typing by remember { mutableStateOf(!hasCamera) }
    var partly by remember { mutableStateOf(false) }
    var scanning by remember { mutableStateOf(false) }
    var chip by remember { mutableStateOf<ChipRead?>(null) }
    var who by remember { mutableStateOf<CheckedID?>(null) }
    var latest by remember { mutableStateOf<DriverChecks?>(null) }
    var faceOK by remember { mutableStateOf<Boolean?>(null) }
    var faceMatched by remember { mutableStateOf<Boolean?>(null) } // what this phone found: the same person, with a turn of the head
    var capture by remember { mutableStateOf<SelfieCapture?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var waitingForChip by remember { mutableStateOf<String?>(null) } // the message while the phone is held to the ID
    val nfc = remember { activity?.let { ChipReader.adapter(it) } }

    DisposableEffect(Unit) {
        onDispose {
            capture?.close()
            // The face match's network is 40 MB in memory: not kept once this is closed.
            FaceMatcher.get(context).release()
        }
    }

    // Listening for the chip while the form is up (ChipReader.hold), so Android never says it has no app for an ID held to the phone.
    // Android stops listening whenever the app leaves the screen, so it starts again each time the app comes back: after a look at
    // another app, an ID held to the phone was Android's again and couldn't be read (Pieter, 8 November 2026).
    val listening = stage == IdStage.Key || stage == IdStage.Reading
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    DisposableEffect(listening, activity, lifecycle) {
        val a = activity
        val owner = Any()
        val back = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME && a != null) ChipReader.hold(a, owner)
        }
        if (listening && a != null) {
            if (lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) ChipReader.hold(a, owner)
            lifecycle.addObserver(back)
        }
        onDispose {
            lifecycle.removeObserver(back)
            if (a != null) ChipReader.release(a, owner)
        }
    }

    // What the camera read goes in the form, for the driver to check: what opens the chip. Not the name: it has no check digit and
    // was too often read wrong (Pieter, 8 November 2026), while the chip gives it exactly, and that's the one shown and kept.
    fun use(read: MrzRead) {
        if (read.number == null && read.birth == null && read.expiry == null) return
        read.number?.let { number = it }
        read.birth?.let { MrzKey.date(it, past = true) }?.let { birth = it }
        read.expiry?.let { MrzKey.date(it, past = false) }?.let { expiry = it }
        // Cancelled halfway: what it read is kept, and the rest is typed in.
        scanned = read.hasKey
        partly = !scanned
        if (partly) typing = true
    }

    fun startSelfie() {
        error = null
        scope.launch {
            val c = try {
                ApiClient.post<CheckChallenge>("/api/checks/challenge", mapOf("kind" to "face"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.shown
                return@launch
            }
            capture?.close()
            val s = SelfieCapture(c.steps)
            s.onStep = { view.performHapticFeedback(HapticFeedbackConstants.CONFIRM) }
            s.onDone = { pictures -> scope.launch { finishSelfie(pictures, c, s, chip, context, { stage = it }, { capture = null }, { r, score, live -> latest = r.checks; faceOK = r.face?.passed; faceMatched = live && score >= FaceMatcher.SAME_PERSON }) { e -> error = e; startSelfie() } } }
            capture = s
            stage = IdStage.Selfie
        }
    }

    val askCamera = rememberCameraAsk { ok -> if (ok) startSelfie() else error = "Drivezzz needs the camera for the selfie. Allow it in Settings." }

    fun readChip() {
        error = null
        android.util.Log.i("ChipReader", "Read ID tapped")
        val a = activity ?: return
        val adapter = nfc
        if (adapter == null) {
            error = ChipError.NotHere().message
            return
        }
        if (!adapter.isEnabled) {
            error = ChipError.Off().message
            return
        }
        stage = IdStage.Reading
        scope.launch {
            val challenge = try {
                ApiClient.post<CheckChallenge>("/api/checks/challenge", mapOf("kind" to "chip"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                android.util.Log.w("ChipReader", "No challenge from the server: ${e.shown}")
                stage = IdStage.Key
                error = e.shown
                return@launch
            }
            val key = MrzKey(number, MrzKey.yymmdd(birth), MrzKey.yymmdd(expiry))
            val nonce = runCatching { Base64.decode(challenge.nonce, Base64.DEFAULT) }.getOrDefault(ByteArray(0))
            waitingForChip = "Hold the back of your phone flat on your ID: a passport on its photo page, an ID card anywhere. Keep still."
            val main = android.os.Handler(android.os.Looper.getMainLooper())
            ChipReader.next(a) { tag ->
                val result = runCatching { ChipReader.read(tag, key, nonce) { p -> main.post { waitingForChip = p } } }
                main.post {
                    waitingForChip = null
                    result.onFailure { e ->
                        android.util.Log.w("ChipReader", "Read ID shows: ${e.message}")
                        stage = IdStage.Key
                        error = e.message ?: ChipError.Unreadable().message
                        // A scan's dates aren't shown, so they couldn't be checked: now they are, to compare with the front of the ID.
                        if (e is ChipError.WrongKey && scanned) {
                            scanned = false
                            typing = true
                        }
                    }
                    result.onSuccess { read ->
                        scope.launch {
                            try {
                                val body = buildMap<String, Any?> {
                                    put("challengeId", challenge.id)
                                    put("sod", Base64.encodeToString(read.sod, Base64.NO_WRAP))
                                    put("dg1", Base64.encodeToString(read.dg1, Base64.NO_WRAP))
                                    read.dg15?.let { put("dg15", Base64.encodeToString(it, Base64.NO_WRAP)) }
                                    read.aaSignature?.let { put("aaSignature", Base64.encodeToString(it, Base64.NO_WRAP)) }
                                }
                                val r: ChecksResponse = ApiClient.post("/api/checks/chip", body)
                                android.util.Log.i("ChipReader", "The server has the chip's data")
                                chip = read
                                who = r.checks?.id
                                latest = r.checks
                                askCamera()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                android.util.Log.w("ChipReader", "The server refused the chip's data: ${e.shown}")
                                stage = IdStage.Key
                                error = e.shown
                            }
                        }
                    }
                }
            }
        }
    }

    Screen("Your ID and a selfie") {
        when (stage) {
            IdStage.Key, IdStage.Reading -> {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("Scan the back of your ID card", style = T.headline, color = Theme.ink)
                    Text("The side without your photo, with three lines of <<< at the bottom. With a passport it’s the two lines at the bottom of the photo page. What it reads opens your ID’s chip.", style = T.footnote, color = Theme.muted)
                }
                if (hasCamera) {
                    if (scanned) GhostButton("Scan again", onClick = { scanning = true }, icon = { Icon(Sym.viewfinder, null, modifier = Modifier.size(20.dp)) })
                    else PrimaryButton(onClick = { scanning = true }) {
                        Icon(Sym.viewfinder, null, modifier = Modifier.size(20.dp))
                        Text("Scan the back", style = T.size(17).semibold)
                    }
                }
                // No camera worth the name on an emulator: what a Dutch ID card's code says, for trying the rest.
                if (BuildConfig.DEBUG && isEmulator) {
                    GhostButton("Pretend to scan (no camera here)", onClick = {
                        use(MrzScan.read(listOf("I<NLDSPECI20212<<<<<<<<<<<<<<<", "6503101F3108022NLD<<<<<<<<<<<6", "DE<BRUIJN<<WILLEKE<LISELOTTE<<")))
                    })
                }
                if (partly) NoteBox(Sym.warning, Theme.warn, Theme.warnSoft, "Not everything could be read. Scan again, or fill in the rest.")
                if (scanned || typing) {
                    Column(Modifier.fillMaxWidth().card(Theme.radius, 0.dp)) {
                        FieldRow("Document number", number, mono = true, characters = true) { number = it }
                        if (typing && !scanned) {
                            CardDivider(14.dp)
                            DateRow("Date of birth", birth, last = LocalDate.now()) { birth = it }
                            CardDivider(14.dp)
                            // No limit: the chip only opens with the date as printed, also on an ID that has run out.
                            DateRow("Valid until", expiry) { expiry = it }
                        }
                    }
                    if (expiry.isBefore(LocalDate.now())) NoteBox(Sym.warning, Theme.warn, Theme.warnSoft, "This ID has run out: you need one that’s still valid.")
                    if (scanned) Text("Check the document number, then tap Read ID. Your name comes from the chip.", style = T.footnote.semibold, color = Theme.ink)
                    PrimaryButton("Read ID", working = stage == IdStage.Reading, enabled = number.count { it.isLetterOrDigit() } >= 6, onClick = { readChip() })
                } else {
                    Text("Can’t scan it? Type it in", style = T.footnote.semibold, color = Theme.accentInk, modifier = Modifier.clickable { typing = true }.padding(vertical = 4.dp))
                }
                if (nfc == null) NoteBox(Sym.warning, Theme.warn, Theme.warnSoft, "This phone can’t read chips: it has no NFC. Use a phone that has it.")
            }
            IdStage.Selfie -> {
                who?.let { IdSummary(it) }
                val s = capture
                if (s != null) {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        // A new try is a new camera, so it starts counting again.
                        androidx.compose.runtime.key(s) {
                            Box(Modifier.size(280.dp)) {
                                Box(Modifier.size(280.dp).clip(CircleShape).border(4.dp, Theme.accent, CircleShape)) {
                                    CameraView(front = true, modifier = Modifier.size(280.dp), analyze = { s.analyze(it) }, onCamera = { cam ->
                                        if (cam == null) s.failed("The front camera can’t be used.") else s.started()
                                    })
                                }
                                // Which way to turn, on that side of your face.
                                val arrow = s.arrow
                                if (arrow != null) {
                                    Box(
                                        Modifier
                                            .align(if (arrow == SelfieCapture.Side.Left) Alignment.CenterStart else Alignment.CenterEnd)
                                            .padding(10.dp)
                                            .size(52.dp)
                                            .background(Theme.accent, CircleShape),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Icon(if (arrow == SelfieCapture.Side.Left) Sym.arrowLeft else Sym.arrowRight, null, tint = Theme.onAccent, modifier = Modifier.size(26.dp))
                                    }
                                }
                            }
                        }
                    }
                    SelfieSteps(s)
                    val phase = s.phase
                    Text(if (phase is SelfieCapture.Phase.Failed) phase.why else s.hint, style = T.headline, color = Theme.ink, modifier = Modifier.fillMaxWidth(), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    if (phase is SelfieCapture.Phase.Failed) PrimaryButton("Try again", onClick = { askCamera() })
                } else {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) { Spinner() }
                }
            }
            IdStage.Matching -> Row(Modifier.fillMaxWidth().card(Theme.radius, 14.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Spinner()
                Text("Comparing your face with your ID…", style = T.subheadline, color = Theme.ink)
            }
            IdStage.Finished -> {
                who?.let { IdSummary(it) }
                // What the phone found, said as it is. On Android the server can't confirm the match came from this app yet, so it never
                // passes by itself and a person always looks: a good match was shown as if it wasn't one (Pieter, 7 November 2026).
                // Otherwise only that a person reviews it, not why (Pieter, 8 November 2026). As DriverChecksView.swift.
                when {
                    faceOK == true -> NoteBox(Sym.seal, Theme.ok, Theme.okSoft, "Your face matches your ID.")
                    faceMatched == true -> NoteBox(Sym.seal, Theme.ok, Theme.okSoft, "Your face matches your ID. A person confirms it once more before you’re verified. You can carry on with the rest.")
                    else -> NoteBox(Sym.clock, Theme.warn, Theme.warnSoft, "Your selfie is waiting for review. You can carry on with the rest.")
                }
                PrimaryButton("Next", onClick = { done(latest) })
            }
        }
        ErrorText(error)
    }

    if (scanning) {
        MrzScanner { found ->
            scanning = false
            if (found != null) use(found)
        }
    }
    val holding = waitingForChip
    if (holding != null) {
        DzSheet(onDismiss = {
            ChipReader.cancel()
            waitingForChip = null
            stage = IdStage.Key
        }, tall = false) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("Ready to read", style = T.title3.bold, color = Theme.ink)
                Icon(Sym.nfc, null, tint = Theme.accentInk, modifier = Modifier.size(64.dp))
                Text(holding, style = T.subheadline, color = Theme.muted, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                GhostButton("Cancel", onClick = {
                    ChipReader.cancel()
                    waitingForChip = null
                    stage = IdStage.Key
                })
            }
        }
    }
}

// Where you are: looking straight, the two turns, straight again. Done is green, the one now is the app's colour.
@Composable
private fun SelfieSteps(s: SelfieCapture) {
    val done = s.stepsDone
    Row(
        Modifier.fillMaxWidth().semantics { contentDescription = "Step ${minOf(done + 1, s.stepCount)} of ${s.stepCount}" },
        horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally),
    ) {
        for (i in 0 until s.stepCount) {
            val fill by animateColorAsState(
                when {
                    i < done -> Theme.ok
                    i == done -> Theme.accent
                    else -> Theme.line
                },
                label = "step",
            )
            Box(Modifier.width(28.dp).height(6.dp).background(fill, RoundedCornerShape(3.dp)))
        }
    }
}

// The face, compared with the chip's photo off the main thread, and what came of it sent: the score, never the pictures.
private suspend fun finishSelfie(
    pictures: List<Bitmap>,
    challenge: CheckChallenge,
    capture: SelfieCapture,
    chip: ChipRead?,
    context: Context,
    setStage: (IdStage) -> Unit,
    clearCapture: () -> Unit,
    onResult: (ChecksResponse, Double, Boolean) -> Unit,
    onError: (String) -> Unit,
) {
    setStage(IdStage.Matching)
    capture.close()
    clearCapture()
    try {
        val read = chip ?: throw FaceMatchError.NoFace()
        val photo = read.photo ?: throw FaceMatchError.NoFace()
        // A few hundred milliseconds of work.
        val (score, same) = withContext(Dispatchers.Default) {
            val matcher = FaceMatcher.get(context)
            val id = matcher.features(photo)
            val selfies = pictures.map { matcher.features(it, onlyOne = true) }
            val scores = selfies.map { FaceMatcher.cosine(id, it) }
            val same = if (selfies.size > 1) FaceMatcher.cosine(selfies[0], selfies[1]) else 1.0
            scores.sum() / maxOf(scores.size, 1) to same
        }
        // The two pictures must be the same person: the head turned, the face didn't change.
        val live = same > 0.5
        val dg1 = MessageDigest.getInstance("SHA-256").digest(read.dg1).joinToString("") { "%02x".format(it) }
        // In the order of its keys, as the iPhone sends it.
        val payload = JsonObject(
            linkedMapOf(
                "at" to JsonPrimitive(System.currentTimeMillis()),
                "challengeId" to JsonPrimitive(challenge.id),
                "dg1" to JsonPrimitive(dg1),
                "live" to JsonPrimitive(live),
                "model" to JsonPrimitive(FaceMatcher.MODEL_NAME),
                "score" to JsonPrimitive((score * 1000).roundToLong() / 1000.0),
                "steps" to JsonArray(challenge.steps.map { JsonPrimitive(it) }),
                "v" to JsonPrimitive(1),
            )
        ).toString()
        // Signed with this phone's attested key where it can be (AppAttest.kt): then the result can count by itself.
        val body = mutableMapOf<String, Any?>("payload" to payload)
        val user = AppState.user?.id
        val keyId = user?.let { AppAttest.keyId(it) }
        val assertion = if (user != null && keyId != null) AppAttest.sign(payload.toByteArray(), keyId, user) else null
        if (keyId != null && assertion != null) {
            body["keyId"] = keyId
            body["assertion"] = assertion
        }
        val r: ChecksResponse = ApiClient.post("/api/checks/face", body)
        onResult(r, score, live)
        setStage(IdStage.Finished)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        // Why, in the log (adb logcat -s Selfie): never the pictures or a score.
        android.util.Log.w("Selfie", "The face check didn't finish", e)
        setStage(IdStage.Selfie)
        onError(e.shown)
    }
}

@Composable
private fun IdSummary(id: CheckedID) {
    Row(Modifier.fillMaxWidth().card(Theme.radius, 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        IconTile(Sym.idCard, Theme.ok, Theme.okSoft)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val name = listOfNotNull(id.givenNames, id.surname).joinToString(" ") { part -> part.lowercase().split(' ').joinToString(" ") { it.replaceFirstChar(Char::titlecase) } }
            Text(name, style = T.subheadline.semibold, color = Theme.ink)
            Text("Read from your ID’s chip", style = T.caption, color = Theme.muted)
        }
    }
}

@Composable
private fun FieldRow(title: String, value: String, mono: Boolean = false, characters: Boolean = false, onChange: (String) -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 50.dp).padding(horizontal = 14.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = T.subheadline, color = Theme.ink)
        androidx.compose.foundation.text.BasicTextField(
            value = value,
            onValueChange = onChange,
            singleLine = true,
            textStyle = (if (mono) T.body.mono else T.body).copy(color = Theme.ink, textAlign = androidx.compose.ui.text.style.TextAlign.End),
            cursorBrush = androidx.compose.ui.graphics.SolidColor(Theme.accentInk),
            keyboardOptions = KeyboardOptions(capitalization = if (characters) KeyboardCapitalization.Characters else KeyboardCapitalization.Words, autoCorrectEnabled = false),
            modifier = Modifier.weight(1f),
        )
    }
}

// A day, picked with Android's own date picker. `first` and `last` limit it.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateRow(title: String, day: LocalDate, first: LocalDate? = null, last: LocalDate? = null, onChange: (LocalDate) -> Unit) {
    var picking by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().clickable { picking = true }.heightIn(min = 50.dp).padding(horizontal = 14.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = T.subheadline, color = Theme.ink, modifier = Modifier.weight(1f))
        Text(day.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)), style = T.subheadline.semibold, color = Theme.accentInk, modifier = Modifier.background(Theme.soft, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 6.dp))
    }
    if (picking) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = day.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean {
                    val d = java.time.Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate()
                    return (first == null || !d.isBefore(first)) && (last == null || !d.isAfter(last))
                }
            },
        )
        DatePickerDialog(
            onDismissRequest = { picking = false },
            confirmButton = {
                TextButton(onClick = {
                    picking = false
                    state.selectedDateMillis?.let { onChange(java.time.Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                }) { Text("Done", color = Theme.accentInk) }
            },
        ) { DatePicker(state = state) }
    }
}

// ---------- 3 and 4. Chauffeurskaart and taxi permit ----------

@Composable
private fun DocumentStep(kind: String, known: CheckedDocument?, done: (DriverChecks?) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val hasCamera = remember { CameraAccess.has(context) }
    var image by remember { mutableStateOf<Bitmap?>(null) }
    var text by remember { mutableStateOf("") }
    var number by remember { mutableStateOf(known?.number ?: "") }
    var validUntil by remember { mutableStateOf(LocalDate.now()) }
    var hasEnd by remember { mutableStateOf(!(kind == "permit" && known != null && known.expires == null)) }
    var camera by remember { mutableStateOf(false) }
    var fromCamera by remember { mutableStateOf(false) }
    var reading by remember { mutableStateOf(false) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val title = if (kind == "permit") "Taxi permit" else "Chauffeurskaart"

    fun use(img: Bitmap, camera: Boolean) {
        image = img
        fromCamera = camera
        reading = true
        scope.launch {
            val read = DocumentReader.read(img)
            reading = false
            text = read.text
            read.number?.let { number = it }
            read.validUntil?.takeIf { it.isAfter(LocalDate.now()) }?.let {
                validUntil = it
                hasEnd = true
            }
        }
    }

    val picker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val img = withContext(Dispatchers.IO) { runCatching { context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) } }.getOrNull() }
            if (img != null) use(img, camera = false) else error = "That photo can’t be used."
        }
    }

    fun send() {
        val img = image ?: return
        working = true
        error = null
        scope.launch {
            try {
                val jpeg = withContext(Dispatchers.Default) { DocumentReader.jpeg(img) }
                val expires = if (hasEnd) validUntil.toString() else ""
                val query = listOf("kind" to kind, "number" to number, "expires" to expires, "camera" to if (fromCamera) "1" else "0", "text" to text.take(3000))
                    .joinToString("&") { (k, v) -> "$k=${Uri.encode(v)}" }
                // Signed as signedByApp in checks.js reads it back: the same values, the text's hash, then the photo's.
                val headers = AppAttest.headers(listOf("drivezzz-doc-1", kind, number, expires, if (fromCamera) "1" else "0", AppAttest.hash(text.take(3000).toByteArray())), jpeg, AppState.user?.id)
                val r: ChecksResponse = ApiClient.upload("/api/checks/document?$query", jpeg, headers)
                done(r.checks)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.shown
            }
            working = false
        }
    }

    Screen(title, bottom = if (image != null) ({ PrimaryButton("Send", working = working, enabled = number.length >= 4, onClick = { send() }) }) else null) {
        Text(
            if (kind == "permit") "Your vergunning taxivervoer from Kiwa (or the one of the taxi company you drive for). Photograph the page with its number."
            else "The front of your chauffeurskaart, with your photo, its number and the date it’s valid until.",
            style = T.footnote, color = Theme.muted,
        )
        image?.let { img ->
            Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                Image(img.asImageBitmap(), null, contentScale = ContentScale.Fit, modifier = Modifier.heightIn(max = 240.dp).clip(RoundedCornerShape(14.dp)))
            }
        }
        if (hasCamera) {
            if (image == null) PrimaryButton(onClick = { camera = true }) {
                Icon(Sym.docScan, null, modifier = Modifier.size(20.dp))
                Text("Photograph it", style = T.size(17).semibold)
            } else GhostButton("Photograph it again", onClick = { camera = true }, icon = { Icon(Sym.docScan, null, modifier = Modifier.size(20.dp)) })
        } else {
            GhostButton("Choose a photo of it", onClick = { picker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, icon = { Icon(Sym.photo, null, modifier = Modifier.size(20.dp)) })
        }
        if (reading) Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Spinner(size = 18.dp)
            Text("Reading it…", style = T.footnote, color = Theme.ink)
        }
        if (image != null) {
            Column(Modifier.fillMaxWidth().card(Theme.radius, 0.dp)) {
                Box(Modifier.padding(14.dp)) {
                    DzField(number, { number = it.uppercase() }, "Number", filled = false, style = T.body.mono, keyboard = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false))
                }
                CardDivider(14.dp)
                if (kind == "permit") {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("It has an end date", style = T.subheadline, color = Theme.ink, modifier = Modifier.weight(1f))
                        DzSwitch(hasEnd, "It has an end date") { hasEnd = it }
                    }
                    if (hasEnd) CardDivider(14.dp)
                }
                if (hasEnd) DateRow("Valid until", validUntil, first = LocalDate.now()) { validUntil = it }
            }
            Text("Check that these match what’s on it.", style = T.caption, color = Theme.faint)
        }
        ErrorText(error)
    }
    if (camera) {
        DocumentCamera(card = kind == "chauffeurskaart") { shot ->
            camera = false
            if (shot != null) use(shot, camera = true)
        }
    }
}

// ---------- 5. KvK ----------

@Composable
private fun KvkStep(known: String?, done: (DriverChecks?) -> Unit) {
    val scope = rememberCoroutineScope()
    var number by remember { mutableStateOf(known ?: "") }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    Screen(
        "KvK number",
        bottom = {
            PrimaryButton("Send", working = working, enabled = number.count { it.isDigit() } == 8, onClick = {
                working = true
                error = null
                scope.launch {
                    try {
                        done(ApiClient.post<ChecksResponse>("/api/checks/kvk", mapOf("number" to number.filter { it.isDigit() })).checks)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        error = e.shown
                    }
                    working = false
                }
            })
        },
    ) {
        Text("The 8 digits of your business at the Kamer van Koophandel (or the taxi company you drive for).", style = T.footnote, color = Theme.muted)
        Box(Modifier.fillMaxWidth().card(Theme.radius, 14.dp)) {
            DzField(number, { number = it.filter { c -> c.isDigit() }.take(8) }, "KvK number", filled = false, style = T.title3.mono, keyboard = KeyboardOptions(keyboardType = KeyboardType.Number))
        }
        ErrorText(error)
    }
}
