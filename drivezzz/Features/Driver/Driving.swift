import MapKit
import SwiftUI

// The Driving tab: the map, with a slide to go online or offline, and your earnings in a panel that stays minimized until you
// slide it up. Going online shares the phone's position with the blue bar on, also with the app in the background, until you
// slide back or close the app. A drive happens on this same map: its route, directions and buttons take over from the panel.
struct DrivingView: View {
    @Environment(AppState.self) private var app
    @State private var home: DriverHome?
    @State private var orders: [MarketOrder] = []
    @State private var booked: [Ride] = []
    @State private var error: String?
    @State private var starting = false
    @State private var showRules = false
    // Held here, so the map stays on it to show the end of a drive after the server has moved on.
    @State private var drive: Ride?
    @State private var openOrder: MarketOrder?
    @State private var detent: PanelDetent = .peek
    @State private var mapRest: PanelDetent = .peek
    @Namespace private var mapSpace
    @State private var camera: MapCameraPosition = .userLocation(fallback: .automatic)
    @State private var course = 0.0
    @State private var heading = DriveHeading()
    @State private var nav = DriveNavigator()
    @State private var following = true
    private let location = LocationService.shared
    private let meter = DataMeter.shared
    private let peek: CGFloat = 52

    private var navigating: Bool { app.driveOpen && drive != nil }

    var body: some View {
        GeometryReader { geo in
            let tabBar = Room.tabBar(geo.safeAreaInsets.bottom)
            // Everything that floats over the map stays together at the side, where the panel is.
            let column: CGFloat = Room.wide(geo.size.width) ? Room.panel + 2 * Room.edge : .infinity
            ZStack(alignment: .top) {
                MapReader { proxy in
                Map(position: $camera, interactionModes: navigating && following ? [] : .all, scope: mapSpace) {
                    // Standing still it stays put, whatever GPS does; moving, the map's own position glides along.
                    if let parked = heading.parked {
                        Annotation("", coordinate: parked, anchor: .center) { ownVehicle }.annotationTitles(.hidden)
                    } else {
                        UserAnnotation(anchor: .center) { _ in ownVehicle }
                    }
                    if navigating, let drive {
                        let line = nav.line.isEmpty ? drive.route : nav.line
                        if !line.isEmpty {
                            MapPolyline(coordinates: line).stroke(Theme.routeEdge, style: StrokeStyle(lineWidth: 10, lineCap: .round, lineJoin: .round))
                            MapPolyline(coordinates: line).stroke(Theme.route, style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
                        }
                        // Picked up: only the way to the drop-off is left.
                        if drive.status != "riding" {
                            Marker("Pickup", systemImage: "figure.wave", coordinate: drive.pickup.coordinate).tint(Theme.pickupPin)
                        }
                        Marker("Drop-off", systemImage: "flag.fill", coordinate: drive.dropoff.coordinate).tint(Theme.accent)
                    } else {
                        DriverMapPins(orders: orders, booked: booked, openOrder: { openOrder = $0 }, openRide: openBooked)
                    }
                }
                .mapStyle(.drivezzz(traffic: navigating))
                .onMapCameraChange(frequency: .continuous) { heading.mapTurned(to: $0.camera.heading) }
                // The compass is ours, under the buttons: the map's own would sit on top of them.
                .mapControls { }
                // One place for a tap, which asks what was under the finger: a pin's own button is small, and the map hears it too.
                .onTapGesture(coordinateSpace: .global) { point in
                    guard !navigating else { return }
                    switch DriverMapPins.hit(at: point, proxy, orders: orders, booked: booked) {
                    case .order(let order): openOrder = order
                    case .ride(let ride): openBooked(ride)
                    case nil: break
                    }
                }
                // Keeps a route clear of the clock and the camera.
                .safeAreaPadding(.top, 64)
                .ignoresSafeArea(edges: .top)
                .clearOfPanel(navigating ? 230 : BottomPanel<EmptyView, EmptyView>.cover(mapRest, peek: peek, total: geo.size.height + geo.safeAreaInsets.bottom, tabBar: tabBar), width: geo.size.width)
                }
                if navigating, let drive {
                    DriveOverlay(ride: drive, nav: nav, camera: $camera, following: $following, course: course) {
                        app.driveOpen = false
                        self.drive = app.driving.drive
                    }
                    .frame(maxWidth: column)
                    .frame(maxWidth: .infinity, alignment: .trailing)
                } else {
                    BottomPanel(detent: $detent, peek: peek, tabBar: tabBar) { panel }
                    if detent != .full {
                        topBar
                            .frame(maxWidth: column)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
            .background(PanelRest(detent: $detent, rest: $mapRest))
        }
        .mapScope(mapSpace)
        .foregroundStyle(Theme.ink)
        .sheet(item: $openOrder) { order in OrderSheet(order: order).presentationDetents([.large]) }
        .sheet(isPresented: $showRules) {
            DriverRules { Task { await goOnline() } }.presentationDetents([.large])
        }
        .task(id: app.rev) { await load() }
        .onChange(of: app.driverRadiusKm) { _, _ in Task { await load() } }
        .task {
            // After the map's own first layout, which would otherwise win.
            try? await Task.sleep(for: .milliseconds(400))
            recentre()
            // Orders change often, your earnings hardly, and news comes through by itself. Only for someone looking at it.
            var round = 0
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard app.isActive else { continue }
                round += 1
                if round % 4 == 0 { await load() } else { await loadOrders() }
            }
        }
        .onLocation { here in
            guard let here else { return }
            heading.moved(to: here)
            if heading.course != course { course = heading.course }
        }
        .onChange(of: navigating && following && drive?.navigationTarget != nil, initial: true) { _, pinned in heading.pinned = pinned }
        // A new drive shows its directions right away, on this map.
        .onChange(of: app.driving.drive?.id) { _, id in
            if id != nil {
                drive = app.driving.drive
                following = true
                app.driveOpen = true
            }
        }
        .onChange(of: app.driving.drive) { _, fresh in
            if let fresh, fresh.id == drive?.id { drive = fresh }
        }
        .onChange(of: navigating) { _, on in if !on { recentre() } }
        .onChange(of: app.driveMode) { _, on in if on { error = nil } }
        // Another vehicle chosen: what was under review was about the one before.
        .onChange(of: app.driver?.activeCarId) { _, _ in app.underReview = nil }
        .onChange(of: orders) { _, fresh in if let open = openOrder, let same = fresh.first(where: { $0.id == open.id }) { openOrder = same } }
        .onAppear {
            if let live = app.driving.drive, drive == nil {
                drive = live
                app.driveOpen = true
            }
        }
    }

    private var ownVehicle: some View {
        ZStack {
            if app.driveMode, !navigating { Radar(size: 150) }
            OwnVehicle(kind: app.driver?.activeCar?.kind, heading: heading)
        }
    }

    private var topBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                SlideControl(
                    title: starting ? String(localized: "Going online…") : app.driveMode ? String(localized: "Go offline") : String(localized: "Go online"),
                    fill: app.driveMode ? Theme.road : Theme.accent,
                    ink: app.driveMode ? .white : Theme.onAccent,
                    working: starting
                ) { Task { await toggle() } }
                MapRoundButton(symbol: "location.fill", label: String(localized: "Back to my location")) { recentre() }
            }
            HStack(spacing: 7) {
                Circle().fill(app.driveMode && !app.reconnecting ? Theme.ok : Theme.faint).frame(width: 9, height: 9)
                if app.driveMode, let since = app.driveStartedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { ctx in
                        Text("\(app.reconnecting ? String(localized: "Reconnecting…") : String(localized: "You’re online")) · \(Fmt.stopwatch(Int(ctx.date.timeIntervalSince(since))))")
                            .font(.footnote.weight(.semibold).monospacedDigit())
                    }
                } else {
                    Text("You’re offline").font(.footnote.weight(.semibold))
                }
            }
            .padding(.horizontal, 14)
            .frame(height: 38)
            .background(Theme.card, in: Capsule())
            .lifted(radius: 19)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .trailing) { RangeButton() }
            .overlay(alignment: .bottomTrailing) { MapCompass(scope: mapSpace).offset(y: 52) }
            if let drive = app.driving.drive { currentDrive(drive) }
            if let offer = app.driving.offer, app.parkedOffer == offer.id { parkedOffer(offer) }
            if app.driving.putOffline == true, !app.driveMode {
                NoteBox(symbol: "moon.zzz.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "You were put offline: you didn’t answer a ride within 5 minutes. Go online again when you’re ready."))
                    .floating(radius: 14)
            }
            // Going online found only a person's look left: what it is, how long, and what to do meanwhile.
            if !app.driveMode, let review = app.underReview {
                UnderReviewCard(review: review)
            } else if !app.driveMode, app.driving.drive == nil, let line = app.checksAttention {
                // What the checks still need, where a driver looks before going online (Pieter, 8 November 2026). A tap opens them.
                Button { app.checksOpen = true } label: {
                    NoteBox(symbol: "exclamationmark.circle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "Driving in the Netherlands: \(line) Tap to see it."))
                }
                .buttonStyle(.plain)
                .floating(radius: 14)
            }
            if let error {
                Text(error)
                    .font(.footnote)
                    .foregroundStyle(Theme.danger)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .floating(radius: 14)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
    }

    private func recentre() {
        let fallback: MapCameraPosition = location.location.map { .region(MKCoordinateRegion(center: $0.coordinate, latitudinalMeters: 2500, longitudinalMeters: 2500)) } ?? .automatic
        camera = .userLocation(followsHeading: false, fallback: fallback)
    }

    private func toggle() async {
        error = nil
        if app.driveMode {
            if app.driving.drive != nil {
                error = String(localized: "You have a rider. Finish the drive, or cancel it, before you go offline.")
                return
            }
            app.stopDriving()
            return
        }
        if app.driver?.rulesSeenAt == nil {
            showRules = true
            return
        }
        await goOnline()
    }

    private func goOnline() async {
        starting = true
        defer { starting = false }
        if let problem = await app.goOnline() { error = problem }
    }

    // A request swiped away: it's still theirs to answer until its time is up.
    private func parkedOffer(_ offer: Ride) -> some View {
        Button { app.parkedOffer = nil } label: {
            HStack(spacing: 12) {
                IconTile(symbol: "bell.badge.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Text("New ride waiting").font(.subheadline.weight(.bold)).foregroundStyle(Theme.ink)
                    Text("\(Fmt.eur(offer.priceCents)) · \(Fmt.km(offer.distanceM))\(offer.isCash ? String(localized: " · cash") : "")").font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer()
                if let until = offer.offeredUntil { Countdown(until: until) }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
            }
            .padding(12)
            .floating()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func currentDrive(_ ride: Ride) -> some View {
        Button {
            drive = ride
            following = true
            app.driveOpen = true
        } label: {
            HStack(spacing: 12) {
                IconTile(symbol: "arrow.triangle.turn.up.right.diamond.fill", tint: Theme.onAccent, background: Theme.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(ride.navigationTarget == nil || ride.status == "riding" ? driveTitle(ride) : String(localized: "Go to rider")).font(.subheadline.weight(.bold)).foregroundStyle(Theme.ink)
                    Text(ride.status == "riding" ? (ride.dropoff.label ?? "") : (ride.pickup.label ?? "")).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
            }
            .padding(12)
            .floating()
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 18) {
            earningsBar
            tiles
            ordersSection
            plannedSection
            areaPrices
            if app.driveMode { connection }
        }
        .padding(.horizontal, 14)
    }

    // What shows with the panel down: slide up, or tap, for the rest.
    private var earningsBar: some View {
        HStack(spacing: 8) {
            Text("Earnings today").font(.headline).foregroundStyle(Theme.ink)
            Spacer()
            Text(Fmt.eur(home?.earnedTodayCents ?? 0)).font(.title3.weight(.bold).monospacedDigit()).kerning(-0.3).foregroundStyle(Theme.ink).contentTransition(.numericText())
            Image(systemName: detent == .peek ? "chevron.up" : "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
        }
        .panelTap { withAnimation(PanelDetent.spring) { detent = detent == .peek ? .middle : .peek } }
    }

    private var tiles: some View {
        VStack(spacing: 10) {
            Button {
                app.drivesPart = 2
                app.driverTab = 2
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Total earnings").font(.footnote.weight(.medium)).foregroundStyle(Theme.onAccent.opacity(0.85))
                        Text(Fmt.eur(home?.earnedTotalCents ?? 0)).font(.system(size: 34, weight: .bold).monospacedDigit()).kerning(-0.8).foregroundStyle(Theme.onAccent)
                        Text(ridesToday).font(.footnote).foregroundStyle(Theme.onAccent.opacity(0.85))
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.onAccent.opacity(0.85))
                }
                .padding(16)
                .background(Theme.accent, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            HStack(spacing: 10) {
                tile(String(localized: "On time"), home?.onTimePercent.map { "\($0)%" } ?? "–")
                tile(String(localized: "Completed"), app.driver?.completedPercent.map { "\($0)%" } ?? "–")
                tile(String(localized: "Accepted"), home?.acceptancePercent.map { "\($0)%" } ?? "–")
            }
            .frame(height: 70)
        }
    }

    private var ridesToday: String {
        let n = home?.ridesToday ?? 0
        return n == 1 ? String(localized: "1 ride today") : String(localized: "\(n) rides today")
    }

    private func tile(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value).font(.title3.weight(.bold).monospacedDigit()).kerning(-0.3).foregroundStyle(Theme.ink)
            Text(title).font(.footnote).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(Theme.soft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }

    @ViewBuilder
    private var ordersSection: some View {
        if app.driveMode || !orders.isEmpty {
            PanelGroup(title: String(localized: "Orders nearby")) {
                if orders.isEmpty { Text("Nothing to claim right now.").font(.subheadline).foregroundStyle(Theme.muted) }
                ForEach(orders.sorted { ($0.bidCents ?? 0) > ($1.bidCents ?? 0) }.forYouFirst.prefix(5)) { order in
                    Button { openOrder = order } label: { OrderRow(order: order) }.buttonStyle(.plain)
                }
            }
        }
    }

    @ViewBuilder
    private var plannedSection: some View {
        if let planned = home?.planned, !planned.isEmpty {
            PanelGroup(title: String(localized: "Planned drives")) {
                ForEach(planned) { ride in PlannedRow(ride: ride) }
            }
        }
    }

    private var areaPrices: some View {
        let n = home?.area?.driversOnline ?? 0
        return PanelGroup(title: String(localized: "Prices around you"), footer: n == 0 ? String(localized: "No other drivers online within 10 km.") : String(localized: "\(n) other drivers online within 10 km.")) {
            LabeledContent("Your price", value: priceText(app.driver?.perKmCents, app.driver?.perMinCents))
            if let a = home?.area, (a.driversOnline ?? 0) > 0 {
                LabeledContent("Cheapest", value: priceText(a.cheapestPerKmCents, a.cheapestPerMinCents))
                LabeledContent("Middle", value: priceText(a.middlePerKmCents, a.middlePerMinCents))
            }
            Button("Change my price") { app.driverTab = 3 }.font(.subheadline).foregroundStyle(Theme.accentInk)
        }
    }

    private var connection: some View {
        PanelGroup(title: String(localized: "While you’re online"), footer: String(localized: "You can leave the app. Slide back or close the app to go offline.")) {
            LabeledContent("Location", value: app.reconnecting ? String(localized: "Reconnecting…") : String(localized: "Shared"))
            LabeledContent("Data", value: String(localized: "\(Lang.number(String(format: "%.2f", meter.megabytesPerHour))) MB an hour"))
        }
    }

    private func priceText(_ km: Int?, _ min: Int?) -> String { String(localized: "\(Fmt.rate(km))/km · \(Fmt.rate(min))/min") }

    private func load() async {
        let tz = TimeZone.current.secondsFromGMT() / 60
        if let h: DriverHome = try? await APIClient.shared.get("/api/driver/home?tzMinutes=\(tz)") {
            home = h
            // The connection is back: don't keep saying it's gone.
            if error == APIError.offline.message { error = nil }
        }
        await app.loadDriver()
        await loadOrders()
    }

    private func loadOrders() async {
        if let here = location.location?.coordinate,
           let r: MarketResponse = try? await APIClient.shared.get("/api/driver/market?lat=\(here.latitude)&lng=\(here.longitude)&radiusKm=\(Int(app.driverRadiusKm))") {
            orders = r.orders ?? []
            if r.booked != nil || !booked.isEmpty { booked = r.booked ?? [] }
        }
    }

    // A ride of your own, from its number on the map (Pieter, 8 November 2026): the one on now opens its directions, as its card
    // does; another opens its page, as on Drives.
    private func openBooked(_ ride: Ride) {
        if let live = app.driving.drive, live.id == ride.id {
            drive = live
            following = true
            app.driveOpen = true
        } else {
            app.mapRide = ride
        }
    }
}

// A titled group of rows in the Driving panel.
private struct PanelGroup<Content: View>: View {
    var title: String
    var footer: String?
    @ViewBuilder var content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).foregroundStyle(Theme.ink)
            VStack(alignment: .leading, spacing: 12) { content() }
                .font(.subheadline)
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.soft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            if let footer { Text(footer).font(.caption).foregroundStyle(Theme.muted) }
        }
    }
}

extension Ride {
    // Where the directions lead: the rider, then the drop-off. Nowhere while waiting for them to check in.
    var navigationTarget: Place? {
        switch status {
        case "accepted", "awaiting_payment": pickup
        case "riding": dropoff
        default: nil
        }
    }
}

func driveTitle(_ ride: Ride) -> String {
    switch ride.status {
    case "awaiting_payment": String(localized: "Waiting for payment")
    case "accepted": String(localized: "Go to your rider")
    case "arrived": String(localized: "Waiting for check-in")
    case "riding": String(localized: "Drive to the drop-off")
    default: ride.statusTitle
    }
}

struct OrderRow: View {
    var order: MarketOrder

    var body: some View {
        HStack(spacing: 12) {
            Circle().fill(order.isPlanned ? Theme.planned : Theme.now).frame(width: 9, height: 9)
            VStack(alignment: .leading, spacing: 2) {
                Text(order.dropoffLabel ?? String(localized: "Somewhere near")).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Text("\(Fmt.km(order.awayM)) away · \(Fmt.km(order.distanceM)) ride · \(Fmt.people(order.passengers))\(order.pets == true ? String(localized: " · pet") : "")\(order.vehicle.map { " · \(Vehicle.name($0).lowercased())" } ?? "")")
                    .font(.caption)
                    .foregroundStyle(Theme.muted)
                if let at = order.scheduledAt { Text(Fmt.dayTime(Date(ms: at))).font(.caption.weight(.medium)).foregroundStyle(Theme.ink) }
                if order.forYou == true { StatusPill(text: String(localized: "A rider chose you")).padding(.top, 2) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(Fmt.eur(order.bidCents)).font(.system(size: 17, weight: .bold)).kerning(-0.2).foregroundStyle(Theme.ink)
                Text(Fmt.coinSymbol(order.coin)).font(.caption).foregroundStyle(Theme.faint)
            }
        }
        .contentShape(Rectangle())
    }
}

struct OrderSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    var order: MarketOrder
    @State private var working = false
    @State private var error: String?
    @State private var toPickup: MKRoute?
    @State private var ride: MKRoute?
    private let location = LocationService.shared

    private var dropoff: CLLocationCoordinate2D? {
        guard let lat = order.dropoffLat, let lng = order.dropoffLng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    routeMap
                    hero
                    facts
                    VStack(alignment: .leading, spacing: 12) {
                        RouteStops(from: order.pickupLabel ?? String(localized: "Near the pin"), to: order.dropoffLabel ?? String(localized: "Drop-off"))
                        if let at = order.scheduledAt {
                            Label("Pickup \(Fmt.dayTime(Date(ms: at)))", systemImage: "calendar").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accentInk)
                        }
                    }
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .lifted(0.45, radius: 22)
                    note
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
                }
                .padding(16)
            }
            .background(Theme.page)
            .foregroundStyle(Theme.ink)
            .navigationTitle("Order")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                Button { Task { await claim() } } label: {
                    if working { ProgressView().tint(Theme.onAccent) } else { Text("Claim for \(Fmt.eur(order.bidCents))") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working || app.driving.drive != nil)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
            }
            .task { await loadRoutes() }
        }
    }

    // Your way to the pickup, dashed, then the ride itself, on Apple's roads.
    private var routeMap: some View {
        Map(initialPosition: .automatic, interactionModes: [.pan, .zoom]) {
            UserAnnotation()
            if let toPickup { MapPolyline(toPickup.polyline).stroke(Theme.accentInk.opacity(0.75), style: StrokeStyle(lineWidth: 4, lineCap: .round, dash: [2, 7])) }
            if let ride {
                MapPolyline(ride.polyline).stroke(Theme.routeEdge, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
                MapPolyline(ride.polyline).stroke(Theme.route, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            }
            Annotation("Pickup", coordinate: order.coordinate) {
                Circle().fill(.white).frame(width: 18, height: 18).overlay(Circle().stroke(Theme.accentInk, lineWidth: 5)).shadow(radius: 2)
            }
            if let dropoff {
                Annotation("Drop-off", coordinate: dropoff) {
                    Image(systemName: "flag.checkered").font(.caption.weight(.bold)).foregroundStyle(.white).frame(width: 28, height: 28).background(Theme.night, in: Circle()).shadow(radius: 2)
                }
            }
        }
        .mapStyle(.drivezzz())
        .frame(height: 230)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
        .overlay(alignment: .bottomLeading) {
            HStack(spacing: 12) {
                legend(dashed: true, String(localized: "To the pickup"))
                legend(dashed: false, String(localized: "The ride"))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(.thinMaterial, in: Capsule())
            .padding(10)
        }
    }

    private func legend(dashed: Bool, _ text: String) -> some View {
        HStack(spacing: 5) {
            Capsule().fill(Theme.accentInk.opacity(dashed ? 0.6 : 1)).frame(width: dashed ? 10 : 16, height: 4)
            Text(text).font(.caption2.weight(.semibold))
        }
    }

    private var hero: some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 4) {
                Text(Fmt.eur(order.bidCents)).font(.system(size: 42, weight: .bold)).kerning(-1).foregroundStyle(Theme.ink)
                HStack(spacing: 6) {
                    Circle().fill(order.isPlanned ? Theme.planned : Theme.now).frame(width: 9, height: 9)
                    Text(order.isPlanned ? String(localized: "Booked for a time") : String(localized: "Looking for a driver now")).font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                Text(Fmt.coinSymbol(order.coin)).font(.subheadline.weight(.bold)).padding(.horizontal, 10).padding(.vertical, 4).background(Theme.accentSoft, in: Capsule()).foregroundStyle(Theme.accentInk)
                if let kind = order.vehicle { Label(Vehicle.name(kind), systemImage: Vehicle.icon(kind)).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted) }
            }
        }
    }

    private var facts: some View {
        HStack(spacing: 8) {
            OrderFact(symbol: "location.north.line.fill", value: Fmt.km(order.awayM), label: String(localized: "to pickup"))
            OrderFact(symbol: "point.topleft.down.to.point.bottomright.curvepath", value: Fmt.km(order.distanceM), label: String(localized: "ride"))
            OrderFact(symbol: "clock.fill", value: Fmt.minutes(order.durationS), label: String(localized: "time"))
            OrderFact(symbol: order.pets == true ? "pawprint.fill" : "person.2.fill", value: "\(order.passengers ?? 1)", label: order.pets == true ? String(localized: "+ pet") : ((order.passengers ?? 1) == 1 ? String(localized: "person") : String(localized: "people")))
        }
    }

    @ViewBuilder
    private var note: some View {
        if app.driving.drive != nil {
            NoteBox(symbol: "exclamationmark.circle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "Finish the drive you’re on first: with a rider you can’t claim another drive."))
        } else if order.canClaim == false {
            NoteBox(symbol: "exclamationmark.circle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "To claim this: turn on \(Fmt.coinSymbol(order.coin)) in Wallet, and on My page use a \(order.vehicle.map { Vehicle.name($0).lowercased() } ?? String(localized: "vehicle")) with enough seats\(order.pets == true ? String(localized: " that allows pets") : "")."))
        }
        if order.forYou == true {
            NoteBox(symbol: "person.fill.checkmark", tint: Theme.accentInk, background: Theme.accentSoft, text: String(localized: "This rider chose you, at your own price with your way to the pickup in it. Nobody else can claim it for now. \(order.coin == Coins.cash ? String(localized: "The rider pays you in cash.") : String(localized: "Once you do, the rider pays."))"))
        } else {
            NoteBox(symbol: "info.circle.fill", tint: Theme.accentInk, background: Theme.accentSoft, text: String(localized: "The rider named this price for the ride. Your way to the pickup (voorrijkosten, \(Fmt.km(order.awayM))) isn’t paid on top: \(Fmt.eur(order.bidCents)) is all you get."))
        }
    }

    private func loadRoutes() async {
        if let here = location.location?.coordinate { toPickup = await Self.route(here, order.coordinate) }
        if let dropoff { ride = await Self.route(order.coordinate, dropoff) }
    }

    static func route(_ from: CLLocationCoordinate2D, _ to: CLLocationCoordinate2D) async -> MKRoute? {
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: from))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: to))
        request.transportType = .automobile
        return try? await MKDirections(request: request).calculate().routes.first
    }

    private func claim() async {
        working = true
        error = nil
        defer { working = false }
        do {
            let _: RideResponse = try await APIClient.shared.post("/api/rides/\(order.id)/claim")
            await app.syncNow()
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

private struct PlannedRow: View {
    @Environment(AppState.self) private var app
    var ride: Ride
    @State private var confirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                if let s = ride.scheduledAt { Text(Fmt.dayTime(Date(ms: s))).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink) }
                Spacer()
                Text(Fmt.eur(ride.priceCents)).font(.subheadline.weight(.bold)).foregroundStyle(Theme.ink)
            }
            Text("\(ride.pickup.label ?? String(localized: "Pickup")) → \(ride.dropoff.label ?? String(localized: "Drop-off"))").font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
            if ride.needsPayment { Text("Not paid yet. We tell you once it is.").font(.caption.weight(.semibold)).foregroundStyle(Theme.warn) }
            Button("I can’t make it") { confirm = true }.font(.footnote.weight(.semibold)).foregroundStyle(Theme.danger).buttonStyle(.plain).padding(.top, 2)
        }
        .confirmationDialog("Pass this drive on?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Pass it on", role: .destructive) {
                Task {
                    try? await APIClient.shared.call("POST", "/api/rides/\(ride.id)/release")
                    await app.syncNow()
                }
            }
            Button("Keep it", role: .cancel) {}
        }
    }
}

// A new ride, with a clock on it.
// A new ride, to decide whether it's worth it: the route, how far in all, what it pays. Swiped down, the sheet goes away and the
// request stays in Current on Drives, where its time runs on.
struct OfferView: View {
    var ride: Ride

    var body: some View {
        // The map takes the room that's left, so the buttons sit at the bottom on any phone.
        GeometryReader { geo in
            ScrollView {
                OfferCard(ride: ride, mapHeight: max(200, geo.size.height - 385)).padding(18)
            }
        }
    }
}

struct OfferCard: View {
    @Environment(AppState.self) private var app
    var ride: Ride
    var mapHeight: CGFloat = 220
    @State private var working = false
    @State private var error: String?
    @State private var toPickup: MKRoute?
    private let location = LocationService.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 0) {
                    Text("New ride").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.muted)
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Fmt.eur(ride.priceCents)).font(.system(size: 42, weight: .bold)).kerning(-1).foregroundStyle(Theme.ink)
                        if ride.isCash { Text("Cash").font(.subheadline.weight(.bold)).padding(.horizontal, 10).padding(.vertical, 4).background(Theme.accentSoft, in: Capsule()).foregroundStyle(Theme.accentInk) }
                    }
                }
                Spacer()
                if let until = ride.offeredUntil { CountdownRing(until: until) }
            }
            routeMap
            RouteStops(from: ride.pickup.label ?? String(localized: "Pickup"), to: ride.dropoff.label ?? String(localized: "Drop-off"))
            HStack(spacing: 8) {
                OrderFact(symbol: "location.north.line.fill", value: Fmt.km(ride.pickupM), label: String(localized: "to pickup"))
                OrderFact(symbol: "point.topleft.down.to.point.bottomright.curvepath", value: Fmt.km(ride.distanceM), label: String(localized: "ride"))
                OrderFact(symbol: "sum", value: Fmt.km((ride.pickupM ?? 0) + (ride.distanceM ?? 0)), label: String(localized: "in total"))
                OrderFact(symbol: "clock.fill", value: Fmt.minutes(ride.durationS), label: String(localized: "ride time"))
            }
            Text("\(Fmt.people(ride.passengers))\(ride.pets == true ? String(localized: " · pet") : ""). Not answering in time puts you offline.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
            ErrorText(text: error)
            HStack(spacing: 10) {
                Button("Decline") { Task { await answer("decline") } }.buttonStyle(GhostButtonStyle())
                Button("Accept") { Task { await answer("accept") } }.buttonStyle(PrimaryButtonStyle())
            }
            .disabled(working)
        }
        .task(id: ride.id) {
            if let here = location.location?.coordinate { toPickup = await OrderSheet.route(here, ride.pickup.coordinate) }
        }
    }

    // Your way to the pickup, dashed, then the ride itself.
    private var routeMap: some View {
        Map(initialPosition: .automatic, interactionModes: [.pan, .zoom]) {
            UserAnnotation()
            if let toPickup { MapPolyline(toPickup.polyline).stroke(Theme.accentInk.opacity(0.75), style: StrokeStyle(lineWidth: 4, lineCap: .round, dash: [2, 7])) }
            let line = ride.route
            if !line.isEmpty {
                MapPolyline(coordinates: line).stroke(Theme.routeEdge, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
                MapPolyline(coordinates: line).stroke(Theme.route, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
            }
            Marker("Pickup", systemImage: "figure.wave", coordinate: ride.pickup.coordinate).tint(Theme.pickupPin)
            Marker("Drop-off", systemImage: "flag.fill", coordinate: ride.dropoff.coordinate).tint(Theme.accent)
        }
        .mapStyle(.drivezzz())
        .frame(height: mapHeight)
        .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private func answer(_ what: String) async {
        working = true
        defer { working = false }
        do {
            try await APIClient.shared.call("POST", "/api/rides/\(ride.id)/\(what)")
            await app.syncNow()
        } catch {
            self.error = error.localizedDescription
            await app.syncNow()
        }
    }
}

private struct OfferLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            configuration.icon.font(.system(size: 9)).foregroundStyle(Theme.accentInk).frame(width: 14)
            configuration.title.font(.subheadline).foregroundStyle(Theme.ink)
        }
    }
}

// The drive, over the Driving tab's map: directions to the pickup, wait for check-in, to the drop-off, check out.
struct DriveOverlay: View {
    @Environment(AppState.self) private var app
    var ride: Ride
    var nav: DriveNavigator
    @Binding var camera: MapCameraPosition
    @Binding var following: Bool
    @State private var followed = FollowedSpot()
    var course: Double
    var onClose: () -> Void
    @State private var working = false
    @State private var error: String?
    @State private var cancelling = false
    @State private var done: Ride?
    @State private var toDropoffM: Int?     // from this phone, to tens of metres: check-out only opens at the drop-off
    private let location = LocationService.shared
    private let hasGoogleMaps = UIApplication.shared.canOpenURL(URL(string: "comgooglemaps://")!)
    private let hasWaze = UIApplication.shared.canOpenURL(URL(string: "waze://")!)

    private let reasons = ["Alcohol abuse", "Misbehaviour", "Rider not there", "Car trouble", "Other"]

    private var destination: Place? { done == nil ? ride.navigationTarget : nil }

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 10) {
                if destination != nil {
                    NavigationBanner(nav: nav)
                    if nav.failed {
                        Text("Directions aren’t available right now. Use Other maps below.")
                            .font(.footnote)
                            .foregroundStyle(Theme.danger)
                            .padding(12)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .floating(radius: 14)
                    }
                    VStack(spacing: 10) {
                        MapRoundButton(symbol: nav.muted ? "speaker.slash.fill" : "speaker.wave.2.fill", label: nav.muted ? String(localized: "Turn the voice on") : String(localized: "Turn the voice off")) { nav.toggleMuted() }
                        MapRoundButton(symbol: following ? "map.fill" : "location.north.line.fill", label: following ? String(localized: "See the whole route") : String(localized: "Follow my position")) { toggleFollowing() }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                }
                Spacer()
            }
            .padding(.horizontal, 10)
            .frame(maxHeight: .infinity, alignment: .top)
            VStack(alignment: .leading, spacing: 10) {
                if destination != nil, let left = nav.secondsLeft, let metres = nav.metresLeft {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(Fmt.minutes(Int(left))).font(.system(size: 28, weight: .bold).monospacedDigit()).kerning(-0.5).foregroundStyle(Theme.ink)
                        Text("\(DriveNavigator.spoken(metres)) · there at \(Fmt.time(Date().addingTimeInterval(left)))").font(.subheadline.monospacedDigit()).foregroundStyle(Theme.muted)
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(done == nil ? driveTitle(ride) : String(localized: "Drive finished")).font(.title3.weight(.bold)).kerning(-0.3).foregroundStyle(Theme.ink)
                    Spacer()
                    if done == nil, ride.status == "awaiting_payment", let by = ride.payBy {
                        Countdown(until: by, redBelow: 60)
                    } else {
                        Text(Fmt.eur(ride.priceCents)).font(.title3.weight(.bold).monospacedDigit()).kerning(-0.3).foregroundStyle(Theme.ink)
                    }
                }
                Text(subtitle).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2)
                if done == nil {
                    HStack {
                        Text("\(ride.rider?.name ?? String(localized: "Rider")) · \(Fmt.people(ride.passengers))\(ride.pets == true ? String(localized: " · pet") : "")\(ride.isCash ? String(localized: " · pays in cash") : "")").font(.footnote).foregroundStyle(Theme.muted)
                        Spacer()
                        if let rider = ride.rider { PersonMenu(userId: rider.id, name: rider.name ?? String(localized: "your rider"), rideId: ride.id, canReportDropoff: true) }
                    }
                    ErrorText(text: error)
                    actions
                } else {
                    if ride.isCash {
                        Label("Paid in cash", systemImage: "banknote.fill").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ok)
                    } else {
                        Text("You’re paid to your wallet in 24 hours, if no one appeals.").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    if done?.checkoutWarning == true {
                        Label("Heads-up: the rider’s phone wasn’t within 500 m of the drop-off when you checked out. If you dropped them off correctly, you can ignore this. They have 24 hours to appeal.", systemImage: "info.circle")
                            .font(.caption)
                            .foregroundStyle(Theme.muted)
                    }
                    Button("Done") { onClose() }.buttonStyle(PrimaryButtonStyle())
                }
            }
            .padding(18)
            .floating(radius: 28)
            .padding(10)
        }
        .confirmationDialog("Why are you cancelling?", isPresented: $cancelling, titleVisibility: .visible) {
            ForEach(reasons.filter { ride.status != "riding" || $0 != "Rider not there" }, id: \.self) { reason in
                Button(Fmt.reason(reason), role: .destructive) { Task { await cancel(reason) } }
            }
            Button("Keep the ride", role: .cancel) {}
        } message: {
            Text(cancelMessage)
        }
        .onChange(of: app.driving.drive) { _, fresh in
            // Over without a check-out: the rider or Drivezzz cancelled it.
            if fresh == nil, done == nil { Task { await refreshOver() } }
        }
        .onAppear {
            // A navigation screen stays on, and follows the road as closely as the phone can.
            UIApplication.shared.isIdleTimerDisabled = true
            location.setNavigating(true)
            startNavigation()
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            location.setNavigating(false)
            nav.stop()
        }
        .onChange(of: destination?.coordinate.latitude) { _, _ in startNavigation() }
        .onChange(of: destination?.coordinate.longitude) { _, _ in startNavigation() }
        .onLocation { here in
            guard let here else { return }
            nav.update(here)
            follow(here)
            measureDropoff(here)
        }
        .onAppear { if let here = location.location { measureDropoff(here) } }
        // Checked in: measured from where the phone is now, not only at its next fix.
        .onChange(of: ride.status) { _, _ in if let here = location.location { measureDropoff(here) } }
    }

    // Within 200 m of the drop-off, as the server checks it (Pieter, 8 November 2026: not straight after check-in). Kept to tens of
    // metres, so this panel isn't drawn again for every fix.
    private var checkOutRadius: Int { ride.checkOutM ?? 200 }
    private var canCheckOut: Bool { (toDropoffM ?? ride.driverToDropoffM ?? .max) <= checkOutRadius }
    private func measureDropoff(_ here: CLLocation) {
        guard ride.status == "riding" else { return }
        let metres = Int(here.distance(from: CLLocation(latitude: ride.dropoff.lat, longitude: ride.dropoff.lng)) / 10) * 10
        if metres != toDropoffM { toDropoffM = metres }
    }

    private func startNavigation() {
        if let destination {
            nav.go(to: destination.coordinate, from: location.location)
        } else {
            nav.stop()
        }
        if let here = location.location { follow(here, force: true) }
    }

    private func follow(_ here: CLLocation, force: Bool = false) {
        guard following else { return }
        guard destination != nil else {
            camera = .automatic
            return
        }
        // Standing still the map stays where it is, or it would sway with every wobble of the GPS.
        if !force, let last = followed.spot, DriveHeading.wobble(here, around: last) { return }
        followed.spot = here
        // Under walking pace a phone's own course is mostly noise.
        let heading = here.course >= 0 && here.speed > DriveHeading.realSpeed ? here.course : course
        // Further out the faster you go.
        let distance = min(1400, 500 + max(0, here.speed) * 25)
        withAnimation(.easeInOut(duration: 1)) {
            camera = .camera(MapCamera(centerCoordinate: here.coordinate, distance: distance, heading: heading, pitch: 50))
        }
    }

    private func toggleFollowing() {
        following.toggle()
        if following {
            if let here = location.location { follow(here, force: true) }
        } else {
            withAnimation { camera = .automatic }
        }
    }

    private var subtitle: String {
        if let done { return "\(Fmt.km(done.distanceM)) · \(done.dropoff.label ?? "")" }
        switch ride.status {
        case "riding":
            return String(localized: "\(ride.dropoff.label ?? String(localized: "Drop-off")) · \(Fmt.km(toDropoffM ?? ride.driverToDropoffM)) away")
        case "arrived":
            return String(localized: "The rider checks in once they’re inside the car.")
        case "awaiting_payment":
            return String(localized: "You can start driving to the pickup: \(ride.pickup.label ?? String(localized: "see the map"))")
        default:
            return ride.pickup.label ?? String(localized: "Pickup")
        }
    }

    @ViewBuilder
    private var actions: some View {
        if ride.status == "riding" {
            Button { Task { await checkOut() } } label: {
                if working { ProgressView().tint(Theme.onAccent) } else { Text("Check out") }
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(working || !canCheckOut)
            if !canCheckOut {
                Text("Check out at the drop-off: it opens within \(checkOutRadius) m\(toDropoffM.map { ", you’re \(Fmt.km($0)) away" } ?? "").")
                    .font(.footnote.monospacedDigit())
                    .foregroundStyle(Theme.muted)
            }
        } else if ride.status == "arrived" {
            if let from = ride.noShowFrom {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    if ServerClock.date(from) > ctx.date {
                        HStack {
                            Text("No check-in: you can claim 50% in").font(.footnote).foregroundStyle(Theme.muted)
                            Spacer()
                            Countdown(until: from, redBelow: 0)
                        }
                    } else {
                        Text("No check-in after 10 minutes: cancel with “Rider not there” to claim 50%.").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ok)
                    }
                }
            } else if !ride.isCash {
                Text("Stop at the pickup: your 10 minutes of waiting start when the car stands still.").font(.footnote).foregroundStyle(Theme.muted)
            }
        } else if ride.status == "awaiting_payment" {
            Text("Check-out: \(ride.dropoff.label ?? String(localized: "see the map"))").font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
        }
        if ride.driverLate == true {
            Text("You’re late: the rider can cancel for a full refund until they check in.")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.warn)
        }
        HStack(spacing: 10) {
            otherMaps
            Button("Cancel ride") { cancelling = true }
                .buttonStyle(GhostButtonStyle(height: 46, color: Theme.danger))
        }
        Button("Back") { app.driveOpen = false }.font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentInk).frame(maxWidth: .infinity)
    }

    // Apple's map, or another navigation app you may prefer.
    private var otherMaps: some View {
        let place = ride.status == "riding" ? ride.dropoff : ride.pickup
        return Menu {
            Button("Apple Maps") { openInMaps(place, name: place.label ?? (ride.status == "riding" ? String(localized: "Drop-off") : String(localized: "Pickup"))) }
            if hasGoogleMaps { Button("Google Maps") { open("comgooglemaps://?daddr=\(place.lat),\(place.lng)&directionsmode=driving") } }
            if hasWaze { Button("Waze") { open("waze://?ll=\(place.lat),\(place.lng)&navigate=yes") } }
        } label: {
            Text("Other maps")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .frame(maxWidth: .infinity, minHeight: 46)
                .background(Theme.ink.opacity(0.07), in: RoundedRectangle(cornerRadius: Theme.buttonRadius, style: .continuous))
                .contentShape(Rectangle())
        }
    }

    private func open(_ link: String) {
        if let url = URL(string: link) { UIApplication.shared.open(url) }
    }

    private func checkOut() async {
        guard let here = LocationService.shared.location?.coordinate else {
            error = String(localized: "We need your location to check out.")
            return
        }
        working = true
        error = nil
        defer { working = false }
        do {
            let r: RideResponse = try await APIClient.shared.post("/api/rides/\(ride.id)/check-out", ["lat": here.latitude, "lng": here.longitude])
            done = r.ride
            await app.syncNow()
        } catch { self.error = error.localizedDescription }
    }

    private var cancelMessage: String {
        if ride.isCash { return String(localized: "This ride is paid in cash, so no money moves.") }
        if ride.status == "awaiting_payment" { return String(localized: "The rider hasn’t paid yet, so no money moves.") }
        if ride.status == "riding" { return String(localized: "The rider gets everything back, also now they’re checked in, and you aren’t paid.") }
        if ride.status == "arrived", let from = ride.noShowFrom, ServerClock.date(from) <= Date() {
            return String(localized: "“Rider not there” claims 50% of the price, as you waited 10 minutes. For any other reason the rider gets everything back.")
        }
        return String(localized: "The rider gets everything back and you aren’t paid.")
    }

    private func cancel(_ reason: String) async {
        working = true
        defer { working = false }
        do {
            let _: RideResponse = try await APIClient.shared.post("/api/rides/\(ride.id)/driver-cancel", ["reason": reason])
            await app.syncNow()
            onClose()
        } catch { self.error = error.localizedDescription }
    }

    private func refreshOver() async {
        if let r: RideResponse = try? await APIClient.shared.get("/api/rides/\(ride.id)"), r.ride.status == "cancelled" { onClose() }
    }
}

// Where the map last went to, while following on a drive. Not state: it changes with every real move.
private final class FollowedSpot {
    var spot: CLLocation?
}

// The Map tab: orders closest and highest first; swipe down for the map. Green is now, red is booked for a time.
struct DriverMapView: View {
    @Environment(AppState.self) private var app
    @State private var orders: [MarketOrder] = []
    @State private var detent: PanelDetent = .middle
    @State private var mapRest: PanelDetent = .middle
    @Namespace private var mapSpace
    @State private var sort = 0
    @State private var open: MarketOrder?
    @State private var booked: [Ride] = []
    @State private var camera: MapCameraPosition = .userLocation(fallback: .automatic)
    @State private var centred = false
    @State private var heading = DriveHeading()
    private let location = LocationService.shared

    private var sorted: [MarketOrder] {
        (sort == 0 ? orders.sorted { ($0.awayM ?? 0) < ($1.awayM ?? 0) } : orders.sorted { ($0.bidCents ?? 0) > ($1.bidCents ?? 0) }).forYouFirst
    }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                MapReader { proxy in
                Map(position: $camera, scope: mapSpace) {
                    if let parked = heading.parked {
                        Annotation("", coordinate: parked, anchor: .center) { OwnVehicle(kind: app.driver?.activeCar?.kind, heading: heading) }.annotationTitles(.hidden)
                    } else {
                        UserAnnotation(anchor: .center) { _ in OwnVehicle(kind: app.driver?.activeCar?.kind, heading: heading) }
                    }
                    DriverMapPins(orders: orders, booked: booked, openOrder: { open = $0 }, openRide: openBooked)
                }
                .mapStyle(.drivezzz())
                .onMapCameraChange(frequency: .continuous) { heading.mapTurned(to: $0.camera.heading) }
                .onLocation { if let here = $0 { heading.moved(to: here) } }
                .mapControls { }
                // One place for a tap, which asks what was under the finger, as on Driving.
                .onTapGesture(coordinateSpace: .global) { point in
                    switch DriverMapPins.hit(at: point, proxy, orders: orders, booked: booked) {
                    case .order(let order): open = order
                    case .ride(let ride): openBooked(ride)
                    case nil: break
                    }
                }
                .ignoresSafeArea(edges: .top)
                .clearOfPanel(BottomPanel<EmptyView, EmptyView>.cover(mapRest, peek: 90, total: geo.size.height + geo.safeAreaInsets.bottom, tabBar: Room.tabBar(geo.safeAreaInsets.bottom)), width: geo.size.width)
                }
                VStack(alignment: .trailing, spacing: 8) {
                    RangeButton()
                    MapCompass(scope: mapSpace)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(.top, 8)
                .padding(.trailing, 12)
                BottomPanel(detent: $detent, peek: 90, tabBar: Room.tabBar(geo.safeAreaInsets.bottom)) {
                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 14) {
                            legend(Theme.now, String(localized: "Now"))
                            legend(Theme.planned, String(localized: "For a time"))
                            if !booked.isEmpty {
                                Label("Yours", systemImage: "checkmark").font(.footnote).foregroundStyle(Theme.muted)
                            }
                            Spacer()
                            Text(orders.count == 1 ? String(localized: "1 order") : String(localized: "\(orders.count) orders")).font(.footnote).foregroundStyle(Theme.faint)
                        }
                        Picker("Sort", selection: $sort) {
                            Text("Closest").tag(0)
                            Text("Highest bid").tag(1)
                        }
                        .pickerStyle(.segmented)
                        if sorted.isEmpty {
                            Text("No orders within \(Int(app.driverRadiusKm)) km right now.").font(.subheadline).foregroundStyle(Theme.muted).padding(.top, 6)
                        }
                        ForEach(sorted) { order in
                            Button { open = order } label: { OrderRow(order: order).padding(.vertical, 8) }.buttonStyle(.plain)
                            if order.id != sorted.last?.id { Divider() }
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .background(PanelRest(detent: $detent, rest: $mapRest))
        }
        .mapScope(mapSpace)
        .sheet(item: $open) { OrderSheet(order: $0).presentationDetents([.large]) }
        .task {
            // After the map's own first layout, which would otherwise win.
            try? await Task.sleep(for: .milliseconds(400))
            centre()
        }
        .onChange(of: location.hasFix) { _, _ in centre() }
        .task(id: app.rev) { await load() }
        .onChange(of: app.driverRadiusKm) { _, _ in Task { await load() } }
        .task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if app.isActive { await load() }
            }
        }
        .onChange(of: orders) { _, fresh in if let o = open, let same = fresh.first(where: { $0.id == o.id }) { open = same } }
    }

    private func centre() {
        guard !centred, let here = location.location?.coordinate else { return }
        centred = true
        // All of the area orders come from.
        camera = .region(MKCoordinateRegion(center: here, latitudinalMeters: app.driverRadiusKm * 2000, longitudinalMeters: app.driverRadiusKm * 2000))
    }

    private func legend(_ color: Color, _ text: String) -> some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 9, height: 9)
            Text(text).font(.footnote).foregroundStyle(Theme.muted)
        }
    }

    private func load() async {
        guard let here = location.location?.coordinate else { return }
        if let r: MarketResponse = try? await APIClient.shared.get("/api/driver/market?lat=\(here.latitude)&lng=\(here.longitude)&radiusKm=\(Int(app.driverRadiusKm))") {
            orders = r.orders ?? []
            if r.booked != nil || !booked.isEmpty { booked = r.booked ?? [] }
        }
    }

    // The drive on now opens on Driving, with its directions; another ride opens its page.
    private func openBooked(_ ride: Ride) {
        if app.driving.drive?.id == ride.id {
            app.driveOpen = true
            app.driverTab = 0
        } else {
            app.mapRide = ride
        }
    }
}

// What a tap on a driver's map was for: an order to claim, or a ride of their own.
enum DriverMapHit {
    case order(MarketOrder)
    case ride(Ride)
}

// The orders on a driver's map, and their own booked rides with a check, at the pickup they have (Pieter, 8 November 2026: a tap on
// a booked one's number opens that ride, as from the list). A tap goes to the map, which asks `hit` what was under the finger.
struct DriverMapPins: MapContent {
    var orders: [MarketOrder]
    var booked: [Ride]
    var openOrder: (MarketOrder) -> Void
    var openRide: (Ride) -> Void

    // An order the market still had a moment ago may be booked by now: it shows once, as booked.
    private var open: [MarketOrder] {
        let mine = Set(booked.map(\.id))
        return orders.filter { !mine.contains($0.id) }
    }

    var body: some MapContent {
        ForEach(open) { order in
            Annotation(order.dropoffLabel ?? String(localized: "Order"), coordinate: order.coordinate) {
                OrderPin(planned: order.isPlanned, cents: order.bidCents)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { openOrder(order) }
            }
            .annotationTitles(.hidden)
        }
        ForEach(booked) { ride in
            Annotation(ride.pickup.label ?? String(localized: "Your ride"), coordinate: ride.pickup.coordinate) {
                OrderPin(planned: ride.scheduledAt != nil, cents: ride.shownPriceCents, booked: true)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityAction { openRide(ride) }
            }
            .annotationTitles(.hidden)
        }
    }

    // The pin under a finger, the closest if there are more, by position as on the rider's map. Generous, as a finger is about 44
    // points and a price is small: a pin stands on its spot, its middle about 15 points above it, and up to about 90 wide.
    static func hit(at point: CGPoint, _ proxy: MapProxy, orders: [MarketOrder], booked: [Ride]) -> DriverMapHit? {
        var best: (hit: DriverMapHit, away: CGFloat)?
        func consider(_ hit: DriverMapHit, _ c: CLLocationCoordinate2D) {
            guard let spot = proxy.convert(c, to: .global) else { return }
            let dx = abs(point.x - spot.x), up = spot.y - point.y
            guard dx <= 48, up >= -14, up <= 46 else { return }
            let away = dx + abs(up - 15)
            if away < (best?.away ?? .infinity) { best = (hit, away) }
        }
        // Your own first: on the same spot, they win.
        for ride in booked { consider(.ride(ride), ride.pickup.coordinate) }
        let mine = Set(booked.map(\.id))
        for order in orders where !mine.contains(order.id) { consider(.order(order), order.coordinate) }
        return best?.hit
    }
}

// A booked ride opened from a driver's map. Next to the tabs, so opening it doesn't redo the map behind it.
struct RideSheetHost: View {
    @Environment(AppState.self) private var app

    var body: some View {
        @Bindable var app = app
        Color.clear
            .frame(width: 0, height: 0)
            .sheet(item: $app.mapRide) { ride in
                NavigationStack {
                    RideDetailView(ride: ride)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { app.mapRide = nil }.foregroundStyle(Theme.accentInk) } }
                }
            }
    }
}

// Report or block someone, from their page or a ride with them (App Store guideline 1.2).
struct PersonMenu: View {
    var userId: String
    var name: String
    var rideId: String?
    var canReportDropoff = false
    var offersChat = true
    var onRemoveChat: (() -> Void)?
    var onBlocked: () -> Void = {}
    @State private var chatting = false
    @State private var reporting = false
    @State private var confirmBlock = false
    @State private var thanks = false

    var body: some View {
        Menu {
            if offersChat { Button { chatting = true } label: { Label("Message \(name)", systemImage: "bubble.left") } }
            Button { reporting = true } label: { Label("Report \(name)", systemImage: "flag") }
            Button(role: .destructive) { confirmBlock = true } label: { Label("Block \(name)", systemImage: "hand.raised") }
            if let onRemoveChat { Button(role: .destructive) { onRemoveChat() } label: { Label("Remove chat", systemImage: "trash") } }
        } label: {
            Image(systemName: "ellipsis").accessibilityLabel("More")
        }
        .sheet(isPresented: $reporting) { ReportSheet(userId: userId, name: name, rideId: rideId, canReportDropoff: canReportDropoff).presentationDetents([.medium, .large]) }
        .sheet(isPresented: $chatting) {
            NavigationStack {
                ChatScreen(userId: userId, name: name)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { chatting = false } } }
            }
        }
        .confirmationDialog("Block \(name)?", isPresented: $confirmBlock, titleVisibility: .visible) {
            Button("Block", role: .destructive) {
                Task {
                    try? await APIClient.shared.call("POST", "/api/blocks", ["userId": userId])
                    onBlocked()
                }
            }
        } message: {
            Text("You won’t be matched with each other any more. A ride under way carries on. You can undo this in Profile.")
        }
    }
}

// Sending a report. Only this phone can open a chat: it hands over the keys to it, so that the report can be read.
enum Reporting {
    static let impossibleDropoff = "Impossible drop-off location"

    static func send(userId: String, reason: String, message: String, rideId: String?) async throws {
        var body: [String: Any] = ["userId": userId, "reason": reason, "message": message]
        if let rideId { body["rideId"] = rideId }
        if let chat: ChatThread = try? await APIClient.shared.get("/api/messages/\(userId)"), let messages = chat.messages, !messages.isEmpty {
            body["chatKeys"] = E2E.shared.reportKeys(messages)
        }
        try await APIClient.shared.call("POST", "/api/reports", body)
    }
}

struct ReportSheet: View {
    @Environment(\.dismiss) private var dismiss
    var userId: String
    var name: String
    var rideId: String?
    var canReportDropoff = false
    @State private var reason = "Unsafe driving"
    @State private var message = ""
    @State private var sent = false
    @State private var error: String?

    private var reasons: [String] {
        let usual = ["Unsafe driving", "Harassment or abuse", "Offensive photo or text", "Fraud or wrong car"]
        return usual + (canReportDropoff && rideId != nil ? [Reporting.impossibleDropoff] : []) + ["Something else"]
    }

    var body: some View {
        NavigationStack {
            Form {
                if sent {
                    Section {
                        Label("Thanks. We look at reports within 24 hours.", systemImage: "checkmark.circle")
                    }
                } else {
                    Section("What’s wrong?") {
                        Picker("Reason", selection: $reason) { ForEach(reasons, id: \.self) { Text(Fmt.reason($0)) } }
                            .pickerStyle(.inline)
                            .labelsHidden()
                    }
                    Section {
                        TextField("Optional", text: $message, axis: .vertical).lineLimit(3...6)
                    } header: {
                        Text("Anything to add?")
                    } footer: {
                        Text(reason == Reporting.impossibleDropoff ? String(localized: "This drive is added to the report, so we can see the planned route on a map. If you’ve messaged \(name), your chat is added too.") : String(localized: "Messages are end-to-end encrypted. If you’ve messaged \(name), your chat is added to this report so we can read it."))
                    }
                    if let error { Section { Text(error).font(.footnote).foregroundStyle(Theme.danger) } }
                }
            }
            .navigationTitle("Report \(name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(sent ? String(localized: "Done") : String(localized: "Close")) { dismiss() } }
                if !sent { ToolbarItem(placement: .confirmationAction) { Button("Send") { Task { await send() } } } }
            }
        }
    }

    private func send() async {
        do {
            try await Reporting.send(userId: userId, reason: reason, message: message, rideId: rideId)
            sent = true
        } catch { self.error = error.localizedDescription }
    }
}


private struct OrderFact: View {
    var symbol: String
    var value: String
    var label: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: symbol).font(.footnote.weight(.semibold)).foregroundStyle(Theme.muted)
            Text(value).font(.subheadline.weight(.bold).monospacedDigit()).lineLimit(1).minimumScaleFactor(0.8)
            Text(label).font(.caption2).foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Theme.ink.opacity(0.045), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
}

// A short explanation in a tinted box.
// Going online found only a person's look left: the car's number plate (it couldn't be read from the back photo), the documents, or
// both (Pieter, 8 November 2026). Not the checks again, as there's nothing to send: what it is, usually within 24 hours, and what
// the driver can do meanwhile. The words are the server's (checksNeeded in server/src/checks.js).
struct UnderReviewCard: View {
    @Environment(AppState.self) private var app
    var review: UnderReview

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                IconTile(symbol: "hourglass", tint: Theme.accentInk, background: Theme.accentSoft)
                VStack(alignment: .leading, spacing: 3) {
                    Text(review.title).font(.subheadline.weight(.bold)).foregroundStyle(Theme.ink)
                    Text(review.message).font(.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                }
            }
            HStack(spacing: 10) {
                // Another vehicle, or the back photo again: both on My page. The documents: what a person is looking at.
                if review.plate {
                    Button("My page") {
                        app.underReview = nil
                        app.driverTab = 3
                    }
                    .buttonStyle(GhostButtonStyle(height: 42))
                } else {
                    Button("See your checks") {
                        app.underReview = nil
                        app.checksOpen = true
                    }
                    .buttonStyle(GhostButtonStyle(height: 42))
                }
                Button("OK") { app.underReview = nil }.buttonStyle(PrimaryButtonStyle(height: 42))
            }
        }
        .padding(14)
        .floating(radius: 18)
    }
}

struct NoteBox: View {
    var symbol: String
    var tint: Color
    var background: Color
    var text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol).foregroundStyle(tint)
            Text(text).font(.footnote).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(background, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }
}

// How far you look for orders: 1 to 40 km. Shared by Driving and Map.
struct RangeButton: View {
    @Environment(AppState.self) private var app
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            Label("\(Int(app.driverRadiusKm)) km", systemImage: "scope")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 14)
                .frame(height: 38)
                .background(Theme.card, in: Capsule())
                .lifted(0.8, radius: 19)
        }
        .accessibilityLabel("Orders within \(Int(app.driverRadiusKm)) kilometres")
        .sheet(isPresented: $open) {
            @Bindable var app = app
            VStack(alignment: .leading, spacing: 16) {
                Text("Orders within").font(.headline)
                Text("\(Int(app.driverRadiusKm)) km").font(.system(size: 44, weight: .bold).monospacedDigit()).kerning(-1).foregroundStyle(Theme.ink).contentTransition(.numericText())
                Slider(value: $app.driverRadiusKm, in: 1...40, step: 1).tint(Theme.accent)
                HStack { Text("1 km"); Spacer(); Text("40 km") }.font(.caption).foregroundStyle(Theme.faint)
                Text("Further away means a longer way to the pickup, which isn’t paid on a rider’s named price.").font(.footnote).foregroundStyle(Theme.muted)
            }
            .padding(24)
            .presentationDetents([.height(300)])
        }
    }
}
