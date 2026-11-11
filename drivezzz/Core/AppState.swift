import CoreLocation
import Foundation
import SwiftUI
import UIKit
import UserNotifications

enum AppMode: String { case rider, driver }

@Observable
final class AppState {
    static let shared = AppState()

    enum Phase: Equatable { case loading, intro, name, main, banned }

    var phase: Phase = .loading
    // Kept on the phone too: with no connection at launch you're still you, and still a driver.
    var user: User? = AppState.savedUser() {
        didSet { UserDefaults.standard.set(user.flatMap { try? JSONEncoder().encode($0) }, forKey: "user") }
    }
    var standing: Standing?
    var driveOpen = false            // the drive's directions and buttons are showing over the Driving tab's map
    var parkedOffer: String?         // a ride request swiped down: it waits in Current on Drives
    var reviewPrompt: String?        // a ride that just ended: its page asks for a review once
    var mode: AppMode = AppMode(rawValue: UserDefaults.standard.string(forKey: "mode") ?? "") ?? .rider {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "mode") }
    }

    var appearance = AppAppearance.saved {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "appearance") }
    }
    private(set) var darkOutside = AppState.isDarkOutside()
    var colorScheme: ColorScheme { appearance == .dark || (appearance == .auto && darkOutside) ? .dark : .light }

    // Where the phone was last known counts until it knows again, so the app doesn't open in the wrong appearance.
    private static func isDarkOutside() -> Bool {
        let saved = UserDefaults.standard
        if let here = LocationService.shared.location?.coordinate {
            saved.set(here.latitude, forKey: "sunLat")
            saved.set(here.longitude, forKey: "sunLng")
        }
        guard saved.object(forKey: "sunLat") != nil else { return Sunlight.isDarkByClock(at: Date()) }
        return Sunlight.isDark(at: Date(), lat: saved.double(forKey: "sunLat"), lng: saved.double(forKey: "sunLng"))
    }

    func checkOutside() {
        let dark = Self.isDarkOutside()
        if dark != darkOutside { darkOutside = dark }
    }

    var accent = AppAccent.current {
        didSet {
            AppAccent.current = accent
            UserDefaults.standard.set(accent.rawValue, forKey: "accent")
            accent.applyToControls()
        }
    }

    // What /api/sync says.
    var rev = 0
    var ride: Ride?                     // the rider's current ride
    var driving = DrivingState()
    var unreadMessages = 0
    var driver: OwnDriver? {
        // The newest word on the checks, whichever brought it: a sync, or the driver's own data after sending something.
        didSet { if let c = driver?.checks, c != driving.checks { driving.checks = c } }
    }
    // Driving in the Netherlands: what still needs attention. Nil: nothing to say.
    var checksAttention: String? { driving.checks?.attention }
    var driveMode = false
    var driveStartedAt: Date?
    var reconnecting = false
    var dismissedCheckIn: String?       // the ride whose check-in screen was dismissed
    var showingRide: Ride?              // the ride page, opened by itself after ordering
    private var askedToPay: String?     // the planned ride whose page already opened to pay, so closing it stays closed
    var checksOpen = false              // Driving in the Netherlands (DriverChecksSheet): going online opens it when the checks are needed
    var underReview: UnderReview?       // going online found only a person's look left: said on the Driving tab, not the checks again
    var mapRide: Ride?                  // a booked ride opened from a driver's map (RideSheetHost): here, so opening it doesn't redo the map
    var coloursOpen = false             // the colours in Profile. Here, as picking one makes every screen again, and it should stay open for the next try
    var rideOnScreen: String?           // the ride whose page is open now: it opens its own check-in
    var driverTab = 0
    var drivesPart = 0                  // Drives: current, planned, completed
    // How far a driver looks for orders, 1 to 40 km; kept on the phone.
    var driverRadiusKm: Double = UserDefaults.standard.object(forKey: "driverRadiusKm") as? Double ?? 10 {
        didSet { UserDefaults.standard.set(driverRadiusKm, forKey: "driverRadiusKm") }
    }
    var riderTab = 0
    var routeToUse: SavedRoute?         // picked in Rides, for Home to fill in
    @ObservationIgnored var chatsOpen = 0   // a chat on screen hears new messages right away
    static let profileTab = 4           // the same tab on both sides, so switching leaves you on it

    private static func savedUser() -> User? {
        UserDefaults.standard.data(forKey: "user").flatMap { try? JSONDecoder().decode(User.self, from: $0) }
    }

    private let api = APIClient.shared
    private let location = LocationService.shared
    private var syncTask: Task<Void, Never>?
    private var locationTask: Task<Void, Never>?
    private var nudge = false
    private var resuming = false
    private var everySeconds = 60
    private(set) var isActive = true
    private var notified = Set<String>()
    private var sentPushToken: String?

    // ---------- starting ----------

    func start() async {
        let shownSince = Date()
        var next: Phase = .intro
        if api.token != nil {
            do {
                let me: MeResponse = try await api.get("/api/me")
                user = me.user
                standing = me.standing
                next = me.standing?.ban != nil ? .banned : .main
            } catch let error as APIError where error.status == 401 {
                api.token = nil
            } catch {
                // No connection: the app opens anyway, and the sync loop catches up.
                next = .main
            }
        }
        let shown = Date().timeIntervalSince(shownSince)
        if shown < 1.4 { try? await Task.sleep(for: .seconds(1.4 - shown)) }
        phase = next
        if next == .main { await enteredMain() } else if next == .banned { startLoops() }
    }

    func enteredMain() async {
        location.start()
        startLoops()
        askForNotifications()
        if let id = user?.id {
            await E2E.shared.prepare(accountId: id)
            await MessageFilter.load()
        }
        if user?.isDriver == true { await loadDriver() }
        if user?.isDriver != true, mode == .driver { mode = .rider }
        // iOS ended the app while driving and brought it back.
        await resumeDriving()
    }

    private func startLoops() {
        if syncTask == nil { syncTask = Task { await syncLoop() } }
        if locationTask == nil { locationTask = Task { await locationLoop() } }
    }

    private func stopLoops() {
        syncTask?.cancel()
        syncTask = nil
        locationTask?.cancel()
        locationTask = nil
    }

    func sceneChanged(active: Bool) {
        isActive = active
        if active {
            nudge = true
            // Only once you're in: the intro doesn't ask for your location.
            if phase == .main { location.start() }
            Task {
                await refreshMe()
                // Whatever happened while the app was asleep shows right away.
                if phase == .main { await syncNow() }
            }
        }
        updateBackgroundMode()
    }

    func refreshMe() async {
        try? await checkStanding()
    }

    // Says so when the server can't be reached, for the ban screen's button.
    func checkStanding() async throws {
        guard api.token != nil else { return }
        let me: MeResponse = try await api.get("/api/me")
        user = me.user
        applyStanding(me.standing)
    }

    private func applyStanding(_ s: Standing?) {
        standing = s
        guard let s else { return }
        if s.ban != nil {
            phase = .banned
            stopDriving(tellServer: false)
        } else if phase == .banned {
            phase = .main
            Task { await enteredMain() }
        }
    }

    // ---------- accounts ----------

    func continueNew(eula: Int) async throws {
        let r: AuthResponse = try await api.post("/api/auth/continue", ["deviceId": ServerConfig.deviceId, "eula": eula])
        api.token = r.token
        user = r.user
        standing = r.standing
        if r.standing?.ban != nil {
            phase = .banned
            startLoops()
        } else if r.isNew == true || r.user.name == r.user.id {
            phase = .name
        } else {
            phase = .main
            await enteredMain()
        }
    }

    func finishName(_ name: String) async throws {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty, trimmed != user?.name { try await rename(trimmed) }
        phase = .main
        await enteredMain()
    }

    func rename(_ name: String) async throws {
        let r: MeResponse = try await api.send("PATCH", "/api/me", ["name": name])
        user = r.user
    }

    func login(email: String, password: String) async throws {
        let r: AuthResponse = try await api.post("/api/auth/login", ["email": email, "password": password, "deviceId": ServerConfig.deviceId])
        api.token = r.token
        user = r.user
        standing = r.standing
        reset()
        if r.standing?.ban != nil {
            phase = .banned
            startLoops()
        } else {
            phase = .main
            await enteredMain()
        }
    }

    func register(email: String, password: String) async throws {
        let r: MeResponse = try await api.post("/api/auth/register", ["email": email, "password": password])
        user = r.user
    }

    private func reset() {
        stopDriving(tellServer: false)
        stopLoops()
        rev = 0
        ride = nil
        driving = DrivingState()
        driver = nil
        driveMode = false
        showingRide = nil
        unreadMessages = 0
        // Whoever comes in next starts on Home, the map, not on the Profile this one logged out or deleted from (Pieter, 6 November 2026).
        riderTab = 0
        driverTab = 0
        mode = .rider
        E2E.shared.reset()
    }

    func logout() async {
        if driveMode { stopDriving(tellServer: true) }
        try? await api.call("POST", "/api/auth/logout", sentPushToken.map { ["pushToken": $0] } ?? [:])
        sentPushToken = nil
        api.token = nil
        user = nil
        standing = nil
        reset()
        mode = .rider
        phase = .intro
    }

    func deleteAccount() async throws {
        try await api.call("DELETE", "/api/me", [:])
        SavedRoutes.shared.forget(account: user?.id)
        sentPushToken = nil
        api.token = nil
        user = nil
        standing = nil
        reset()
        mode = .rider
        phase = .intro
    }

    // ---------- hearing about changes ----------

    private func syncLoop() async {
        var failures = 0
        while !Task.isCancelled {
            guard api.token != nil else { return }
            do {
                // Something going on: waiting for news on an open connection, to hear it right away. Just looking around, asking
                // now and then is enough, and the server and everything in front of it needn't keep a connection open for each phone.
                let waiting = inAction
                let r: SyncResponse = try await api.get("/api/sync?rev=\(rev)\(waiting ? "&wait=50" : "")")
                failures = 0
                reconnecting = false
                if r.same != true { apply(r) }
                if !waiting {
                    for _ in 0..<60 {
                        if inAction || Task.isCancelled { break }
                        try? await Task.sleep(for: .seconds(1))
                    }
                }
            } catch is CancellationError {
                return
            } catch let error as APIError where error.status == 401 {
                api.token = nil
                user = nil
                reset()
                phase = .intro
                return
            } catch {
                failures += 1
                if driveMode { reconnecting = true }
                try? await Task.sleep(for: .seconds(min(30, 2 * failures)))
            }
        }
    }

    private var inAction: Bool { ride != nil || driveMode || driving.drive != nil || chatsOpen > 0 }

    // What the server just answered about the rider's ride (a check-in, say): shown at once, not at the next sync, which can fail on
    // a poor connection and then wait. Pieter, 8 November 2026: after checking in, it kept saying Pickup for a while.
    func use(_ fresh: Ride) {
        if ride?.id == fresh.id { ride = fresh }
        if showingRide?.id == fresh.id { showingRide = fresh }
    }

    func syncNow() async {
        do {
            let r: SyncResponse = try await api.get("/api/sync?rev=0")
            apply(r)
        } catch {}
    }

    private func apply(_ r: SyncResponse) {
        rev = r.rev
        if r.banned == true {
            applyStanding(r.standing)
            return
        }
        if phase == .banned {
            Task { await refreshMe() }
        }
        if let strikes = r.strikes, strikes != standing?.strikes {
            Task { await refreshMe() }
        }
        if let unread = r.unreadMessages {
            if unread > unreadMessages { say("message:\(Date().timeIntervalSince1970)", String(localized: "New message"), String(localized: "Open Drivezzz to read it.")) }
            unreadMessages = unread
        }
        let before = ride
        ride = r.ride
        if let d = r.driving {
            let hadOffer = driving.offer?.id
            let hadChecks = driving.checks
            driving = d
            if let offer = d.offer, offer.id != hadOffer { say("offer:\(offer.id)", String(localized: "New ride"), "\(Fmt.eur(offer.priceCents)) · \(Fmt.km(offer.distanceM))") }
            // Driving in the Netherlands changed (a person decided, or something needs attention): the driver again, for the blue
            // check, and said when there's no push to say it.
            if let checks = d.checks, let hadChecks, checks != hadChecks {
                Task { await loadDriver() }
                if let line = checks.attention {
                    say("checks:\(checks.status ?? ""):\(checks.again ?? ""):\(checks.open ?? 0)", String(localized: "Driving in the Netherlands"), line)
                } else if checks.status == "approved", hadChecks.status != "approved" {
                    say("checks:approved", String(localized: "You can drive in the Netherlands"), String(localized: "Your documents were checked."))
                }
            }
            if let drive = d.drive, drive.status == "riding" { say("checkin:\(drive.id)", String(localized: "Checked in"), String(localized: "You can drive.")) }
            // Put offline for not answering a ride: they stay so until they go online themselves.
            if d.putOffline == true {
                stopDriving(tellServer: false)
            } else if driveMode, d.online != true {
                // Drive mode is on but the server let us go: back online right away.
                nudge = true
            }
        }
        if let ride {
            // A driver accepted: straight to the screen to pay.
            if ride.status == "awaiting_payment", before?.status != "awaiting_payment" {
                say("pay:\(ride.id)", String(localized: "\(ride.driver?.name ?? String(localized: "A driver")) accepted your ride"), String(localized: "Pay within 5 minutes to confirm."))
                if mode == .rider, showingRide?.id != ride.id { showingRide = ride }
            }
            if ride.status == "accepted", before?.status != "accepted" { say("acc:\(ride.id)", String(localized: "Your driver is on the way"), ride.driver?.name ?? "") }
            if ride.driverLate == true { say("late:\(ride.id)", String(localized: "Your driver is late"), String(localized: "You can cancel for a full refund until you check in.")) }
            if ride.status == "arrived" { say("arr:\(ride.id)", String(localized: "Your driver is here"), String(localized: "Check the number plate, get in, then check in.")) }
            if ride.canCheckIn == true { say("near:\(ride.id)", String(localized: "Your driver is close"), String(localized: "Check in when you’re in the car."), alsoPushed: false) }
        }
        // A driver claimed a planned order: straight to the screen to pay, once. The ride itself is for later, so it's not `ride`.
        if let due = r.toPay {
            say("pay:\(due.id)", String(localized: "\(due.driver?.name ?? String(localized: "A driver")) accepted your ride"), String(localized: "Pay to confirm it."))
            if mode == .rider, showingRide == nil, askedToPay != due.id {
                askedToPay = due.id
                showingRide = due
            }
        }
        // A ride that just ended opens its page: rate the driver, or see why it was cancelled.
        if let before, ride == nil, before.isLive || before.isWaiting {
            Task {
                if let r: RideResponse = try? await api.get("/api/rides/\(before.id)"), r.ride.isOver, r.ride.cancelledBy != "rider" {
                    say("over:\(before.id)", r.ride.status == "completed" ? String(localized: "You’ve arrived") : String(localized: "Your ride was cancelled"), r.ride.status == "completed" ? String(localized: "\(r.ride.isCash ? String(localized: "Paid in cash. ") : "")How was your ride?") : (r.ride.cancelReason ?? ""))
                    showingRide = r.ride
                    if r.ride.status == "completed", r.ride.review == nil { reviewPrompt = r.ride.id }
                }
            }
        }
        if showingRide != nil, let fresh = [ride, driving.drive, driving.offer].compactMap({ $0 }).first(where: { $0.id == showingRide?.id }) { showingRide = fresh }
        // A planned ride or drive can start while the app shows the other side.
        if mode == .driver, driving.drive == nil, ride != nil {
            stopDriving()
            mode = .rider
            showingRide = nil
        } else if mode == .rider, ride == nil, driving.drive != nil {
            mode = .driver
            driverTab = 0
            showingRide = nil
        }
        updateBackgroundMode()
    }

    // A local notification, for when the app is running in the background. Once this phone has push the server
    // sends these itself, so only what it doesn't send is said here: otherwise they'd arrive twice.
    private func say(_ key: String, _ title: String, _ body: String, alsoPushed: Bool = true) {
        guard !notified.contains(key) else { return }
        notified.insert(key)
        guard !isActive, !(alsoPushed && sentPushToken != nil) else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: key, content: content, trigger: nil))
    }

    private func askForNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func pushToken(_ token: String) {
        #if DEBUG
        let env = "sandbox"
        #else
        let env = "production"
        #endif
        Task {
            struct Ack: Decodable { var pushOn: Bool? }
            guard let ack: Ack = try? await api.send("PATCH", "/api/me", ["pushToken": token, "pushEnv": env]) else { return }
            // Only a server that can push says things for us; otherwise the app keeps saying them itself.
            sentPushToken = ack.pushOn == true ? token : nil
        }
    }

    // ---------- sending our position ----------

    private var needsBackground: Bool {
        driveMode || ride?.isLive == true || driving.drive != nil
    }

    private func updateBackgroundMode() {
        let want = needsBackground
        if want != location.inBackgroundMode { location.setBackground(want) }
        if want { nudgeIfRideStarted() }
    }

    private var lastLiveRide: String?
    private func nudgeIfRideStarted() {
        let live = ride?.id ?? driving.drive?.id
        if live != lastLiveRide { lastLiveRide = live; nudge = true }
    }

    private func locationLoop() async {
        while !Task.isCancelled {
            nudge = false
            await resumeDriving()
            var wait = everySeconds
            if UserDefaults.standard.bool(forKey: "driveWanted"), !driveMode { wait = 10 }
            if api.token != nil, phase == .main, isActive || needsBackground, let here = location.location {
                do {
                    var body: [String: Any] = ["lat": here.coordinate.latitude, "lng": here.coordinate.longitude]
                    if here.course >= 0 { body["heading"] = here.course }
                    if here.speed >= 0 { body["speed"] = here.speed }
                    if driveMode { body["driving"] = true }
                    let r: LocationAnswer = try await api.post("/api/location", body)
                    reconnecting = false
                    everySeconds = r.every ?? 60
                    wait = everySeconds
                } catch is CancellationError {
                    return
                } catch {
                    // Reconnects by itself: tries again soon.
                    if driveMode { reconnecting = true }
                    wait = 10
                }
            } else if api.token != nil, location.location == nil {
                wait = 2
            }
            for _ in 0..<wait {
                if nudge || Task.isCancelled { break }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    func sendLocationNow() { nudge = true }

    // ---------- the driver's side ----------

    func loadDriver() async {
        if let r: OwnDriverResponse = try? await api.get("/api/driver") { driver = r.driver }
    }

    // You stay rider or driver until the ride or drive is over: why you can't switch, while that's so.
    var modeLock: String? {
        if mode == .rider, ride != nil { return String(localized: "You can switch to driving once this ride is over.") }
        if mode == .driver, driving.drive != nil { return String(localized: "You can switch to riding once this drive is over.") }
        return nil
    }

    func becomeDriver() async throws {
        let r: OwnDriverResponse = try await api.post("/api/driver/enable")
        driver = r.driver
        // A driver now, even if the refresh below doesn't get through: the tabs go by this, and without it the next switch would start over on My page.
        user?.isDriver = true
        await refreshMe()
        mode = .driver
    }

    // The driver has read that what the law asks where they drive is up to them. Drivezzz checks no licences.
    func rulesSeen() async {
        guard let r: OwnDriverResponse = try? await api.post("/api/driver/rules-seen") else { return }
        driver = r.driver ?? driver
    }

    @discardableResult
    func goOnline() async -> String? {
        // Asking for it counts, even before the first position or connection.
        UserDefaults.standard.set(true, forKey: "driveWanted")
        guard let here = location.location else { return String(localized: "We need your location to use this app.") }
        do {
            let r: OwnDriverResponse = try await api.post("/api/driver/online", ["lat": here.coordinate.latitude, "lng": here.coordinate.longitude])
            driver = r.driver ?? driver
            underReview = nil
            driveMode = true
            driveStartedAt = Date()
            DataMeter.shared.reset()
            everySeconds = 60
            updateBackgroundMode()
            // The position loop may be in a rider's 5-minute wait: without this, a phone put away right after going online
            // said nothing for that long, and the server takes a driver offline after 3 minutes without a position.
            nudge = true
            return nil
        } catch let e as APIError where e.code == "need_checks" {
            // A car in the Netherlands: the checks open instead of an error.
            UserDefaults.standard.set(false, forKey: "driveWanted")
            checksOpen = true
            return nil
        } catch let e as APIError where e.code == "checks_review" {
            // Everything's in and only a person looking is left (the car's plate, the documents): nothing to do in the checks, so it
            // says so plainly, with what can be done meanwhile (Pieter, 8 November 2026).
            UserDefaults.standard.set(false, forKey: "driveWanted")
            underReview = UnderReview(message: e.message, plate: e.extra["plate"] == 1, documents: e.extra["documents"] == 1)
            return nil
        } catch let e as APIError where e.status > 0 {
            UserDefaults.standard.set(false, forKey: "driveWanted")
            return e.message
        } catch {
            return error.localizedDescription
        }
    }

    // Comes back online by itself: after iOS ended the app, or when there was no connection or location yet.
    private func resumeDriving() async {
        guard !driveMode, !resuming, UserDefaults.standard.bool(forKey: "driveWanted"), user?.isDriver == true, api.token != nil, phase == .main else { return }
        resuming = true
        defer { resuming = false }
        await goOnline()
    }

    func stopDriving(tellServer: Bool = true) {
        UserDefaults.standard.set(false, forKey: "driveWanted")
        guard driveMode else { return }
        driveMode = false
        driveStartedAt = nil
        reconnecting = false
        updateBackgroundMode()
        if tellServer {
            Task {
                if let r: OwnDriverResponse = try? await api.post("/api/driver/offline") { driver = r.driver ?? driver }
                await syncNow()
            }
        }
    }

    func closingApp() {
        UserDefaults.standard.set(false, forKey: "driveWanted")
        guard driveMode else { return }
        api.fireAndWait("POST", "/api/driver/offline", seconds: 2)
    }
}

// What going online found waiting for a person: the server's words, and whether it's the car's plate, the documents or both.
struct UnderReview: Equatable {
    var message: String
    var plate: Bool
    var documents: Bool

    var title: String { plate && documents ? String(localized: "Under review") : plate ? String(localized: "Number plate under review") : String(localized: "Documents under review") }
}

struct LocationAnswer: Decodable {
    var every: Int?
    var online: Bool?
}
