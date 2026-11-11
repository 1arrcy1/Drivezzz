import MapKit
import SwiftUI

struct RidesView: View {
    @Environment(AppState.self) private var app
    @State private var rides: [Ride] = []
    @State private var tab = 0
    @State private var loaded = false
    @State private var renaming: SavedRoute?
    @State private var newName = ""
    private let saved = SavedRoutes.shared

    private var list: [Ride] {
        switch tab {
        case 0: rides.filter { ($0.isLive || $0.isWaiting) && !($0.status == "open" && $0.scheduledAt != nil) }
        case 1: rides.filter { $0.status == "scheduled" || ($0.status == "open" && $0.scheduledAt != nil) }
        default: rides.filter(\.isOver)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Rides", selection: $tab) {
                        Text("Current").tag(0)
                        Text("Booked").tag(1)
                        Text("Completed").tag(2)
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                }
                if tab == 1 { savedRoutes }
                if list.isEmpty, loaded {
                    Section {
                        ContentUnavailableView(tab == 0 ? String(localized: "No ride right now") : tab == 1 ? String(localized: "Nothing booked") : String(localized: "No rides yet"),
                                               systemImage: tab == 0 ? "car.fill" : tab == 1 ? "calendar" : "checkmark.seal",
                                               description: Text(tab == 0 ? String(localized: "Where you’re going starts on Home.") : tab == 1 ? String(localized: "Plan a ride on Home, up to a week ahead.") : String(localized: "Your finished rides show here.")))
                            .listRowBackground(Color.clear)
                    }
                }
                Section {
                    ForEach(list) { ride in
                        NavigationLink(value: ride) { RideRow(ride: ride) }
                    }
                }
            }
            .navigationTitle("Rides")
            .navigationDestination(for: Ride.self) { RideDetailView(ride: $0) }
            .task(id: app.rev) { await load() }
            .refreshable { await load() }
            .alert("Rename this route", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
                TextField("Name", text: $newName)
                Button("Save") { if let renaming { saved.rename(renaming, to: newName) } }
                Button("Cancel", role: .cancel) { }
            }
        }
    }

    // A tap fills in Home, with the price of right now.
    private var savedRoutes: some View {
        Section {
            ForEach(saved.routes) { route in
                Button {
                    app.routeToUse = route
                    app.riderTab = 0
                } label: { SavedRouteRow(route: route) }
                .buttonStyle(.plain)
                .swipeActions {
                    Button("Delete", role: .destructive) { saved.remove(route) }
                    Button("Rename") { newName = route.name; renaming = route }.tint(Theme.accent)
                }
            }
        } header: {
            Text("Saved routes")
        } footer: {
            if saved.routes.isEmpty { Text("Tap the bookmark on a route on Home to keep it here, with a name. A ride’s page can save its route too.") }
        }
    }

    private func load() async {
        if let r: RidesResponse = try? await APIClient.shared.get("/api/rides") { rides = r.rides ?? [] }
        loaded = true
    }
}

struct SavedRouteRow: View {
    var route: SavedRoute

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "bookmark.fill").font(.subheadline).foregroundStyle(Theme.accentInk).frame(width: 40, height: 40).background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(route.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Text("\(route.pickup.label ?? String(localized: "Pickup")) to \(route.dropoff.label ?? String(localized: "drop-off"))").font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.faint)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }
}

struct RideRow: View {
    var ride: Ride

    private var when: Date? {
        (ride.scheduledAt ?? ride.checkedOutAt ?? ride.createdAt).map { Date(ms: $0) }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            CarTile(car: ride.driver?.car, size: 46)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline) {
                    Text(ride.dropoff.label ?? String(localized: "Drop-off")).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer()
                    Text(Fmt.eur(ride.shownPriceCents)).font(.system(size: 16, weight: .bold)).kerning(-0.2).foregroundStyle(Theme.ink)
                }
                Text("From \(ride.pickup.label ?? String(localized: "pickup"))").font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                HStack(spacing: 6) {
                    StatusPill(text: ride.statusTitle, ride: ride)
                    if let when { Text("\(Fmt.dayTime(when))\(ride.isCash && ride.status == "completed" ? String(localized: " · Paid in cash") : "")").font(.caption).foregroundStyle(Theme.faint).lineLimit(1) }
                }
                .padding(.top, 3)
            }
        }
        .padding(.vertical, 4)
    }
}

// A ride's page, for the rider and for the driver afterwards.
struct RideDetailView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var ride: Ride
    @State private var working = false
    @State private var error: String?
    @State private var showCheckIn = false
    @State private var showReview = false
    @State private var showAppeal = false
    @State private var adding: Int?         // what the rider is asked to confirm adding to the order
    @State private var showDriver = false
    @State private var namingRoute = false
    @State private var routeName = ""
    @State private var steadyDriver = SteadyCar()   // your driver's car: still for GPS wobble, gliding for a real move

    private var isRider: Bool { ride.role != "driver" }

    var body: some View {
        List {
            if !ride.isOver {
                Section {
                    mapView
                        .frame(height: 210)
                        .listRowInsets(EdgeInsets())
                }
            }
            Section { header }
            if isRider, RideStateCard.shows(ride) {
                Section { RideStateCard(ride: ride) { fresh in ride = fresh } }
            }
            if ride.needsPayment, isRider {
                Section { PayRideCard(ride: ride) }
            }
            if ride.status == "open", isRider { openOrder }
            if let d = ride.driver, isRider { driverSection(d) }
            if let other = otherPerson, !isRider {
                Section {
                    NavigationLink { ChatScreen(userId: other.id, name: other.name) } label: {
                        Label("Message \(other.name)", systemImage: "bubble.left")
                    }
                }
            }
            routeSection
            if isRider, !SavedRoutes.shared.has(pickup: ride.pickup, dropoff: ride.dropoff) {
                Section {
                    Button { namingRoute = true } label: { Label("Save this route", systemImage: "bookmark") }
                }
            }
            if let error { Section { Text(error).font(.footnote).foregroundStyle(Theme.danger) } }
            afterRide
            if isRider, RideCancelButton.shows(ride) {
                Section {
                    RideCancelButton(ride: ride) { fresh in ride = fresh }
                }
            }
        }
        .navigationTitle(isRider ? String(localized: "Your ride") : String(localized: "Your drive"))
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
        .toolbar {
            if app.showingRide != nil { ToolbarItem(placement: .cancellationAction) { Button("Close") { app.showingRide = nil; dismiss() } } }
            if let other = otherPerson { ToolbarItem(placement: .primaryAction) { PersonMenu(userId: other.id, name: other.name, rideId: ride.id, canReportDropoff: !isRider) } }
        }
        .escrowMoment(status: isRider ? ride.status : nil, price: Fmt.eur(ride.shownPriceCents), coin: ride.coin)
        .onAppear { app.rideOnScreen = ride.id }
        .onDisappear { if app.rideOnScreen == ride.id { app.rideOnScreen = nil } }
        .sheet(isPresented: $showCheckIn, onDismiss: { app.dismissedCheckIn = ride.id }) { CheckInView(ride: ride) { ride = $0 } }
        .alert("Save this route", isPresented: $namingRoute) {
            TextField("Like Home to work", text: $routeName)
            Button("Save") {
                SavedRoutes.shared.add(name: routeName, pickup: ride.pickup, dropoff: ride.dropoff)
                routeName = ""
            }
            Button("Cancel", role: .cancel) { routeName = "" }
        } message: {
            Text("It keeps the pickup and the drop-off. Find it in Rides, under Booked. It stays on this phone.")
        }
        .safeAreaInset(edge: .bottom) {
            if isRider, ride.status == "accepted" || ride.status == "arrived" {
                checkInButton
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(.bar)
            }
        }
        .onChange(of: ride.canCheckIn) { _, can in openCheckInIfClose(can) }
        .onAppear { openCheckInIfClose(ride.canCheckIn) }
        .sheet(isPresented: $showReview) { ReviewSheet(ride: $ride).presentationDetents([.medium]) }
        .onAppear { askForReview() }
        .onChange(of: app.reviewPrompt) { _, _ in askForReview() }
        .sheet(isPresented: $showAppeal) { AppealSheet(ride: $ride).presentationDetents([.medium]) }
        .alert(adding.map { String(localized: "Add \(Fmt.eur($0)) to your order?") } ?? "", isPresented: Binding(get: { adding != nil }, set: { if !$0 { adding = nil } }), presenting: adding) { extra in
            Button("Add \(Fmt.eur(extra))") { Task { await raise((ride.maxCents ?? 0) + extra) } }
            Button("Not now", role: .cancel) {}
        } message: { extra in
            Text("Your order will be \(Fmt.eur((ride.maxCents ?? 0) + extra)).")
        }
        .sheet(isPresented: $showDriver) {
            if let id = ride.driver?.id { NavigationStack { DriverProfileView(driverId: id) } }
        }
        .task(id: app.rev) { await refresh() }
        .onChange(of: [ride.driver?.lat, ride.driver?.lng], initial: true) { _, _ in steadyDriver.follow(ride.driver?.coordinate, ride: ride.id) }
        .task(id: ride.status) {
            // A payment shows up on the chain without the app having to be told.
            guard ride.status == "awaiting_payment" else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(8))
                await refresh()
            }
        }
    }

    // The ride that just ended asks for a review, once. Dismissed, it stays available on this page.
    private func askForReview() {
        guard isRider, app.reviewPrompt == ride.id else { return }
        app.reviewPrompt = nil
        Task {
            await refresh()
            if ride.review == nil { showReview = true }
        }
    }

    private var otherPerson: (id: String, name: String)? {
        if isRider, let d = ride.driver { return (d.id, d.name ?? String(localized: "your driver")) }
        if !isRider, let r = ride.rider { return (r.id, r.name ?? String(localized: "your rider")) }
        return nil
    }

    // Opens by itself when the driver is close. Dismissed, it stays closed; the button brings it back.
    private func openCheckInIfClose(_ can: Bool?) {
        if isRider, can == true, app.dismissedCheckIn != ride.id, !showCheckIn { showCheckIn = true }
    }

    private var mapView: some View {
        Map(initialPosition: .automatic) {
            let line = ride.route
            if !line.isEmpty {
                MapPolyline(coordinates: line).stroke(Theme.routeEdge, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: line).stroke(Theme.route, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            }
            Marker("Pickup", systemImage: "figure.wave", coordinate: ride.pickup.coordinate).tint(Theme.pickupPin)
            Marker("Drop-off", systemImage: "flag.fill", coordinate: ride.dropoff.coordinate).tint(Theme.accent)
            if isRider, let c = steadyDriver.spot ?? ride.driver?.coordinate {
                Annotation(ride.driver?.car?.shownPlate ?? String(localized: "Driver"), coordinate: c, anchor: .center) { DriverPin(vehicle: ride.driver?.car?.kind, eta: ride.etaShort) }
            }
            if ["searching", "offered", "open"].contains(ride.status) {
                Annotation("", coordinate: ride.pickup.coordinate, anchor: .center) { Radar(size: 120) }.annotationTitles(.hidden)
            }
            UserAnnotation()
        }
        .mapStyle(.drivezzz())
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(isRider ? ride.statusTitle : DrivesView.driverStatus(ride)).font(.title2.weight(.bold)).kerning(-0.4).foregroundStyle(Theme.ink)
            Group {
                switch ride.status {
                case "searching", "offered": EmptyView()
                case "awaiting_payment": if !isRider { Text("You can start driving to the pickup.") }
                case "accepted":
                    if ride.driverLate == true { Text((ride.apartM ?? ride.driverToPickupM).map { String(localized: "\(Fmt.km($0)) from you") } ?? String(localized: "See on the map where they are.")) } else if let eta = ride.pickupEtaAt { Text("Around \(Fmt.time(ServerClock.date(eta)))\((ride.driverToPickupM ?? ride.apartM).map { " · \(Fmt.km($0)) away" } ?? "")").monospacedDigit() }
                case "arrived": Text("Check the number plate, get in, then check in.")
                case "scheduled": if let s = ride.scheduledAt { Text("Pickup \(Fmt.dayTime(Date(ms: s)))") }
                case "open":
                    let paying = ride.isCash ? String(localized: "You pay your driver in cash.") : ride.scheduledAt == nil ? String(localized: "You pay once one claims it.") : String(localized: "You pay once a driver claims it.")
                    if let s = ride.scheduledAt { Text("Pickup \(Fmt.dayTime(Date(ms: s))). \(paying)") } else { Text("Drivers nearby can see your order. \(paying)") }
                case "cancelled": Text(cancelLine)
                case "completed":
                    if let at = ride.checkedOutAt { Text(Fmt.dayTime(Date(ms: at))) }
                    if ride.isCash { Text("Paid in cash").fontWeight(.semibold).foregroundStyle(Theme.ok) }
                default: EmptyView()
                }
            }
            .font(.subheadline)
            .foregroundStyle(Theme.muted)
            if !ride.isOver { RideSteps(ride: ride).padding(.top, 8) }
        }
    }

    private var cancelLine: String {
        var s = ride.cancelledBy == "driver" ? String(localized: "Your driver cancelled.") : ride.cancelledBy == "rider" ? String(localized: "You cancelled.") : String(localized: "Cancelled by Drivezzz.")
        if !isRider { s = ride.cancelledBy == "driver" ? String(localized: "You cancelled.") : String(localized: "Cancelled.") }
        if let r = ride.cancelReason { s += " \(Fmt.reason(r))." }
        if isRider, ride.escrow != nil { s += ride.escrow?.outcome == "split" ? String(localized: " Half goes back to your wallet.") : String(localized: " Everything goes back to your wallet.") }
        return s
    }

    private func driverSection(_ d: RideDriver) -> some View {
        Section("Your driver") {
            Button { showDriver = true } label: {
                HStack(spacing: 12) {
                    CarTile(car: d.car)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(d.name ?? String(localized: "Your driver")).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        RatingLabel(rating: d.rating, count: d.ratingCount)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.faint)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if let car = d.car {
                LabeledContent(Fmt.carWithColour(car.colorName, car.title)) {
                    PlateView(plate: car.shownPlate, size: 15)
                }
                .font(.subheadline)
            }
            if !ride.isOver {
                MessageButton(userId: d.id, name: d.name ?? String(localized: "your driver"), big: true)
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
            } else {
                NavigationLink { ChatScreen(userId: d.id, name: d.name ?? String(localized: "your driver")) } label: {
                    Label("Message \(d.name ?? String(localized: "your driver"))", systemImage: "bubble.left")
                }
            }
        }
    }

    private var routeSection: some View {
        Section {
            Label(ride.pickup.label ?? String(localized: "Pickup"), systemImage: "circle.fill").labelStyle(RouteLabel(tint: Theme.pickupPin))
            Label(ride.dropoff.label ?? String(localized: "Drop-off"), systemImage: "flag.fill").labelStyle(RouteLabel())
            LabeledContent("Distance", value: "\(Fmt.km(ride.distanceM)) · \(Fmt.minutes(ride.durationS))").font(.subheadline)
            LabeledContent("Price") {
                VStack(alignment: .trailing, spacing: 1) {
                    Text(Fmt.eur(ride.shownPriceCents)).fontWeight(.semibold).foregroundStyle(Theme.ink)
                    // The amount in the coin is only fixed when it's paid.
                    Text(priceNote).font(.caption).foregroundStyle(Theme.faint)
                }
            }
            .font(.subheadline)
            if let e = ride.escrow {
                LabeledContent(e.status == "settled" ? String(localized: "Escrow") : String(localized: "In escrow")) {
                    if let raw = e.settleExplorer ?? e.explorer, let url = URL(string: raw) {
                        Link(escrowState(e), destination: url).foregroundStyle(Theme.accentInk)
                    } else {
                        Text(escrowState(e)).foregroundStyle(Theme.muted)
                    }
                }
                .font(.footnote)
                if ride.role == "driver", let part = e.driverAmount {
                    Text("You get \(Fmt.amount(part, Fmt.coinSymbol(e.coin))).")
                        .font(.caption)
                        .foregroundStyle(Theme.faint)
                }
            }
            if ride.checkoutWarning == true {
                Label(isRider ? String(localized: "Heads-up: your phone wasn’t within 500 m of the drop-off when you were checked out. If you were dropped off correctly, you can ignore this. If not, you have 24 hours to appeal.") : String(localized: "Heads-up: the rider’s phone wasn’t within 500 m of the drop-off at check-out. If you dropped them off correctly, you can ignore this. They have 24 hours to appeal."), systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
            }
        }
    }

    private var priceNote: String {
        if ride.isCash { return ride.status == "completed" ? String(localized: "Paid in cash") : String(localized: "in cash") }
        return ride.coinAmount.map { Fmt.amount($0, Fmt.coinSymbol(ride.coin)) } ?? String(localized: "in \(Fmt.coinSymbol(ride.coin))")
    }

    private func escrowState(_ e: RideEscrow) -> String {
        if e.onHold == true, e.status == "paid" { return String(localized: "On hold: being checked") }
        return switch (e.status, e.outcome) {
        case ("settled", "payout"): String(localized: "Paid out")
        case ("settled", "split"): String(localized: "Split 50/50")
        case ("settled", _): String(localized: "Refunded")
        case (_, "payout"): e.settleAfter.map { String(localized: "Pays out \(Fmt.dayTime(Date(ms: $0)))") } ?? String(localized: "Paying out")
        case (_, "split"): e.settleAfter.map { String(localized: "Splits 50/50 \(Fmt.dayTime(Date(ms: $0)))") } ?? String(localized: "Splits 50/50 soon")
        case (_, "refund"), (_, "expired"): String(localized: "Refunding")
        default: String(localized: "\(Fmt.amount(e.amount, Fmt.coinSymbol(e.coin))) held")
        }
    }

    private var openOrder: some View {
        Section("Nobody took it yet? Offer more") {
            HStack(spacing: 8) {
                ForEach([100, 200, 500], id: \.self) { extra in
                    Button("+\(Fmt.eur(extra))") { adding = extra }
                        .buttonStyle(GhostButtonStyle(height: 40))
                        .disabled(working)
                }
            }
        }
    }

    private var checkInButton: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button("Check in") { showCheckIn = true }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(ride.canCheckIn != true)
            if ride.canCheckIn != true {
                Text("You can check in within 100 m of your driver.").font(.footnote).foregroundStyle(Theme.faint)
            }
        }
    }

    @ViewBuilder
    private var afterRide: some View {
        if ride.status == "completed" {
            Section {
                if isRider {
                    if let review = ride.review {
                        LabeledContent("Your review") { Stars(rating: review.stars ?? 0) }
                    } else {
                        Button { showReview = true } label: { Label("Rate your driver", systemImage: "star").foregroundStyle(Theme.accentInk) }
                    }
                } else if let p = ride.payout, !ride.isCash {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(payoutTitle(p)).font(.subheadline.weight(.semibold))
                        if p.status == "held", let due = p.dueAt { Text("Paid to your wallet around \(Fmt.dayTime(Date(ms: due))), if no one appeals.").font(.footnote).foregroundStyle(Theme.muted) }
                        if let tx = p.txid { Text(Fmt.shortAddress(tx)).font(.caption.monospaced()).foregroundStyle(Theme.faint) }
                    }
                }
                if let s = ride.syncScore, !isRider { LabeledContent("You and your rider together", value: "\(Int(s * 100))%").font(.footnote) }
            }
        }
        if ride.isOver {
            if let d = ride.dispute {
                Section {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(d.status == "open" ? String(localized: "Appeal being looked at") : d.status == "closed" ? String(localized: "Appeal closed") : d.status == "refund_rider" ? String(localized: "Appeal decided: rider refunded") : String(localized: "Appeal decided: driver paid")).font(.subheadline.weight(.semibold))
                        if let a = d.answer { Text(a).font(.footnote).foregroundStyle(Theme.muted) }
                    }
                }
            } else if canAppeal {
                Section {
                    Button { showAppeal = true } label: { Label("Something went wrong", systemImage: "exclamationmark.bubble") }
                } footer: {
                    if isRider, let due = ride.payout?.dueAt { Text("You can appeal until \(Fmt.dayTime(Date(ms: due))).") }
                }
            }
        }
    }

    private var canAppeal: Bool {
        // Cash has no escrow to wait on: 24 hours after check-out, to reach a person.
        if ride.isCash { return ride.status == "completed" && (ride.payout?.dueAt).map { ServerClock.date($0) > Date() } == true }
        // A rider who cancelled paid half: a driver who touched the pickup and left can be appealed, while the money still waits.
        if isRider && ride.status == "cancelled" { return ride.escrow?.outcome == "split" && ride.escrow?.status == "paid" }
        if isRider { return ride.payout?.status == "held" }
        return true
    }

    private func payoutTitle(_ p: RidePayout) -> String {
        switch p.status {
        case "held": String(localized: "Payout waiting 24 hours")
        case "queued", "sending", "sent": String(localized: "Payout on its way")
        case "confirmed": String(localized: "Paid out")
        case "demo": String(localized: "Demo ride: no real payout")
        case "cancelled": String(localized: "Not paid: refunded to the rider")
        default: String(localized: "Payout being checked")
        }
    }

    private func refresh() async {
        if let r: RideResponse = try? await APIClient.shared.get("/api/rides/\(ride.id)") { ride = r.ride }
    }

    private func raise(_ cents: Int) async {
        working = true
        error = nil
        defer { working = false }
        do {
            let r: RideResponse = try await APIClient.shared.post("/api/rides/\(ride.id)/bid", ["bidCents": cents])
            ride = r.ride
        } catch { self.error = error.localizedDescription }
    }
}

// What's going on with the order and what cancelling does right now, in words, for the rider.
struct RideStateCard: View {
    var ride: Ride
    var onCancelled: (Ride) -> Void = { _ in }

    static func shows(_ ride: Ride) -> Bool {
        if ["searching", "offered"].contains(ride.status) { return true }
        if ride.status == "awaiting_payment" { return ride.scheduledAt == nil }
        return ["accepted", "arrived"].contains(ride.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            switch ride.status {
            case "searching", "offered":
                if let until = ride.offeredUntil {
                    HStack {
                        Text("Time left").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        Spacer()
                        Countdown(until: until)
                    }
                }
                line(String(localized: "You can still cancel, for free."))
            case "awaiting_payment":
                eta
                line(String(localized: "You can still cancel, for free."))
            default:
                if ride.status == "accepted" { eta }
                if ride.isCash {
                    line(String(localized: "You pay \(Fmt.eur(ride.shownPriceCents)) in cash, in the car. You can still cancel, for free."))
                } else if ride.driverLate == true {
                    Text(ride.status == "arrived" ? String(localized: "Your driver came late") : String(localized: "Your driver is late")).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ok)
                    line(ride.status == "arrived"
                         ? String(localized: "You can cancel for a full refund until you check in.")
                         : String(localized: "You can cancel for a full refund until you check in. Check the map first: if your driver is clearly coming, we recommend waiting."))
                    RideCancelButton(ride: ride, onDone: onCancelled)
                } else if ride.refundPercent == 100, let until = ride.freeCancelUntil {
                    line(String(localized: "Free to cancel until \(Fmt.time(ServerClock.date(until)))."))
                } else if ride.status == "arrived" {
                    line(String(localized: "Check in once you’re inside the car. Cancelling now gives 50% back."))
                } else if let by = ride.pickupDeadlineAt {
                    line(String(localized: "Cancelling now gives 50% back. If your driver isn’t here by \(Fmt.time(ServerClock.date(by))), you get everything back."))
                }
            }
        }
    }

    @ViewBuilder
    private var eta: some View {
        if let text = ride.etaLine {
            Label(text, systemImage: "car.fill").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accentInk)
        }
    }

    private func line(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
    }
}

// Cancelling, for the rider: asks first, and says what comes back. Green when the driver is late, as it's a full refund then.
struct RideCancelButton: View {
    @Environment(AppState.self) private var app
    var ride: Ride
    var onDone: (Ride) -> Void = { _ in }
    @State private var asking = false
    @State private var working = false
    @State private var error: String?

    // A late driver's is on the state card, in green, right under what it means.
    static func shows(_ ride: Ride) -> Bool {
        ["searching", "awaiting_payment", "offered", "open", "scheduled", "accepted", "arrived"].contains(ride.status) && ride.driverLate != true
    }

    private var message: String {
        if ride.driverLate == true { return String(localized: "Your driver is late, so everything goes back to the wallet you paid with, and your driver gets nothing.") }
        if ride.refundPercent == 50 { return String(localized: "50% goes back to your wallet and your driver gets the other 50%.") }
        if ride.status == "scheduled", let until = ride.freeCancelUntil {
            return String(localized: "Free until \(Fmt.dayTime(ServerClock.date(until))): everything goes back to your wallet. After that, 50% goes to your driver.")
        }
        if ride.escrow?.status == "paid" { return String(localized: "Everything goes back to the wallet you paid with.") }
        return String(localized: "You haven’t paid anything: cancelling is free.")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if ride.driverLate == true {
                Button("Cancel for a full refund") { asking = true }
                    .buttonStyle(PrimaryButtonStyle(color: Theme.okFill, textColor: .white))
            } else {
                Button(["searching", "offered", "open"].contains(ride.status) ? String(localized: "Cancel order") : String(localized: "Cancel ride")) { asking = true }
                    .buttonStyle(GhostButtonStyle(height: 48, color: Theme.danger))
            }
            ErrorText(text: error)
        }
        .disabled(working)
        .confirmationDialog("Cancel this ride?", isPresented: $asking, titleVisibility: .visible) {
            Button("Cancel ride", role: .destructive) { Task { await cancel() } }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text(message)
        }
    }

    private func cancel() async {
        working = true
        error = nil
        defer { working = false }
        do {
            let r: RideResponse = try await APIClient.shared.post("/api/rides/\(ride.id)/cancel")
            onDone(r.ride)
            await app.syncNow()
        } catch { self.error = error.localizedDescription }
    }
}

// Which wallet pays: it opens with the payment ready to approve, then comes back here.
struct PayWalletSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    var ride: Ride
    var onSent: () -> Void
    @State private var error: String?
    @State private var missingApp: Wallets.App?
    private var wallets: Wallets { Wallets.shared }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    VStack(alignment: .leading, spacing: 10) {
                        if let amount = ride.payAmount {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(Fmt.coinAmount(amount, ride.coin)).font(.title2.weight(.bold).monospacedDigit()).foregroundStyle(Theme.ink)
                                Text("\(Fmt.eur(ride.shownPriceCents)) in value\(ride.eurPerCoin.map { String(localized: " · 1 \(Fmt.coinSymbol(ride.coin)) is \(Fmt.eurPrice($0))") } ?? "")")
                                    .font(.subheadline.monospacedDigit()).foregroundStyle(Theme.muted)
                            }
                        }
                        Text("Pick the wallet with the money. It opens with the payment ready: approve it there, then come back. Refunds go back to this wallet.")
                            .font(.subheadline)
                            .foregroundStyle(Theme.muted)
                        ChainQueueNote()
                    }
                }
                // Up here: below the wallets and the code it would be out of sight.
                if let error { Section { Text(error).font(.subheadline).foregroundStyle(Theme.danger) } }
                if let missingApp, let store = missingApp.store.flatMap(URL.init(string:)) {
                    Section { Button("Get \(missingApp.name) in the App Store") { openURL(store) } }
                }
                if wallets.waitingFor != nil {
                    WalletWaitingSections()
                } else {
                    Section("Pay with") {
                        ForEach(Wallets.apps) { wallet in
                            WalletAppRow(wallet: wallet) { Task { await pay(wallet) } }
                        }
                    }
                    if let raw = ride.payUrl, let url = URL(string: raw) {
                        Section {
                            QRCode(text: raw, size: 170).frame(maxWidth: .infinity).padding(.vertical, 6)
                            Button { openURL(url) } label: { Label("Open as a Solana Pay link", systemImage: "arrow.up.forward.app") }
                        } header: {
                            Text("Or with Solana Pay")
                        } footer: {
                            Text("Scan it with a wallet on another device. The link opens whichever wallet your iPhone picks.")
                        }
                    }
                }
            }
            .navigationTitle("Pay \(Fmt.eur(ride.shownPriceCents))")
            .navigationBarTitleDisplayMode(.inline)
            .foregroundStyle(Theme.ink)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { wallets.stopWaiting(); dismiss() } } }
        }
    }

    private func pay(_ wallet: Wallets.App) async {
        error = nil
        missingApp = nil
        do {
            try await wallets.pay(rideId: ride.id, with: wallet, network: ride.network)
            onSent()
            dismiss()
        } catch is CancellationError {
        } catch let failure as WalletFailure {
            error = failure.errorDescription
            if case .notInstalled = failure { missingApp = wallet }
        } catch let failure as WalletConnectClient.Failure {
            if failure.errorDescription != String(localized: "Stopped.") {
                error = failure.errorDescription
                if failure.errorDescription?.contains(String(localized: "isn’t on this phone")) == true { missingApp = wallet }
            }
        } catch { self.error = error.localizedDescription }
    }
}

private struct RouteLabel: LabelStyle {
    var tint: Color = Theme.accentInk
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            configuration.icon.font(.system(size: 9)).foregroundStyle(tint).frame(width: 14)
            configuration.title.font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
        }
    }
}

// When the Solana connection is busy, the server lines up what it asks the network (server/src/rpcqueue.js), riders paying first,
// so a payment can wait its turn: this says so, and about how long. It asks the server every few seconds while it's on screen,
// which costs nothing on the network. Nothing shows while there's no line.
struct ChainQueueNote: View {
    @State private var queue: ChainQueue?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 0)
            if let s = queue?.seconds, s >= 3 {
                NoteBox(symbol: "hourglass", tint: Theme.warn, background: Theme.warnSoft,
                        text: String(localized: "Busy on Solana right now: payments wait in a queue, about \(Self.wait(s)). Yours goes through by itself when it’s its turn, so keep Drivezzz open."))
            }
        }
        .animation(.easeOut(duration: 0.2), value: (queue?.seconds ?? 0) >= 3)
        .task {
            while !Task.isCancelled {
                if let q: ChainQueue = try? await APIClient.shared.get("/api/chain/queue") { queue = q }
                try? await Task.sleep(for: .seconds(4))
            }
        }
    }

    static func wait(_ seconds: Int) -> String {
        if seconds < 60 { return String(localized: "\(seconds) seconds") }
        let minutes = Int((Double(seconds) / 60).rounded(.up))
        return minutes == 1 ? String(localized: "a minute") : String(localized: "\(minutes) minutes")
    }
}

// Paying a ride once a driver has it: the rider picks a wallet app, which opens with the payment ready to approve. The
// money waits in the ride's own escrow on Solana until the ride is done; refunds go back to that wallet.
struct PayRideCard: View {
    @Environment(AppState.self) private var app
    var ride: Ride
    @State private var choosing = false
    @State private var sent = false
    @State private var testPayError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top) {
                // What you pay in the coin, and what that's worth (Pieter, 8 November 2026: clearly, both).
                VStack(alignment: .leading, spacing: 2) {
                    if let amount = ride.payAmount {
                        Text(Fmt.coinAmount(amount, ride.coin)).font(.system(size: 34, weight: .bold).monospacedDigit()).kerning(-0.8).foregroundStyle(Theme.ink)
                            .lineLimit(1).minimumScaleFactor(0.6)
                        Text("\(Fmt.eur(ride.shownPriceCents)) in value").font(.title3.weight(.semibold).monospacedDigit()).foregroundStyle(Theme.ink)
                    } else {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(Fmt.eur(ride.shownPriceCents)).font(.system(size: 40, weight: .bold)).kerning(-1).foregroundStyle(Theme.ink)
                            Text("in \(Fmt.coinSymbol(ride.coin))").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.muted)
                        }
                    }
                }
                Spacer(minLength: 8)
                if let by = ride.payBy {
                    if ride.scheduledAt == nil {
                        Countdown(until: by, redBelow: 120)
                    } else {
                        Text("Pay by \(Fmt.dayTime(ServerClock.date(by)))").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accentInk)
                    }
                }
            }
            if ride.payAmount != nil, let rate = ride.eurPerCoin {
                Text("1 \(Fmt.coinSymbol(ride.coin)) is \(Fmt.eurPrice(rate)) now. Your wallet asks for the exact amount, at the price when you pay.")
                    .font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
            payButton
            ChainQueueNote()
            if sent {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Sent. Waiting for it on the chain…").font(.footnote).foregroundStyle(Theme.muted)
                }
            }
            VStack(alignment: .leading, spacing: 6) {
                note("lock.shield.fill", String(localized: "Held in escrow on Solana until your ride is done."))
                note("arrow.uturn.backward.circle.fill", ride.scheduledAt != nil ? String(localized: "Free to cancel until 3 hours before.") : String(localized: "Once you’ve paid, cancelling gives 50% back, or everything if your driver is late."))
                note("bolt.fill", String(localized: "Network fee about €0.001, plus a small deposit (about €0.20) that comes back to you."))
            }
        }
        .sheet(isPresented: $choosing) {
            PayWalletSheet(ride: ride) {
                sent = true
                Task { await app.syncNow() }
            }
        }
    }

    @ViewBuilder
    private var payButton: some View {
        #if DEBUG
        // Only a debug build can reach a test server, and only a test server says this.
        if ride.testPay == true {
            Button {
                testPayError = nil
                Task {
                    do {
                        try await APIClient.shared.call("POST", "/api/rides/\(ride.id)/pretend-pay")
                        sent = true
                    } catch { testPayError = error.localizedDescription }
                    await app.syncNow()
                }
            } label: { Text("Pay (test, no real money)") }
            .buttonStyle(PrimaryButtonStyle())
            ErrorText(text: testPayError)
        } else {
            walletButton
        }
        #else
        walletButton
        #endif
    }

    private var walletButton: some View {
        Button { choosing = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "wallet.pass.fill")
                Text(sent ? String(localized: "Pay again") : String(localized: "Pay with your wallet"))
            }
        }
        .buttonStyle(PrimaryButtonStyle())
    }

    private func note(_ symbol: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: symbol).font(.caption).foregroundStyle(Theme.accentInk).frame(width: 16)
            Text(text).font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
        }
    }
}

// Opens by itself when the driver is within 100 m.
struct CheckInView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    var ride: Ride
    var onDone: (Ride) -> Void = { _ in }
    @State private var working = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 18) {
            HStack {
                Spacer()
                Button("Not yet") { dismiss() }.font(.subheadline.weight(.semibold))
            }
            Text("Check the number plate").font(.system(size: 28, weight: .bold)).kerning(-0.5).foregroundStyle(Theme.ink).multilineTextAlignment(.center)
            PlateView(plate: ride.driver?.car?.shownPlate ?? "", size: 30)
            if let car = ride.driver?.car {
                Text(Fmt.carWithColour(car.colorName, car.title)).font(.headline).foregroundStyle(Theme.muted)
                CarGallery(car: car, height: 150)
            }
            if let name = ride.driver?.name { Text("Your driver is \(name)").font(.subheadline).foregroundStyle(Theme.muted) }
            Spacer()
            Label("Only check in when you’re \(Vehicle.riding(ride.driver?.car?.kind)).", systemImage: "exclamationmark.triangle")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.ink)
            ErrorText(text: error)
            Button { Task { await checkIn() } } label: {
                if working { ProgressView().tint(Theme.onAccent) } else { Text("I’m \(Vehicle.riding(ride.driver?.car?.kind)): check in") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(working)
        }
        .padding(22)
    }

    private func checkIn() async {
        guard let here = LocationService.shared.location?.coordinate else {
            error = String(localized: "We need your location to check in.")
            return
        }
        working = true
        error = nil
        defer { working = false }
        do {
            let r: RideResponse = try await APIClient.shared.post("/api/rides/\(ride.id)/check-in", ["lat": here.latitude, "lng": here.longitude, "plateChecked": true])
            // Riding, straight from the answer.
            app.use(r.ride)
            onDone(r.ride)
            dismiss()
            await app.syncNow()
        } catch { self.error = error.localizedDescription }
    }
}

struct ReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var ride: Ride
    @State private var stars = 5
    @State private var text = ""
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                ScreenTitle(title: String(localized: "How was your ride?"), subtitle: String(localized: "Your review shows on your driver’s profile."))
                Spacer()
                Button("Not now") { dismiss() }.font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accentInk)
            }
            HStack(spacing: 10) {
                ForEach(1...5, id: \.self) { i in
                    Button { stars = i } label: {
                        Image(systemName: "star.fill").font(.system(size: 36)).foregroundStyle(i <= stars ? Theme.route : Theme.line).scaleEffect(i == stars ? 1.08 : 1).animation(.spring(response: 0.25, dampingFraction: 0.6), value: stars)
                    }
                    .accessibilityLabel("\(i) stars")
                }
            }
            TextField("Anything to add? (optional)", text: $text, axis: .vertical).lineLimit(3...5).fieldStyle()
            ErrorText(text: error)
            Button("Send") { Task { await send() } }.buttonStyle(PrimaryButtonStyle())
            Spacer()
        }
        .padding(24)
    }

    private func send() async {
        do {
            let r: RideResponse = try await APIClient.shared.post("/api/rides/\(ride.id)/review", ["stars": stars, "text": text])
            ride = r.ride
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct AppealSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var ride: Ride
    @State private var text = ""
    @State private var impossibleDropoff = false
    @State private var working = false
    @State private var error: String?

    // Only a driver can say the rider's drop-off couldn't be reached.
    private var canReportDropoff: Bool { ride.role == "driver" && ride.rider != nil }
    private var hasText: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 5 }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ScreenTitle(title: String(localized: "What went wrong?"), subtitle: canReportDropoff ? String(localized: "We look at your route and the rider’s, and answer here.") : String(localized: "We look at your route and the driver’s, and answer here."))
            if canReportDropoff {
                Button { impossibleDropoff.toggle() } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: impossibleDropoff ? "checkmark.square.fill" : "square").font(.title3).foregroundStyle(impossibleDropoff ? Theme.accentInk : Theme.faint)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(Reporting.impossibleDropoff).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                            Text("Reports the rider and adds this drive, so we can see the planned route on a map.").font(.caption).foregroundStyle(Theme.muted).multilineTextAlignment(.leading)
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(impossibleDropoff ? .isSelected : [])
            }
            TextField("Tell us what happened", text: $text, axis: .vertical).lineLimit(4...8).fieldStyle()
            ErrorText(text: error)
            Button(hasText ? String(localized: "Send appeal") : String(localized: "Send report")) { Task { await send() } }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working || !(hasText || impossibleDropoff))
            Spacer()
        }
        .padding(24)
    }

    private func send() async {
        working = true
        error = nil
        defer { working = false }
        do {
            if impossibleDropoff, let rider = ride.rider {
                try await Reporting.send(userId: rider.id, reason: Reporting.impossibleDropoff, message: text, rideId: ride.id)
            }
            if hasText {
                let r: RideResponse = try await APIClient.shared.post("/api/rides/\(ride.id)/appeal", ["message": text])
                ride = r.ride
            }
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
