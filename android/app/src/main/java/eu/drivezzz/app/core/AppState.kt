package eu.drivezzz.app.core

import android.Manifest
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

enum class AppMode(val key: String) {
    Rider("rider"), Driver("driver");

    companion object {
        fun of(key: String?): AppMode = entries.firstOrNull { it.key == key } ?: Rider
    }
}

enum class Phase { Loading, Intro, Name, Main, Banned }

// What going online found waiting for a person: the server's words, and whether it's the car's plate, the documents or both.
data class UnderReview(val message: String, val plate: Boolean, val documents: Boolean) {
    val title: String get() = if (plate && documents) "Under review" else if (plate) "Number plate under review" else "Documents under review"
}

// The whole app's state, the same as Core/AppState.swift: what the server says, what it means for the screens, and the two loops
// that keep it going, one hearing about changes and one sending our position.
object AppState {
    const val PROFILE_TAB = 4 // the same tab on both sides, so switching leaves you on it

    private val api = ApiClient
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    var phase by mutableStateOf(Phase.Loading)

    // Kept on the phone too: with no connection at launch you're still you, and still a driver.
    private var storedUser by mutableStateOf<User?>(null)
    var user: User?
        get() = storedUser
        set(value) {
            storedUser = value
            Prefs.set("user", value?.let { JsonFormat.encodeToString(User.serializer(), it) })
        }

    var standing by mutableStateOf<Standing?>(null)
    var driveOpen by mutableStateOf(false) // the drive's directions and buttons are showing over the Driving tab's map
    var parkedOffer by mutableStateOf<String?>(null) // a ride request swiped down: it waits in Current on Drives
    var reviewPrompt by mutableStateOf<String?>(null) // a ride that just ended: its page asks for a review once

    private var storedMode by mutableStateOf(AppMode.Rider)
    var mode: AppMode
        get() = storedMode
        set(value) {
            storedMode = value
            Prefs.set("mode", value.key)
        }

    private var storedAppearance by mutableStateOf(AppAppearance.Auto)
    var appearance: AppAppearance
        get() = storedAppearance
        set(value) {
            storedAppearance = value
            Prefs.set("appearance", value.key)
        }

    var darkOutside by mutableStateOf(false)
        private set
    val isDark: Boolean get() = appearance == AppAppearance.Dark || (appearance == AppAppearance.Auto && darkOutside)

    private var storedAccent by mutableStateOf(AppAccent.Blue)
    var accent: AppAccent
        get() = storedAccent
        set(value) {
            storedAccent = value
            Prefs.set("accent", value.key)
        }

    // What /api/sync says.
    var rev by mutableIntStateOf(0)
    var ride by mutableStateOf<Ride?>(null) // the rider's current ride
    var driving by mutableStateOf(DrivingState())
    var unreadMessages by mutableIntStateOf(0)
    private var driverState by mutableStateOf<OwnDriver?>(null)
    var driver: OwnDriver?
        get() = driverState
        set(value) {
            driverState = value
            // The newest word on the checks, whichever brought it: a sync, or the driver's own data after sending something.
            value?.checks?.let { c -> if (c != driving.checks) driving = driving.copy(checks = c) }
        }
    // Driving in the Netherlands: what still needs attention. Null: nothing to say. As AppState.swift.
    val checksAttention: String? get() = driving.checks?.attention
    var driveMode by mutableStateOf(false)
    var driveStartedAt by mutableStateOf<Long?>(null)
    var reconnecting by mutableStateOf(false)
    var dismissedCheckIn by mutableStateOf<String?>(null) // the ride whose check-in screen was dismissed
    var showingRide by mutableStateOf<Ride?>(null) // the ride page, opened by itself after ordering
    private var askedToPay: String? = null // the planned ride whose page already opened to pay, so closing it stays closed
    var coloursOpen by mutableStateOf(false) // the colours in Profile
    var rideOnScreen by mutableStateOf<String?>(null) // the ride whose page is open now: it opens its own check-in
    var driverTab by mutableIntStateOf(0)
    var drivesPart by mutableIntStateOf(0) // Drives: current, planned, completed

    // How far a driver looks for orders, 1 to 40 km; kept on the phone.
    private var storedRadius by mutableDoubleStateOf(10.0)
    var driverRadiusKm: Double
        get() = storedRadius
        set(value) {
            storedRadius = value
            Prefs.set("driverRadiusKm", value)
        }
    var riderTab by mutableIntStateOf(0)
    var routeToUse by mutableStateOf<SavedRoute?>(null) // picked in Rides, for Home to fill in
    var checksOpen by mutableStateOf(false) // Driving in the Netherlands (DriverChecksSheet): going online opens it when the checks are needed
    var underReview by mutableStateOf<UnderReview?>(null) // going online found only a person's look left: said on Driving, not the checks again
    var mapRide by mutableStateOf<Ride?>(null) // a booked ride opened from a driver's map (Root), so the map isn't what holds it
    var chatsOpen = 0 // a chat on screen hears new messages right away

    private val location = LocationService
    private var syncJob: Job? = null
    private var locationJob: Job? = null
    private var nudge = false
    private var resuming = false
    private var everySeconds = 60
    var isActive = true
        private set
    private val notified = mutableSetOf<String>()
    private var sentPushToken: String? = null
    private var started = false

    fun init() {
        storedUser = Prefs.string("user")?.let { runCatching { JsonFormat.decodeFromString(User.serializer(), it) }.getOrNull() }
        storedMode = AppMode.of(Prefs.string("mode"))
        storedAppearance = AppAppearance.of(Prefs.string("appearance"))
        storedAccent = AppAccent.of(Prefs.string("accent"))
        storedRadius = Prefs.double("driverRadiusKm") ?: 10.0
        darkOutside = isDarkOutside()
        MessageFilter.init(Prefs.stringSet("filterWords"))
    }

    // Where the phone was last known counts until it knows again, so the app doesn't open in the wrong appearance.
    private fun isDarkOutside(): Boolean {
        location.location?.let {
            Prefs.set("sunLat", it.latitude)
            Prefs.set("sunLng", it.longitude)
        }
        val lat = Prefs.double("sunLat") ?: return Sunlight.isDarkByClock()
        val lng = Prefs.double("sunLng") ?: return Sunlight.isDarkByClock()
        return Sunlight.isDark(System.currentTimeMillis(), lat, lng)
    }

    fun checkOutside() {
        val dark = isDarkOutside()
        if (dark != darkOutside) darkOutside = dark
    }

    // ---------- starting ----------

    fun startIfNeeded() {
        if (started) return
        started = true
        scope.launch { start() }
    }

    private suspend fun start() {
        val shownSince = System.currentTimeMillis()
        var next = Phase.Intro
        if (api.token != null) {
            try {
                val me: MeResponse = api.get("/api/me")
                user = me.user
                standing = me.standing
                next = if (me.standing?.ban != null) Phase.Banned else Phase.Main
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                if (e.status == 401) api.token = null else next = Phase.Main
            }
        }
        val shown = System.currentTimeMillis() - shownSince
        if (shown < 1400) delay(1400 - shown)
        phase = next
        if (next == Phase.Main) enteredMain() else if (next == Phase.Banned) startLoops()
    }

    suspend fun enteredMain() {
        location.start()
        startLoops()
        askForNotifications()
        user?.id?.let {
            E2E.prepare(it)
            MessageFilter.load { words -> Prefs.set("filterWords", words) }
        }
        if (user?.isDriver == true) loadDriver()
        if (user?.isDriver != true && mode == AppMode.Driver) mode = AppMode.Rider
        // Android ended the app while driving and brought it back.
        resumeDriving()
    }

    private fun startLoops() {
        if (syncJob == null) syncJob = scope.launch { syncLoop() }
        if (locationJob == null) locationJob = scope.launch { locationLoop() }
    }

    private fun stopLoops() {
        syncJob?.cancel()
        syncJob = null
        locationJob?.cancel()
        locationJob = null
    }

    fun sceneChanged(active: Boolean) {
        isActive = active
        if (active) {
            nudge = true
            // Only once you're in: the intro doesn't ask for your location.
            if (phase == Phase.Main) location.start()
            scope.launch {
                refreshMe()
                // Whatever happened while the app was asleep shows right away.
                if (phase == Phase.Main) syncNow()
            }
        }
        updateBackgroundMode()
    }

    suspend fun refreshMe() {
        attempt { checkStanding() }
    }

    // Says so when the server can't be reached, for the ban screen's button.
    suspend fun checkStanding() {
        if (api.token == null) return
        val me: MeResponse = api.get("/api/me")
        user = me.user
        applyStanding(me.standing)
    }

    private fun applyStanding(s: Standing?) {
        standing = s
        if (s == null) return
        if (s.ban != null) {
            phase = Phase.Banned
            stopDriving(tellServer = false)
        } else if (phase == Phase.Banned) {
            phase = Phase.Main
            scope.launch { enteredMain() }
        }
    }

    // ---------- accounts ----------

    suspend fun continueNew(eula: Int) {
        val r: AuthResponse = api.post("/api/auth/continue", mapOf("deviceId" to ServerConfig.deviceId, "eula" to eula))
        api.token = r.token
        user = r.user
        standing = r.standing
        if (r.standing?.ban != null) {
            phase = Phase.Banned
            startLoops()
        } else if (r.isNew == true || r.user.name == r.user.id) {
            phase = Phase.Name
        } else {
            phase = Phase.Main
            enteredMain()
        }
    }

    suspend fun finishName(name: String) {
        val trimmed = name.trim()
        if (trimmed.isNotEmpty() && trimmed != user?.name) rename(trimmed)
        phase = Phase.Main
        enteredMain()
    }

    suspend fun rename(name: String) {
        val r: MeResponse = api.send("PATCH", "/api/me", mapOf("name" to name))
        user = r.user
    }

    suspend fun login(email: String, password: String) {
        val r: AuthResponse = api.post("/api/auth/login", mapOf("email" to email, "password" to password, "deviceId" to ServerConfig.deviceId))
        api.token = r.token
        user = r.user
        standing = r.standing
        reset()
        if (r.standing?.ban != null) {
            phase = Phase.Banned
            startLoops()
        } else {
            phase = Phase.Main
            enteredMain()
        }
    }

    suspend fun register(email: String, password: String) {
        val r: MeResponse = api.post("/api/auth/register", mapOf("email" to email, "password" to password))
        user = r.user
    }

    private fun reset() {
        stopDriving(tellServer = false)
        stopLoops()
        rev = 0
        ride = null
        driving = DrivingState()
        driver = null
        driveMode = false
        showingRide = null
        unreadMessages = 0
        // Whoever comes in next starts on Home, the map, not on the Profile this one logged out or deleted from (Pieter, 6 November 2026).
        riderTab = 0
        driverTab = 0
        mode = AppMode.Rider
        E2E.reset()
    }

    suspend fun logout() {
        if (driveMode) stopDriving(tellServer = true)
        attempt { api.call("POST", "/api/auth/logout", sentPushToken?.let { mapOf("pushToken" to it) } ?: emptyMap()) }
        sentPushToken = null
        api.token = null
        user = null
        standing = null
        reset()
        mode = AppMode.Rider
        phase = Phase.Intro
    }

    suspend fun deleteAccount() {
        api.call("DELETE", "/api/me")
        SavedRoutes.forget(user?.id)
        sentPushToken = null
        api.token = null
        user = null
        standing = null
        reset()
        mode = AppMode.Rider
        phase = Phase.Intro
    }

    // ---------- hearing about changes ----------

    private suspend fun syncLoop() {
        var failures = 0
        while (scope.isActive) {
            if (api.token == null) {
                syncJob = null
                return
            }
            try {
                // Something going on: waiting for news on an open connection, to hear it right away. Just looking around, asking
                // now and then is enough, and the server and everything in front of it needn't keep a connection open for each phone.
                val waiting = inAction
                val r: SyncResponse = api.get("/api/sync?rev=$rev${if (waiting) "&wait=50" else ""}")
                failures = 0
                reconnecting = false
                if (r.same != true) apply(r)
                if (!waiting) {
                    for (i in 0 until 60) {
                        if (inAction) break
                        delay(1000)
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                if (e.status == 401) {
                    api.token = null
                    user = null
                    reset()
                    phase = Phase.Intro
                    return
                }
                failures++
                if (driveMode) reconnecting = true
                delay(minOf(30, 2 * failures) * 1000L)
            }
        }
    }

    private val inAction: Boolean get() = ride != null || driveMode || driving.drive != null || chatsOpen > 0

    // What the server just answered about the rider's ride (a check-in, say): shown at once, not at the next sync, which can fail on a
    // poor connection and then wait. Pieter, 8 November 2026: after checking in, it kept saying Pickup for a while. As AppState.swift.
    fun use(fresh: Ride) {
        if (ride?.id == fresh.id) ride = fresh
        if (showingRide?.id == fresh.id) showingRide = fresh
    }

    suspend fun syncNow() {
        attempt { apply(api.get<SyncResponse>("/api/sync?rev=0")) }
    }

    // A push came in while the app runs: what it's about shows at once, not at the next look.
    fun pushed() {
        if (api.token == null) return
        scope.launch { syncNow() }
    }

    private fun apply(r: SyncResponse) {
        rev = r.rev
        if (r.banned == true) {
            applyStanding(r.standing)
            return
        }
        if (phase == Phase.Banned) scope.launch { refreshMe() }
        if (r.strikes != null && r.strikes != standing?.strikes) scope.launch { refreshMe() }
        r.unreadMessages?.let { unread ->
            if (unread > unreadMessages) say("message:${System.currentTimeMillis()}", "New message", "Open Drivezzz to read it.")
            unreadMessages = unread
        }
        val before = ride
        ride = r.ride
        r.driving?.let { d ->
            val hadOffer = driving.offer?.id
            val hadChecks = driving.checks
            driving = d
            d.offer?.let { offer -> if (offer.id != hadOffer) say("offer:${offer.id}", "New ride", "${Fmt.eur(offer.priceCents)} · ${Fmt.km(offer.distanceM)}") }
            // Driving in the Netherlands changed (a person decided, or something needs attention): the driver again, for the blue
            // check, and said when there's no push to say it. As AppState.swift.
            val checks = d.checks
            if (checks != null && hadChecks != null && checks != hadChecks) {
                scope.launch { loadDriver() }
                val line = checks.attention
                if (line != null) say("checks:${checks.status}:${checks.again}:${checks.open}", "Driving in the Netherlands", line)
                else if (checks.status == "approved" && hadChecks.status != "approved") say("checks:approved", "You can drive in the Netherlands", "Your documents were checked.")
            }
            d.drive?.let { drive -> if (drive.status == "riding") say("checkin:${drive.id}", "Checked in", "You can drive.") }
            // Put offline for not answering a ride: they stay so until they go online themselves.
            if (d.putOffline == true) {
                stopDriving(tellServer = false)
            } else if (driveMode && d.online != true) {
                // Drive mode is on but the server let us go: back online right away.
                nudge = true
            }
        }
        ride?.let { ride ->
            // A driver accepted: straight to the screen to pay.
            if (ride.status == "awaiting_payment" && before?.status != "awaiting_payment") {
                say("pay:${ride.id}", "${ride.driver?.name ?: "A driver"} accepted your ride", "Pay within 5 minutes to confirm.")
                if (mode == AppMode.Rider && showingRide?.id != ride.id) showingRide = ride
            }
            if (ride.status == "accepted" && before?.status != "accepted") say("acc:${ride.id}", "Your driver is on the way", ride.driver?.name ?: "")
            if (ride.driverLate == true) say("late:${ride.id}", "Your driver is late", "You can cancel for a full refund until you check in.")
            if (ride.status == "arrived") say("arr:${ride.id}", "Your driver is here", "Check the number plate, get in, then check in.")
            if (ride.canCheckIn == true) say("near:${ride.id}", "Your driver is close", "Check in when you’re in the car.", alsoPushed = false)
        }
        // A driver claimed a planned order: straight to the screen to pay, once. The ride itself is for later, so it's not `ride`.
        r.toPay?.let { due ->
            say("pay:${due.id}", "${due.driver?.name ?: "A driver"} accepted your ride", "Pay to confirm it.")
            if (mode == AppMode.Rider && showingRide == null && askedToPay != due.id) {
                askedToPay = due.id
                showingRide = due
            }
        }
        // A ride that just ended opens its page: rate the driver, or see why it was cancelled.
        if (before != null && ride == null && (before.isLive || before.isWaiting)) {
            scope.launch {
                val over = attempt { api.get<RideResponse>("/api/rides/${before.id}") }?.ride ?: return@launch
                if (over.isOver && over.cancelledBy != "rider") {
                    say("over:${before.id}", if (over.status == "completed") "You’ve arrived" else "Your ride was cancelled", if (over.status == "completed") "${if (over.isCash) "Paid in cash. " else ""}How was your ride?" else (over.cancelReason ?: ""))
                    showingRide = over
                    if (over.status == "completed" && over.review == null) reviewPrompt = over.id
                }
            }
        }
        showingRide?.let { open ->
            listOfNotNull(ride, driving.drive, driving.offer).firstOrNull { it.id == open.id }?.let { showingRide = it }
        }
        // A planned ride or drive can start while the app shows the other side.
        if (mode == AppMode.Driver && driving.drive == null && ride != null) {
            stopDriving()
            mode = AppMode.Rider
            showingRide = null
        } else if (mode == AppMode.Rider && ride == null && driving.drive != null) {
            mode = AppMode.Driver
            driverTab = 0
            showingRide = null
        }
        updateBackgroundMode()
    }

    // A notification from the app, for when it's running in the background. Once this phone has push the server
    // sends these itself, so only what it doesn't send is said here: otherwise they'd arrive twice.
    private fun say(key: String, title: String, body: String, alsoPushed: Boolean = true) {
        if (key in notified) return
        notified.add(key)
        if (isActive || (alsoPushed && sentPushToken != null)) return
        Notifier.say(key, title, body)
    }

    private fun askForNotifications() {
        Permissions.ask(Manifest.permission.POST_NOTIFICATIONS)
        Push.register { pushToken(it) }
    }

    fun pushToken(token: String) {
        if (api.token == null) return
        scope.launch {
            // Only a server that pushes through Firebase gets this token: an older one would take it for an iPhone's and hand
            // it to Apple. Asked each time, as the app can meet either.
            val can: MeResponse = attempt { api.send<MeResponse>("PATCH", "/api/me", mapOf("pushEnv" to "fcm")) } ?: return@launch
            if (can.fcmOn != true) return@launch
            val ack: MeResponse = attempt { api.send<MeResponse>("PATCH", "/api/me", mapOf("pushToken" to token, "pushEnv" to "fcm")) } ?: return@launch
            // Only a server that can push says things for us; otherwise the app keeps saying them itself.
            sentPushToken = if (ack.pushOn == true) token else null
        }
    }

    // ---------- sending our position ----------

    // Without push, a rider waiting for a driver stays awake here too: it's what tells them a driver accepted and they have 5
    // minutes to pay. iOS only needs this from then on, as the server pushes the rest.
    private val needsBackground: Boolean
        get() = driveMode || ride?.isLive == true || driving.drive != null || (ride?.isWaiting == true && sentPushToken == null)

    private fun updateBackgroundMode() {
        val want = needsBackground
        if (want != location.inBackgroundMode) location.setBackground(want)
        if (want) nudgeIfRideStarted()
    }

    private var lastLiveRide: String? = null
    private fun nudgeIfRideStarted() {
        val live = ride?.id ?: driving.drive?.id
        if (live != lastLiveRide) {
            lastLiveRide = live
            nudge = true
        }
    }

    private suspend fun locationLoop() {
        while (scope.isActive) {
            nudge = false
            resumeDriving()
            var wait = everySeconds
            if (Prefs.bool("driveWanted") && !driveMode) wait = 10
            val here = location.location
            if (api.token != null && phase == Phase.Main && (isActive || needsBackground) && here != null) {
                try {
                    val body = buildMap<String, Any?> {
                        put("lat", here.latitude)
                        put("lng", here.longitude)
                        here.course?.let { put("heading", it) }
                        here.speedOrNull?.let { put("speed", it) }
                        if (driveMode) put("driving", true)
                    }
                    val r: LocationAnswer = api.post("/api/location", body)
                    reconnecting = false
                    everySeconds = r.every ?: 60
                    wait = everySeconds
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Reconnects by itself: tries again soon.
                    if (driveMode) reconnecting = true
                    wait = 10
                }
            } else if (api.token != null && location.location == null) {
                wait = 2
            }
            for (i in 0 until wait) {
                if (nudge) break
                delay(1000)
            }
        }
    }

    fun sendLocationNow() {
        nudge = true
    }

    // ---------- the driver's side ----------

    suspend fun loadDriver() {
        attempt { api.get<OwnDriverResponse>("/api/driver") }?.let { driver = it.driver }
    }

    // You stay rider or driver until the ride or drive is over: why you can't switch, while that's so.
    val modeLock: String?
        get() = when {
            mode == AppMode.Rider && ride != null -> "You can switch to driving once this ride is over."
            mode == AppMode.Driver && driving.drive != null -> "You can switch to riding once this drive is over."
            else -> null
        }

    suspend fun becomeDriver() {
        val r: OwnDriverResponse = api.post("/api/driver/enable")
        driver = r.driver
        // A driver now, even if the refresh below doesn't get through: the tabs go by this, and without it the next switch would start over on My page.
        user = user?.copy(isDriver = true)
        refreshMe()
        mode = AppMode.Driver
    }

    // The driver has read that what the law asks where they drive is up to them. Drivezzz checks no licences.
    suspend fun rulesSeen() {
        val r = attempt { api.post<OwnDriverResponse>("/api/driver/rules-seen") } ?: return
        driver = r.driver ?: driver
    }

    suspend fun goOnline(): String? {
        // Asking for it counts, even before the first position or connection.
        Prefs.set("driveWanted", true)
        val here = location.location ?: return "We need your location to use this app."
        try {
            val r: OwnDriverResponse = api.post("/api/driver/online", mapOf("lat" to here.latitude, "lng" to here.longitude))
            driver = r.driver ?: driver
            underReview = null
            driveMode = true
            driveStartedAt = System.currentTimeMillis()
            DataMeter.reset()
            everySeconds = 60
            updateBackgroundMode()
            // The position loop may be in a rider's 5-minute wait: without this, a phone put away right after going online
            // said nothing for that long, and the server takes a driver offline after 3 minutes without a position.
            nudge = true
            return null
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (e.status > 0) Prefs.set("driveWanted", false)
            // A car in the Netherlands: the checks open instead of an error.
            if (e.code == "need_checks") {
                checksOpen = true
                return null
            }
            // Everything's in and only a person looking is left (the car's plate, the documents): nothing to do in the checks, so it
            // says so plainly, with what can be done meanwhile (Pieter, 8 November 2026).
            if (e.code == "checks_review") {
                underReview = UnderReview(e.message, plate = e.extra["plate"] == 1.0, documents = e.extra["documents"] == 1.0)
                return null
            }
            return e.message
        }
    }

    // Comes back online by itself: after Android ended the app, or when there was no connection or location yet.
    private suspend fun resumeDriving() {
        if (driveMode || resuming || !Prefs.bool("driveWanted") || user?.isDriver != true || api.token == null || phase != Phase.Main) return
        resuming = true
        try {
            goOnline()
        } finally {
            resuming = false
        }
    }

    fun stopDriving(tellServer: Boolean = true) {
        Prefs.set("driveWanted", false)
        if (!driveMode) return
        driveMode = false
        driveStartedAt = null
        reconnecting = false
        updateBackgroundMode()
        if (tellServer) {
            scope.launch {
                attempt { api.post<OwnDriverResponse>("/api/driver/offline") }?.let { driver = it.driver ?: driver }
                syncNow()
            }
        }
    }

}
