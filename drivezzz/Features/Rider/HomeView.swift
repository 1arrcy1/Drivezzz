import CoreLocation
import MapKit
import SwiftUI

// Booking, in one place. The list is what you see first; swipe it down for the map of drivers.
@Observable
final class Booking {
    var pickup: Place?              // nil: where you are
    var dropoff: Place?
    var passengers = 1
    var pets = false
    var vehicle: String?            // nil: any
    // A coin saved before Drivezzz went Solana-only (XRP, LTC, XLM) no longer counts.
    var coin = UserDefaults.standard.string(forKey: "payCoin").flatMap { Coins.payWith.contains($0) ? $0 : nil } ?? "sol" { didSet { UserDefaults.standard.set(coin, forKey: "payCoin") } }
    var planned = false
    var planDate = Date().addingTimeInterval(3600)
    var quote: Quote?
    var driverId: String?           // chosen by the rider; nil: the cheapest
    var openDriver: DriverCard?     // whose page is open. Here, so that opening one doesn't redo the home screen and its map behind the sheet
    var namingRoute = false         // saving this route: its name is being asked for. Here for the same reason
    var payingFor: OrderToPay?      // an order about to go out, asking how to pay. Here for the same reason
    var bidding = false
    var bidCents = 0
    var loading = false
    var error: String?

    var scheduledAt: Double? { planned ? planDate.ms : nil }
    var chosenOffer: DriverCard? {
        guard let offers = quote?.offers else { return nil }
        if let driverId, let match = offers.first(where: { $0.id == driverId }) { return match }
        return driverId == nil ? offers.first : nil
    }
    // Who a tap picked, on the map or in the list: with a route the one the Book button books, before it whoever was tapped.
    // A tap on the picked one opens their page (Pieter, 5 November 2026).
    var picked: String? { quote == nil ? driverId : chosenOffer?.id }

    func clear() {
        pickup = nil
        dropoff = nil
        quote = nil
        driverId = nil
        bidding = false
        error = nil
        planned = false
    }
}

// An order that only needs to know how it's paid. `takes` is what the rider can pick; nil: anything.
struct OrderToPay: Identifiable {
    let id = UUID()
    var mode: String
    var bid: Int?
    var cents: Int?
    var driver: String?
    var takes: [String]?
}

struct HomeView: View {
    @Environment(AppState.self) private var app
    private let location = LocationService.shared

    @State private var booking = Booking()
    @State private var detent: PanelDetent = .middle
    @State private var mapRest: PanelDetent = .middle
    @State private var routeCard: CGFloat = 104
    @State private var camera: MapCameraPosition = .userLocation(fallback: .automatic)
    @State private var centred = false
    @State private var drivers: [DriverCard] = []
    @State private var totalOnline: Int?
    @State private var lookedFrom: Place?                    // where the last look was from
    @State private var requotedFor: String?                  // the new prices a quote was last asked again for
    @State private var labelled: Set<String> = []      // whose pin shows their price and stars: the first ones that fit
    @State private var covered: Set<String> = []       // who would land under one of those: not drawn until there's room
    @State private var farOut = false                  // too far out for circles as well: only a chosen driver stays
    @State private var bidPlaced = false               // the price is named: how to pay is asked once its sheet is gone
    @State private var mapWatch = MapWatch()
    @State private var steadyDriver = SteadyCar()       // your driver's car: still for GPS wobble, gliding for a real move
    @AppStorage("driversSort") private var sortName = DriverSort.cheapest.rawValue
    @State private var radiusKm = 10.0
    @State private var petsOnly = false
    @State private var showFilter = false
    @State private var searching = false
    @State private var showPay = false
    @State private var ordering = false
    @State private var showBid = false
    @State private var payStage = false
    @State private var quoteRun = 0

    private var mine: Place? {
        guard let c = location.location?.coordinate else { return nil }
        return Place(lat: c.latitude, lng: c.longitude, label: String(localized: "Your location"))
    }
    private var routeCoordinates: [CLLocationCoordinate2D] {
        Polyline.decode(booking.quote?.polyline).map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
    }

    // With a ride: how it's going and the road stay in view with the panel down.
    // With a quote: all of the route's card, so the distance and the time show too, however long its text gets.
    private var peek: CGFloat { app.ride != nil ? 138 : booking.quote == nil ? 110 : routeCard + 30 }

    private var sort: DriverSort { DriverSort(rawValue: sortName) ?? .cheapest }

    // Planning a ride: only drivers who take planned rides.
    private var shownDrivers: [DriverCard] {
        booking.planned ? drivers.filter { $0.allowsPlanning != false } : drivers
    }

    private static let onList = 50      // who you can choose from
    private static let onMap = 5        // who gets a pin: more only fills the map with circles

    // The cheapest of the list, with their price for this ride if there is one. A driver chosen from the list shows as well.
    private var pins: [DriverCard] {
        let priced = (booking.quote?.offers ?? []).compactMap(latest)
        let around = priced.isEmpty ? shownDrivers.filter { $0.coordinate != nil } : priced
        var cheapest = Array(DriverSort.cheapest.sorted(around).prefix(Self.onMap))
        if let id = booking.picked, !cheapest.contains(where: { $0.id == id }), let chosen = around.first(where: { $0.id == id }) { cheapest.append(chosen) }
        return cheapest
    }

    // A driver of the quote as the latest look has them: where they are now, and gone once they're booked or offline. Only a look that
    // has everyone around can say someone's gone, and only for who's within it: a quote looks further when there are few.
    private func latest(_ offer: DriverCard) -> DriverCard? {
        guard offer.coordinate != nil else { return nil }
        if let now = drivers.first(where: { $0.id == offer.id }) {
            var moved = offer
            moved.lat = now.lat
            moved.lng = now.lng
            moved.heading = now.heading
            return moved
        }
        guard let from = lookedFrom, let total = totalOnline, total <= drivers.count, let c = offer.coordinate else { return offer }
        let within = CLLocation(latitude: from.lat, longitude: from.lng).distance(from: CLLocation(latitude: c.latitude, longitude: c.longitude)) < radiusKm * 1000 - 200
        return within ? nil : offer
    }

    // Picked before there's a route: the footer offers to book with them.
    private var pickedDriver: DriverCard? {
        guard booking.quote == nil, let id = booking.driverId else { return nil }
        return shownDrivers.first { $0.id == id }
    }

    var body: some View {
        GeometryReader { geo in
            let tabBar = Room.tabBar(geo.safeAreaInsets.bottom)
            // How far down the map can be seen, for which pins are worth a label. Not state: nothing on screen depends on it.
            let _ = mapWatch.clearDown = Room.wide(geo.size.width) ? geo.size.height : geo.size.height + geo.safeAreaInsets.bottom - BottomPanel<EmptyView, EmptyView>.cover(mapRest, peek: peek, total: geo.size.height + geo.safeAreaInsets.bottom, tabBar: tabBar)
            let _ = mapWatch.clearWidth = geo.size.width
            ZStack(alignment: .top) {
                map.clearOfPanel(BottomPanel<EmptyView, EmptyView>.cover(mapRest, peek: peek, total: geo.size.height + geo.safeAreaInsets.bottom, tabBar: tabBar), width: geo.size.width)
                VStack(alignment: .trailing, spacing: 8) {
                    filterButton
                    centreButton
                }
                .padding(.trailing, 14)
                .padding(.top, 8)
                .frame(maxWidth: .infinity, alignment: .trailing)
                BottomPanel(detent: $detent, peek: peek, tabBar: tabBar) {
                    panel.padding(.horizontal, 18)
                } footer: {
                    if app.ride == nil, booking.quote != nil {
                        actions
                            .padding(.horizontal, 18)
                            .padding(.top, 8)
                            .padding(.bottom, 6)
                            .background(Theme.card)
                            .overlay(alignment: .top) { Divider() }
                    } else if app.ride == nil, !searching, let d = pickedDriver {
                        pickedActions(d)
                            .padding(.horizontal, 18)
                            .padding(.top, 8)
                            .padding(.bottom, 6)
                            .background(Theme.card)
                            .overlay(alignment: .top) { Divider() }
                    }
                }
            }
            .background(PanelRest(detent: $detent, rest: $mapRest))
        }
        .escrowMoment(status: app.showingRide == nil ? app.ride?.status : nil, price: Fmt.eur(app.ride?.shownPriceCents), coin: app.ride?.coin)
        .sheet(isPresented: $showFilter) { filterSheet.presentationDetents([.medium, .large]) }
        .modifier(DriverPageSheet(booking: booking) { d, planned in choose(d, planned: planned) })
        .modifier(RouteNaming(booking: booking))
        .sheet(isPresented: $showBid, onDismiss: askToPayForBid) { bidSheet.presentationDetents([.medium]) }
        .modifier(PayChoiceSheet(booking: booking) { order in Task { await self.order(mode: order.mode, bid: order.bid) } })
        .task(id: location.hasFix) { await loop() }
        .task {
            // After the map's own first layout, which would otherwise win.
            try? await Task.sleep(for: .milliseconds(400))
            centre()
        }
        .onChange(of: location.hasFix) { _, _ in centre() }
        .onChange(of: app.ride?.id) { _, id in
            withAnimation(PanelDetent.spring) { detent = id == nil ? .middle : .peek }
            if let line = app.ride?.route.map({ (lat: $0.latitude, lng: $0.longitude) }), let region = regionFitting(line) { withAnimation { camera = .region(region) } }
        }
        .onChange(of: [app.ride?.driver?.lat, app.ride?.driver?.lng], initial: true) { _, _ in steadyDriver.follow(app.ride?.driver?.coordinate, ride: app.ride?.id) }
        // Late: the panel comes up by itself, with the green button.
        .onChange(of: app.ride?.driverLate) { _, late in
            if late == true { withAnimation(PanelDetent.spring) { detent = .middle } }
        }
        .onChange(of: radiusKm) { _, _ in Task { await loadDrivers() } }
        .onChange(of: petsOnly) { _, _ in Task { await loadDrivers() } }
        .onChange(of: sortName) { _, _ in
            Task {
                await loadDrivers()
                if booking.quote != nil {
                    booking.driverId = nil
                    await getQuote()
                }
            }
        }
        .onChange(of: mapRest) { _, _ in updatePins(settled: true) }
        .onChange(of: booking.driverId) { _, _ in updatePins(settled: true) }
        // A saved route, picked in Rides.
        .onChange(of: app.routeToUse) { _, route in
            guard let route else { return }
            app.routeToUse = nil
            guard app.ride == nil else { return }
            booking.clear()
            booking.pickup = route.pickup
            booking.dropoff = route.dropoff
            Task { await getQuote(showRoute: true) }
        }
    }

    // ---------- the map ----------

    private var map: some View {
        MapReader { proxy in
            Map(position: $camera, interactionModes: .all) {
                UserAnnotation()
                if let ride = app.ride {
                    if ["searching", "offered", "open"].contains(ride.status) {
                        Annotation("", coordinate: ride.pickup.coordinate, anchor: .center) { Radar() }.annotationTitles(.hidden)
                    }
                    let line = ride.route
                    if !line.isEmpty {
                        MapPolyline(coordinates: line).stroke(Theme.routeEdge, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
                        MapPolyline(coordinates: line).stroke(Theme.route, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                    }
                    Marker("Pickup", systemImage: "figure.wave", coordinate: ride.pickup.coordinate).tint(Theme.pickupPin)
                    Marker("Drop-off", systemImage: "flag.fill", coordinate: ride.dropoff.coordinate).tint(Theme.accent)
                    if let c = steadyDriver.spot ?? ride.driver?.coordinate { Annotation(ride.driver?.car?.shownPlate ?? String(localized: "Your driver"), coordinate: c, anchor: .center) { DriverPin(vehicle: ride.driver?.car?.kind, eta: ride.etaShort) } }
                } else {
                    ForEach(pins) { d in
                        Annotation(d.car?.shownPlate ?? d.name ?? String(localized: "Driver"), coordinate: d.coordinate!, anchor: .center) {
                            PricePin(vehicle: d.car?.kind, text: priceTag(of: d), eta: pickupTime(of: d), rating: d.rating, verified: d.verified == true, selected: booking.picked == d.id, busy: d.busy == true, style: pinStyle(of: d))
                                // How wide it's drawn, for what a tap counts as on it. Not state: nothing on screen depends on it.
                                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { mapWatch.pinWidths[d.id] = $0 }
                                .accessibilityAddTraits(.isButton)
                                .accessibilityAction { tappedPin(d) }
                                .accessibilityAction(named: "See driver") { booking.openDriver = d }
                        }
                        .annotationTitles(.hidden)
                    }
                }
                // Moved by hand, before there's a route: the spot shows right away.
                if app.ride == nil, booking.quote == nil, let p = booking.pickup {
                    Marker("Pickup", systemImage: "figure.wave", coordinate: p.coordinate).tint(Theme.pickupPin)
                }
                if let q = booking.quote {
                    if !routeCoordinates.isEmpty {
                        MapPolyline(coordinates: routeCoordinates).stroke(Theme.routeEdge, style: StrokeStyle(lineWidth: 8, lineCap: .round, lineJoin: .round))
                        MapPolyline(coordinates: routeCoordinates).stroke(Theme.route, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                    }
                    Marker("Pickup", systemImage: "figure.wave", coordinate: q.pickup.coordinate).tint(Theme.pickupPin)
                    // Moved to where the road ends: where you tapped stays faint, dashed to where the car can get.
                    if let tapped = booking.dropoff, (q.dropoff.movedM ?? 0) > 25 {
                        MapPolyline(coordinates: [tapped.coordinate, q.dropoff.coordinate]).stroke(Theme.ink.opacity(0.5), style: StrokeStyle(lineWidth: 2.5, lineCap: .round, dash: [3, 6]))
                        Annotation("Where you tapped", coordinate: tapped.coordinate) {
                            Circle().fill(Theme.ink.opacity(0.35)).frame(width: 12, height: 12).overlay(Circle().stroke(.white, lineWidth: 2))
                        }
                        .annotationTitles(.hidden)
                    }
                    Marker("Drop-off", systemImage: "flag.fill", coordinate: q.dropoff.coordinate).tint(Theme.accent)
                } else if let d = booking.dropoff {
                    Marker("Drop-off", systemImage: "flag.fill", coordinate: d.coordinate).tint(Theme.accent)
                }
            }
            .mapStyle(.drivezzz())
            // Keeps a route clear of the clock and the camera.
            .safeAreaPadding(.top, 64)
            .mapControls { }
            // On the screen, not in the map's own space: its padding would put the spot off from where you tapped.
            // The map hears a tap on a pin as well, whatever the pin does with it, so a tap goes to one place and asks here who it's for.
            .onTapGesture(coordinateSpace: .global) { point in
                guard app.ride == nil else { return }
                if let d = driverPin(at: point, proxy) { tappedPin(d); return }
                guard let c = proxy.convert(point, from: .global) else { return }
                Task { await tapped(c) }
            }
            // Holding a driver shows who it is, whatever a tap does right now. Holding the map moves the pickup: the driver waits there.
            .background(MapHold { point in
                guard app.ride == nil, app.riderTab == 0, booking.openDriver == nil, !showFilter, !showBid, let c = proxy.convert(point, from: .global) else { return }
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                if let d = driverPin(at: point, proxy) { booking.openDriver = d } else { Task { await movePickup(to: c) } }
            })
            .onMapCameraChange(frequency: .continuous) { context in
                mapWatch.region = context.region
                mapWatch.proxy = proxy
                updatePins(settled: false)
            }
            .onMapCameraChange(frequency: .onEnd) { context in
                mapWatch.region = context.region
                mapWatch.proxy = proxy
                updatePins(settled: true)
            }
        }
        .ignoresSafeArea(edges: .top)
        // The keyboard would squeeze the map, frame by frame, and leave it zoomed out.
        .ignoresSafeArea(.keyboard)
    }

    private var filterButton: some View {
        Button { showFilter = true } label: {
            Label("\(Int(radiusKm)) km", systemImage: "slider.horizontal.3")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 14)
                .frame(height: 44)
                .glassy(in: Capsule())
        }
        .accessibilityLabel("Filter, showing drivers within \(Int(radiusKm)) kilometres")
    }

    private var centreButton: some View {
        Button { centre(force: true) } label: {
            Image(systemName: "location.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Theme.ink)
                .frame(width: 44, height: 44)
                .glassy(in: Circle())
        }
        .accessibilityLabel("Show where I am")
    }

    private var filterSheet: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Show first", selection: $sortName) {
                        ForEach(DriverSort.allCases) { Text($0.name).tag($0.rawValue) }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Show first")
                } footer: {
                    Text("In the list. The map shows the \(Self.onMap) cheapest. Best rated also counts how many reviews a driver has, so one 5-star review doesn’t come first.")
                }
                Section("Show drivers within") {
                    VStack(alignment: .leading) {
                        Text("\(Int(radiusKm)) km").font(.headline)
                        Slider(value: $radiusKm, in: 1...40, step: 1)
                    }
                }
                Section("Vehicle") {
                    Picker("Vehicle", selection: Binding(get: { booking.vehicle ?? "" }, set: { booking.vehicle = $0.isEmpty ? nil : $0; Task { await loadDrivers() } })) {
                        Text("Any").tag("")
                        ForEach(Vehicle.all, id: \.self) { Text(Vehicle.name($0)).tag($0) }
                    }
                    .pickerStyle(.segmented)
                }
                Section {
                    Toggle("Pets allowed", isOn: $petsOnly)
                }
            }
            .navigationTitle("Filter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showFilter = false } } }
        }
    }

    // ---------- the panel ----------

    @ViewBuilder
    private var panel: some View {
        if let ride = app.ride {
            activeRide(ride)
        } else if booking.quote != nil {
            quoteStage
        } else {
            idleStage
        }
    }

    // The whole ride's price once there's a quote, what they ask per km until then.
    private func priceTag(of d: DriverCard) -> String {
        if let price = booking.quote?.offers?.first(where: { $0.id == d.id })?.priceCents { return Fmt.eur(price) }
        return "\(Fmt.rate(d.perKmCents))/km"
    }

    // With drivers sorted by it, the reason they're where they are.
    private func onTimeNote(_ d: DriverCard) -> String? {
        guard sort == .onTime else { return nil }
        return d.arrivalScore.map { String(localized: "\($0)% on time") } ?? String(localized: "No rides yet")
    }

    // Once there's a quote: how long this driver needs to get to you.
    private func pickupTime(of d: DriverCard) -> String? {
        booking.quote?.offers?.first { $0.id == d.id }?.pickupS.map { Fmt.minutes($0) }
    }

    private func activeRide(_ ride: Ride) -> some View {
        VStack(alignment: .leading, spacing: 14) {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(ride.statusTitle).font(.title3.weight(.bold)).kerning(-0.3).foregroundStyle(Theme.ink).lineLimit(1).minimumScaleFactor(0.8)
                Text(ride.comingLine ?? ride.dropoff.label ?? String(localized: "Your ride")).font(.subheadline.monospacedDigit()).foregroundStyle(Theme.muted).lineLimit(1).contentTransition(.numericText())
            }
            Spacer(minLength: 8)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.faint)
        }
        .panelTap { app.showingRide = ride }
        RideSteps(ride: ride)
        if let d = ride.driver {
            HStack(spacing: 12) {
                CarTile(car: d.car, size: 50)
                VStack(alignment: .leading, spacing: 4) {
                    Text(d.name ?? String(localized: "Your driver")).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    if let plate = d.car?.shownPlate { PlateView(plate: plate, size: 12) }
                }
                Spacer(minLength: 8)
                MessageButton(userId: d.id, name: d.name ?? String(localized: "your driver"))
            }
        }
        if RideStateCard.shows(ride) { RideStateCard(ride: ride).frame(maxWidth: .infinity, alignment: .leading) }
        // A driver accepted: pay right here.
        if ride.needsPayment { PayRideCard(ride: ride) }
        if RideCancelButton.shows(ride) { RideCancelButton(ride: ride).frame(maxWidth: .infinity, alignment: .leading) }
        }
        .padding(.top, 2)
    }

    private var idleStage: some View {
        VStack(alignment: .leading, spacing: 14) {
            WhereToSearch(booking: booking, active: $searching) { Task { await getQuote(showRoute: true) } }
            if !searching {
                if let spot = booking.pickup { movedPickup(spot) }
                WhenSwitch(planned: $booking.planned)
                if booking.planned {
                    DatePicker("Pick-up", selection: $booking.planDate, in: Date().addingTimeInterval(16 * 60)...Date().addingTimeInterval(7 * 86400))
                        .font(.subheadline.weight(.medium))
                        .tint(Theme.accent)
                }
                cheapestList.padding(.top, 6)
            }
        }
        .padding(.top, 2)
        .onChange(of: searching) { _, now in withAnimation(PanelDetent.spring) { detent = now ? .full : .middle } }
    }

    // A pickup moved away from where you are, and the way back.
    private func movedPickup(_ spot: Place) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "figure.wave").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.pickupPin).frame(width: 22)
            VStack(alignment: .leading, spacing: 1) {
                Text(spot.label ?? String(localized: "Pickup")).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                Text("Your pickup: your driver waits here").font(.caption).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(Theme.ink).frame(width: 30, height: 30).background(Theme.card, in: Circle())
                .panelTap {
                    booking.pickup = nil
                    Task { await loadDrivers() }
                }
                .accessibilityLabel("Pick up where I am")
        }
        .padding(10)
        .background(Theme.soft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }

    private var cheapestList: some View {
        VStack(alignment: .leading, spacing: 0) {
            let online = booking.planned ? shownDrivers.count : max(totalOnline ?? 0, shownDrivers.count)
            HStack {
                sortMenu(.title3.weight(.bold))
                Spacer()
                HStack(spacing: 5) {
                    Circle().fill(shownDrivers.isEmpty ? Theme.faint : Theme.ok).frame(width: 7, height: 7)
                    Text("\(online) online").font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
                }
            }
            .padding(.bottom, 8)
            if online > Self.onMap, !booking.planned {
                Text("The \(Self.onMap) cheapest are on the map.")
                    .font(.footnote)
                    .foregroundStyle(Theme.muted)
                    .padding(.bottom, 6)
            }
            if shownDrivers.isEmpty {
                Text(booking.planned ? String(localized: "No driver within \(Int(radiusKm)) km takes planned rides right now. You can still name your price.") : String(localized: "No drivers online within \(Int(radiusKm)) km right now. You can still plan a ride, or name your price."))
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            let list = Array(sort.sorted(shownDrivers).prefix(Self.onList))
            // A tap picks a driver to book with, a tap on the picked one opens their page; so does their vehicle's picture.
            ForEach(list) { d in
                let selected = booking.driverId == d.id
                Button { if selected { booking.openDriver = d } else { booking.driverId = d.id } } label: {
                    DriverRow(driver: d, price: nil, note: onTimeNote(d), selected: selected) { booking.openDriver = d }
                        .padding(10)
                        .background(selected ? Theme.accentSoft.opacity(0.55) : .clear, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).stroke(selected ? Theme.accent : .clear, lineWidth: 2))
                        .animation(.snappy(duration: 0.2), value: selected)
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
                .contextMenu { Button("See driver") { booking.openDriver = d } }
            }
        }
    }

    // What comes first in the list, right on top of it.
    private func sortMenu(_ font: Font) -> some View {
        Menu {
            Picker("Show first", selection: $sortName) {
                ForEach(DriverSort.allCases) { Text($0.name).tag($0.rawValue) }
            }
        } label: {
            HStack(spacing: 5) {
                Text(sort.listTitle).font(font).kerning(-0.3).foregroundStyle(Theme.ink)
                Image(systemName: "chevron.down").font(.caption.weight(.bold)).foregroundStyle(Theme.accentInk)
            }
        }
    }

    private var quoteStage: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 10) {
                    placeLine("circle.fill", booking.quote?.pickup.label ?? String(localized: "Your location"), booking.quote?.pickup.movedM, note: String(localized: "Your driver waits here. Hold the map to move it."))
                    placeLine("flag.fill", booking.quote?.dropoff.label ?? String(localized: "Drop-off"), booking.quote?.dropoff.movedM)
                    Text("\(Fmt.km(booking.quote?.distanceM)) · \(Fmt.minutes(booking.quote?.durationS))\(booking.quote?.estimated == true ? String(localized: " · estimate") : "")")
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(Theme.muted)
                        .padding(.leading, 24)
                }
                Spacer(minLength: 0)
                VStack(spacing: 8) {
                    Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(Theme.ink).frame(width: 30, height: 30).background(Theme.card, in: Circle())
                        .panelTap { withAnimation { booking.clear() } }
                        .accessibilityLabel("Start over")
                    let saved = SavedRoutes.shared.has(pickup: booking.quote?.pickup, dropoff: booking.quote?.dropoff)
                    Image(systemName: saved ? "bookmark.fill" : "bookmark").font(.caption.weight(.bold)).foregroundStyle(saved ? Theme.accentInk : Theme.ink).frame(width: 30, height: 30).background(Theme.card, in: Circle())
                        .panelTap { if !saved { booking.namingRoute = true } }
                        .accessibilityLabel(saved ? String(localized: "This route is saved") : String(localized: "Save this route"))
                }
            }
            .padding(14)
            .background(Theme.soft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { routeCard = $0 }
            options
            offersList
            holdNote
            ErrorText(text: booking.error)
        }
    }

    private func placeLine(_ icon: String, _ text: String, _ moved: Int?, note: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: icon).font(.system(size: 11)).foregroundStyle(icon == "circle.fill" ? Theme.pickupPin : Theme.ink).frame(width: 14)
            VStack(alignment: .leading, spacing: 1) {
                Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                if let note { Text(note).font(.caption).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
                if let moved, moved > 25 {
                    Text(icon == "flag.fill" && moved > 150
                         ? String(localized: "Moved \(moved) m to where the road ends: your driver can’t get closer. Check-out works within 200 m of the flag.")
                         : String(localized: "Moved \(moved) m to where a car can stop"))
                        .font(.caption)
                        .foregroundStyle(Theme.faint)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var options: some View {
        VStack(spacing: 8) {
            WhenSwitch(planned: $booking.planned) { booking.driverId = nil; Task { await getQuote() } }
            if booking.planned {
                DatePicker("Pick-up", selection: Binding(get: { booking.planDate }, set: { booking.planDate = $0; Task { await getQuote() } }), in: Date().addingTimeInterval(16 * 60)...Date().addingTimeInterval(7 * 86400))
                    .font(.subheadline)
            }
            HStack(spacing: 8) {
                Menu {
                    ForEach(1...8, id: \.self) { n in
                        Button(Fmt.people(n)) { booking.passengers = n; Task { await getQuote() } }
                    }
                } label: {
                    optionChip("\(booking.passengers)", "person.2")
                }
                Button { booking.pets.toggle(); Task { await getQuote() } } label: {
                    optionChip("Pet", "pawprint", on: booking.pets)
                }
                .accessibilityLabel(booking.pets ? String(localized: "Bringing a pet") : String(localized: "No pet"))
                Menu {
                    Button("Any vehicle") { booking.vehicle = nil; booking.driverId = nil; Task { await getQuote() } }
                    ForEach(Vehicle.all, id: \.self) { kind in
                        Button(Vehicle.name(kind)) { booking.vehicle = kind; booking.driverId = nil; Task { await getQuote() } }
                    }
                } label: {
                    optionChip(booking.vehicle.map(Vehicle.name) ?? String(localized: "Any"), booking.vehicle.map(Vehicle.icon) ?? "car.side")
                }
                Spacer()
                Menu {
                    ForEach(Coins.payWith, id: \.self) { c in
                        Button(Fmt.coinName(c)) { booking.coin = c; booking.driverId = nil; Task { await getQuote() } }
                    }
                } label: {
                    optionChip(Fmt.coinSymbol(booking.coin), booking.coin == Coins.cash ? "banknote" : "bitcoinsign.circle")
                }
            }
        }
    }

    private func optionChip(_ text: String, _ icon: String, on: Bool = false) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).foregroundStyle(on ? Theme.onAccent : Theme.ink)
            Text(text).foregroundStyle(on ? Theme.onAccent : Theme.ink)
        }
        .font(.footnote.weight(.semibold))
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(on ? Theme.accent : Theme.soft, in: Capsule())
    }

    private var offersList: some View {
        VStack(alignment: .leading, spacing: 0) {
            if booking.loading {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 12)
            } else if let offers = booking.quote?.offers, !offers.isEmpty {
                let list = Array(sort.sorted(offers).prefix(Self.onList))
                let cheapest = offers.min { ($0.priceCents ?? 0) < ($1.priceCents ?? 0) }?.id
                HStack {
                    sortMenu(.subheadline.weight(.semibold))
                    Spacer()
                    Text("\(list.count) \(list.count == 1 ? String(localized: "driver") : String(localized: "drivers"))").font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
                }
                .padding(.bottom, 8)
                ForEach(list) { d in
                    let selected = booking.chosenOffer?.id == d.id
                    Button {
                        if selected { booking.openDriver = d } else { booking.driverId = d.id }
                    } label: {
                        HStack(spacing: 8) {
                            DriverRow(driver: d, price: d.priceCents, label: d.id == cheapest ? String(localized: "Cheapest") : nil, note: d.afterAnotherDrive == true ? String(localized: "Already nearby after another drive") : onTimeNote(d), selected: selected) { booking.openDriver = d }
                        }
                        .padding(10)
                        .background(selected ? Theme.accentSoft.opacity(0.55) : .clear, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).stroke(selected ? Theme.accent : .clear, lineWidth: 2))
                        .animation(.snappy(duration: 0.2), value: selected)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .contextMenu { Button("See driver") { booking.openDriver = d } }
                }
            } else {
                Text(booking.planned ? String(localized: "No driver fits this time yet. Name your price and drivers can claim it.") : String(localized: "No drivers can take this right now. Name your price and drivers nearby can claim it."))
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 10) {
            Button("Your price") {
                booking.bidCents = booking.quote?.suggestedBidCents ?? 1000
                showBid = true
            }
            .buttonStyle(PanelTap(GhostButtonStyle(height: 50)))
            .frame(maxWidth: booking.chosenOffer == nil ? .infinity : 112)
            if let offer = booking.chosenOffer {
                Button { askToPay() } label: {
                    if ordering { ProgressView().tint(Theme.onAccent) } else { Text("\(booking.planned ? String(localized: "Plan") : String(localized: "Book")) for \(Fmt.eur(offer.priceCents))") }
                }
                .buttonStyle(PanelTap(PrimaryButtonStyle()))
                .disabled(ordering)
            }
        }
    }

    // A driver picked before there's a route: book with them, which asks where to; or let it be anyone again.
    private func pickedActions(_ d: DriverCard) -> some View {
        HStack(spacing: 10) {
            Button("Anyone") { booking.driverId = nil }
                .buttonStyle(PanelTap(GhostButtonStyle(height: 50)))
                .frame(maxWidth: 112)
            Button { choose(d, planned: booking.planned) } label: {
                Text("\(booking.planned ? String(localized: "Plan") : String(localized: "Book")) with \(d.name ?? String(localized: "this driver"))").lineLimit(1).minimumScaleFactor(0.8)
            }
            .buttonStyle(PanelTap(PrimaryButtonStyle()))
        }
    }

    @ViewBuilder
    private var holdNote: some View {
        CancelTerms(planned: booking.planned)
    }

    private var bidSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                ScreenTitle(title: String(localized: "Name your price"), subtitle: String(localized: "Drivers nearby see your order on their map and can claim it at this price."))
                HStack {
                    Button { booking.bidCents = max(100, booking.bidCents - 50) } label: { Image(systemName: "minus").fontWeight(.semibold).foregroundStyle(Theme.ink).frame(width: 52, height: 52).background(Theme.soft, in: Circle()) }
                        .accessibilityLabel("50 cents less")
                    Spacer()
                    Text(Fmt.eur(booking.bidCents)).font(.system(size: 50, weight: .bold).monospacedDigit()).kerning(-1.2).foregroundStyle(Theme.ink).contentTransition(.numericText()).animation(.snappy(duration: 0.15), value: booking.bidCents)
                    Spacer()
                    Button { booking.bidCents = min(100_000, booking.bidCents + 50) } label: { Image(systemName: "plus").fontWeight(.semibold).foregroundStyle(Theme.ink).frame(width: 52, height: 52).background(Theme.soft, in: Circle()) }
                        .accessibilityLabel("50 cents more")
                }
                PriceRuler(cents: $booking.bidCents, cheapest: booking.quote?.offers?.first?.priceCents)
                if let cheapest = booking.quote?.offers?.first?.priceCents {
                    HStack(spacing: 6) {
                        Circle().fill(Theme.ok).frame(width: 7, height: 7)
                        Text("The cheapest driver right now asks \(Fmt.eur(cheapest)).").font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
                ErrorText(text: booking.error)
                Button {
                    bidPlaced = true
                    showBid = false
                } label: { Text("Place order for \(Fmt.eur(booking.bidCents))") }
                    .buttonStyle(PrimaryButtonStyle())
                Spacer()
            }
            .padding(24)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { showBid = false } } }
        }
    }

    // ---------- doing things ----------

    // Around you, once your position is known; the map doesn't get there by itself.
    private func centre(force: Bool = false) {
        guard force || !centred, let here = location.location?.coordinate else { return }
        centred = true
        withAnimation { camera = .region(MKCoordinateRegion(center: here, latitudinalMeters: 6000, longitudinalMeters: 6000)) }
    }

    // Only for someone looking at it: with many people around, every look that nobody sees adds up. Every 5 seconds (Pieter,
    // 8 November 2026, was 30): drivers move on the map, one who's booked or went offline goes, and a new price shows.
    private func loop() async {
        while !Task.isCancelled {
            if app.isActive, app.riderTab == 0, app.ride == nil { await loadDrivers() }
            try? await Task.sleep(for: .seconds(5))
        }
    }

    // A driver of the quote has changed their price since: the quote is asked again, quietly, so its prices are what they ask now.
    // Once per change, as the look and the quote can take a few seconds to agree.
    private func requoteIfPricesChanged() {
        guard let offers = booking.quote?.offers, !offers.isEmpty, booking.payingFor == nil, !ordering, !booking.loading else { return }
        let rates = { (d: DriverCard) in "\(d.id):\(d.perKmCents ?? 0)/\(d.perMinCents ?? 0)/\(d.pickupPerKmCents ?? 0)" }
        let changed = offers.compactMap { offer in drivers.first { $0.id == offer.id }.flatMap { rates($0) != rates(offer) ? rates($0) : nil } }
        guard !changed.isEmpty else { return }
        let seen = changed.sorted().joined(separator: ",")
        guard seen != requotedFor else { return }
        requotedFor = seen
        Task { await getQuote(quiet: true) }
    }

    private func loadDrivers() async {
        // Around the pickup once it's moved: that's where a driver has to come to.
        guard let here = booking.pickup?.coordinate ?? location.location?.coordinate else { return }
        let path = "/api/drivers/nearby?lat=\(here.latitude)&lng=\(here.longitude)&radiusKm=\(radiusKm)&pets=\(petsOnly ? 1 : 0)&limit=\(Self.onList)&sort=\(sort.rawValue)\(booking.vehicle.map { "&vehicle=\($0)" } ?? "")"
        if let r: DriversResponse = try? await APIClient.shared.get(path) {
            // The server answers for the area, so how far they are from you is worked out here.
            let from = CLLocation(latitude: here.latitude, longitude: here.longitude)
            let fresh = (r.drivers ?? []).map { d in
                var near = d
                if let c = d.coordinate { near.distanceM = Int(from.distance(from: CLLocation(latitude: c.latitude, longitude: c.longitude))) }
                return near
            }
            // Nothing new, nothing drawn again. Otherwise the pins glide to where the drivers are now, as the car of a ride does.
            if fresh != drivers {
                withAnimation(.easeInOut(duration: 1)) { drivers = fresh }
            }
            if totalOnline != r.total { totalOnline = r.total }
            let spot = Place(lat: here.latitude, lng: here.longitude, label: nil)
            if lookedFrom != spot { lookedFrom = spot }
            updatePins(settled: true)
            requoteIfPricesChanged()
        }
    }

    private func pinStyle(of d: DriverCard) -> PinStyle {
        farOut ? .hidden : labelled.contains(d.id) ? .label : covered.contains(d.id) ? .hidden : .circle
    }

    // Zooming out the bubbles go first, then the circles, so the map stays clear: pins are for looking around close by.
    private static let bubblesUpToKm = 12.0
    private static let circlesUpToKm = 30.0

    // Which pins show what. During a pinch they go as soon as it's too far out; which ones get a bubble is worked out once the map stops,
    // and the map is only laid out again when something changed.
    private func updatePins(settled: Bool) {
        guard let region = mapWatch.region else { return }
        let widthKm = region.span.longitudeDelta * 111 * cos(region.center.latitude * .pi / 180)
        let far = widthKm > Self.circlesUpToKm
        if far != farOut { farOut = far }
        if widthKm > Self.bubblesUpToKm {
            if !labelled.isEmpty { labelled = [] }
            if !covered.isEmpty { covered = [] }
            return
        }
        guard settled, let proxy = mapWatch.proxy else { return }
        let inView = pins.filter { d in
            guard let c = d.coordinate else { return false }
            return abs(c.latitude - region.center.latitude) < region.span.latitudeDelta / 2 && abs(c.longitude - region.center.longitude) < region.span.longitudeDelta / 2
        }
        // In order, the first ones first, as far as there's room: bubbles never overlap. The chosen driver always has one, so theirs goes first.
        let chosen = booking.picked
        let screen = CGRect(x: 0, y: 56, width: mapWatch.clearWidth, height: mapWatch.clearDown - 56)
        // Not under the filter and the location button either.
        var taken = [CGRect(x: mapWatch.clearWidth - 118, y: 0, width: 118, height: 180)]
        var fits: Set<String> = []
        var boxes: [CGRect] = []
        for d in inView.filter({ $0.id == chosen }) + inView.filter({ $0.id != chosen }) {
            guard let c = d.coordinate, let spot = proxy.convert(c, to: .global) else { continue }
            let box = CGRect(x: spot.x - 64, y: spot.y - 47, width: 128, height: 61)     // the circle, and the bubble over it
            if d.id != chosen, !screen.contains(box) || taken.contains(where: { $0.intersects(box) }) { continue }
            taken.append(box)
            boxes.append(box)
            fits.insert(d.id)
        }
        // A map decides for itself what's on top, so a small pin under a bubble would hide its price.
        var under: Set<String> = []
        for d in inView where !fits.contains(d.id) {
            guard let c = d.coordinate, let spot = proxy.convert(c, to: .global) else { continue }
            let small = CGRect(x: spot.x - 13, y: spot.y - 13, width: 26, height: 26)
            if boxes.contains(where: { $0.intersects(small) }) { under.insert(d.id) }
        }
        if fits != labelled { labelled = fits }
        if under != covered { covered = under }
    }

    private func tappedPin(_ d: DriverCard) {
        // A small one, with the map far out: a tap goes to it.
        if pinStyle(of: d) != .label, booking.picked != d.id, let c = d.coordinate, let region = mapWatch.region, region.span.latitudeDelta > 0.05 {
            withAnimation { camera = .region(MKCoordinateRegion(center: c, latitudinalMeters: 3000, longitudinalMeters: 3000)) }
            return
        }
        // A tap picks this driver to book with, and a tap on the picked one opens their page (Pieter, 5 November 2026). With a route,
        // one who can't take it only has their page.
        if booking.picked == d.id { booking.openDriver = d; return }
        if let offers = booking.quote?.offers, !offers.contains(where: { $0.id == d.id }) { booking.openDriver = d; return }
        booking.driverId = d.id
    }

    // The driver whose pin is under a finger, the closest if there are more. By position, as a pin's own gestures don't get a long hold from the map.
    // Generous, as a finger is about 44 points and lands a little off: a tap meant for a driver must never move the drop-off onto them.
    private func driverPin(at point: CGPoint, _ proxy: MapProxy) -> DriverCard? {
        var best: (driver: DriverCard, away: CGFloat)?
        for d in pins {
            let style = booking.picked == d.id ? PinStyle.label : pinStyle(of: d)
            guard style != .hidden, let c = d.coordinate, let spot = proxy.convert(c, to: .global) else { continue }
            let dx = abs(point.x - spot.x), up = spot.y - point.y
            let onCircle = dx <= 22 && abs(up) <= 22
            // The bubble, 21 to 45 points over the circle's middle, as wide as it's drawn (a price per km, stars and a check can be wider than you'd think).
            let half = max(mapWatch.pinWidths[d.id] ?? 0, 128) / 2 + 8
            let onBubble = style == .label && up > 12 && up <= 54 && dx <= half
            guard onCircle || onBubble else { continue }
            let away = dx + abs(onCircle ? up : up - 33)
            if away < (best?.away ?? .infinity) { best = (d, away) }
        }
        return best?.driver
    }

    // The spot shows right away; its name and the price follow.
    private func movePickup(to c: CLLocationCoordinate2D) async {
        let spot = Place(lat: c.latitude, lng: c.longitude, label: String(localized: "Pickup"))
        booking.pickup = spot
        let label = await Geocoder.name(of: c)
        guard booking.pickup == spot else { return }
        booking.pickup?.label = label ?? String(localized: "Pickup")
        if booking.dropoff != nil { await getQuote() } else { await loadDrivers() }
    }

    private func tapped(_ c: CLLocationCoordinate2D) async {
        let label = await Geocoder.name(of: c)
        booking.dropoff = Place(lat: c.latitude, lng: c.longitude, label: label)
        booking.driverId = booking.driverId
        await getQuote()
    }

    private func choose(_ d: DriverCard, planned: Bool) {
        booking.openDriver = nil
        booking.driverId = d.id
        booking.planned = planned
        if booking.dropoff == nil {
            searching = true
        } else {
            Task { await getQuote() }
        }
    }

    // Tapping the map keeps its zoom, so the spot can be corrected with another tap. Only a place from the search shows the whole route.
    // `quiet`: asked again for new prices, without a spinner, and keeping the quote there is if it fails.
    private func getQuote(showRoute: Bool = false, quiet: Bool = false) async {
        guard var from = booking.pickup ?? mine, let to = booking.dropoff else {
            if !quiet { booking.error = String(localized: "We need your location to use this app.") }
            return
        }
        // A few taps in a row: only the last one counts.
        quoteRun += 1
        let run = quoteRun
        if !quiet {
            booking.loading = true
            booking.error = nil
        }
        defer { if run == quoteRun, !quiet { booking.loading = false } }
        if booking.pickup == nil { from.label = await Geocoder.name(of: from.coordinate) ?? String(localized: "Pickup") }
        var body: [String: Any] = ["pickup": from.json, "dropoff": to.json, "passengers": booking.passengers, "pets": booking.pets, "coin": booking.coin]
        if let when = booking.scheduledAt { body["scheduledAt"] = when }
        if let kind = booking.vehicle { body["vehicle"] = kind }
        body["sort"] = sort.rawValue
        do {
            let q: Quote = try await APIClient.shared.post("/api/quote", body)
            // Asked again quietly, but the route was closed meanwhile: it stays closed.
            guard run == quoteRun, !(quiet && booking.quote == nil) else { return }
            withAnimation {
                if booking.quote == nil, detent == .peek { detent = .middle }
                booking.quote = q
                // Sorted by something else than the price: the one on top is the one you'd book.
                if sort != .cheapest, booking.driverId == nil { booking.driverId = sort.sorted(q.offers ?? []).first?.id }
            }
            updatePins(settled: true)
            if showRoute, let region = regionFitting(Polyline.decode(q.polyline)) { withAnimation { camera = .region(region) } }
        } catch {
            guard run == quoteRun, !quiet else { return }
            booking.error = error.localizedDescription
            booking.quote = booking.quote ?? Quote(pickup: from, dropoff: to, offers: [])
        }
    }

    private func regionFitting(_ points: [(lat: Double, lng: Double)]) -> MKCoordinateRegion? {
        guard let minLat = points.map(\.lat).min(), let maxLat = points.map(\.lat).max(),
              let minLng = points.map(\.lng).min(), let maxLng = points.map(\.lng).max() else { return nil }
        return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2, longitude: (minLng + maxLng) / 2),
                                  span: MKCoordinateSpan(latitudeDelta: max(0.008, (maxLat - minLat) * 1.6), longitudeDelta: max(0.008, (maxLng - minLng) * 1.6)))
    }

    // How to pay is asked at the very end. A chosen driver has to take it; otherwise it goes to the cheapest who does.
    private func askToPay() {
        let offer = booking.chosenOffer
        let takes = booking.driverId == nil ? booking.quote?.offers?.compactMap(\.coins).flatMap { $0 } : offer?.coins
        booking.payingFor = OrderToPay(mode: booking.driverId == nil ? "auto" : "driver", cents: offer?.priceCents, driver: booking.driverId == nil ? nil : offer?.name, takes: takes?.isEmpty == false ? takes : nil)
    }

    // Any driver can claim a named price, so every way to pay is open.
    private func askToPayForBid() {
        guard bidPlaced else { return }
        bidPlaced = false
        booking.payingFor = OrderToPay(mode: "bid", bid: booking.bidCents, cents: booking.bidCents)
    }

    private func order(mode: String, bid: Int?) async {
        guard let q = booking.quote else { return }
        ordering = true
        booking.error = nil
        defer { ordering = false }
        var body: [String: Any] = ["pickup": q.pickup.json, "dropoff": q.dropoff.json, "passengers": booking.passengers, "pets": booking.pets, "coin": booking.coin, "mode": mode]
        if let when = booking.scheduledAt { body["scheduledAt"] = when }
        if let kind = booking.vehicle { body["vehicle"] = kind }
        if let id = booking.driverId, mode == "driver" { body["driverId"] = id }
        if let bid { body["bidCents"] = bid } else if let price = booking.chosenOffer?.priceCents { body["expectedCents"] = price }
        do {
            let r: RideResponse = try await APIClient.shared.post("/api/rides", body)
            booking.clear()
            await app.syncNow()
            app.sendLocationNow()
            detent = .middle
            app.showingRide = r.ride
        } catch let error as APIError where error.code == "price_changed" {
            booking.error = error.message
            await getQuote()
        } catch {
            booking.error = error.localizedDescription
        }
    }
}

enum Geocoder {
    static func name(of c: CLLocationCoordinate2D) async -> String? {
        let places = try? await CLGeocoder().reverseGeocodeLocation(CLLocation(latitude: c.latitude, longitude: c.longitude))
        guard let p = places?.first else { return nil }
        if let street = p.thoroughfare {
            let number = p.subThoroughfare.map { " \($0)" } ?? ""
            return "\(street)\(number)\(p.locality.map { ", \($0)" } ?? "")"
        }
        return p.name ?? p.locality
    }
}

struct DriverRow: View {
    var driver: DriverCard
    var price: Int?
    var label: String?
    var note: String?
    var selected = false
    var onIcon: (() -> Void)?       // where tapping the row does something else: the vehicle's picture opens their page

    var body: some View {
        HStack(spacing: 12) {
            CarTile(car: driver.car, size: 54)
                .contentShape(Rectangle())
                .highPriorityGesture(TapGesture().onEnded { onIcon?() }, including: onIcon == nil ? .none : .all)
                .accessibilityAction(named: "See driver") { onIcon?() }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    HStack(spacing: 4) {
                        Text(driver.name ?? String(localized: "Driver")).font(.system(size: 16, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                        if driver.verified == true { VerifiedMark(size: 14) }
                    }
                    if let label { StatusPill(text: label, color: Theme.ok, background: Theme.okSoft) }
                    if driver.busy == true { StatusPill(text: String(localized: "On a drive"), color: Theme.warn, background: Theme.warnSoft) }
                }
                HStack(spacing: 6) {
                    RatingLabel(rating: driver.rating, count: driver.ratingCount)
                    if let seats = driver.car?.seats { Text("· \(driver.car?.kind == "car" ? "" : String(localized: "\(Vehicle.name(driver.car?.kind)), "))\(seats) \(seats == 1 ? String(localized: "seat") : String(localized: "seats"))").font(.footnote).foregroundStyle(Theme.muted) }
                    if driver.petsAllowed == true { Image(systemName: "pawprint.fill").font(.caption2).foregroundStyle(Theme.muted) }
                }
                if let note { Text(note).font(.caption).foregroundStyle(Theme.muted) }
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 2) {
                if let price {
                    Text(Fmt.eur(price)).font(.system(size: 18, weight: .bold)).kerning(-0.3).foregroundStyle(Theme.ink)
                    if let s = driver.pickupS { Text("in \(Fmt.minutes(s))").font(.footnote).foregroundStyle(Theme.muted) }
                } else {
                    Text("\(Fmt.rate(driver.perKmCents))/km").font(.system(size: 16, weight: .bold)).kerning(-0.2).foregroundStyle(Theme.ink)
                    if let m = driver.distanceM { Text(Fmt.km(m)).font(.footnote).foregroundStyle(Theme.muted) }
                }
            }
        }
        .contentShape(Rectangle())
    }
}

// Finding an address, with Apple's search.
@Observable
final class AddressSearch: NSObject, MKLocalSearchCompleterDelegate {
    // Made when it's first used. This class is made again whenever its view is, which is every time the panel is, and starting
    // one of these talks to the system on the main thread.
    @ObservationIgnored private var madeCompleter: MKLocalSearchCompleter?
    private var completer: MKLocalSearchCompleter {
        if let madeCompleter { return madeCompleter }
        let made = MKLocalSearchCompleter()
        made.delegate = self
        made.resultTypes = [.address, .pointOfInterest]
        madeCompleter = made
        return made
    }
    var results: [MKLocalSearchCompletion] = []
    var text = "" { didSet { completer.queryFragment = text; if text.isEmpty { results = [] } } }

    func near(_ c: CLLocationCoordinate2D?) {
        if let c { completer.region = MKCoordinateRegion(center: c, latitudinalMeters: 60000, longitudinalMeters: 60000) }
    }
    func completerDidUpdateResults(_ completer: MKLocalSearchCompleter) { results = completer.results }
    func completer(_ completer: MKLocalSearchCompleter, didFailWithError error: Error) {}

    func place(for completion: MKLocalSearchCompletion) async -> Place? {
        let response = try? await MKLocalSearch(request: MKLocalSearch.Request(completion: completion)).start()
        guard let item = response?.mapItems.first else { return nil }
        let c = item.placemark.coordinate
        return Place(lat: c.latitude, lng: c.longitude, label: [completion.title, completion.subtitle.split(separator: ",").first.map(String.init)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

// "Where to?" typed right in the panel: results show under it while the panel opens up. A pickup can be changed too.
struct WhereToSearch: View {
    @Bindable var booking: Booking
    @Binding var active: Bool
    var onPicked: () -> Void

    @State private var search = AddressSearch()
    @State private var pickupSearch = AddressSearch()
    @State private var editingPickup = false
    @State private var recent: [Ride] = []
    @FocusState private var focus: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Image(systemName: editingPickup ? "figure.wave" : "magnifyingglass").font(.title3.weight(.semibold)).foregroundStyle(Theme.ink)
                TextField("", text: editingPickup ? $pickupSearch.text : $search.text, prompt: Text(editingPickup ? String(localized: "Pickup spot") : String(localized: "Where to?")).foregroundColor(Theme.ink))
                    .font(.system(size: 20, weight: .semibold))
                    .kerning(-0.3)
                    .accessibilityLabel(editingPickup ? String(localized: "Pickup spot") : String(localized: "Where to?"))
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .focused($focus)
                if active {
                    Button("Cancel") { close() }.font(.subheadline.weight(.semibold)).foregroundStyle(Theme.accentInk)
                }
            }
            .padding(.horizontal, 18)
            .frame(height: 60)
            .background(Theme.soft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).stroke(active ? Theme.accent : .clear, lineWidth: 2))
            if active {
                Button { editingPickup.toggle(); focus = true } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "circle.fill").font(.caption2).foregroundStyle(Theme.pickupPin)
                        Text("From \(booking.pickup?.label ?? String(localized: "your location"))").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer()
                        Text(editingPickup ? String(localized: "Done") : String(localized: "Change")).font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentInk)
                    }
                    .padding(.horizontal, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                results
            }
        }
        .onChange(of: focus) { _, now in if now { active = true } }
        .onChange(of: active) { _, now in if now { focus = true } else { focus = false; editingPickup = false } }
        .task {
            let here = LocationService.shared.location?.coordinate
            search.near(here)
            pickupSearch.near(here)
            if let r: RidesResponse = try? await APIClient.shared.get("/api/rides") { recent = r.rides ?? [] }
        }
    }

    @ViewBuilder
    private var results: some View {
        VStack(spacing: 0) {
            if editingPickup {
                if booking.pickup != nil {
                    resultRow("location.fill", String(localized: "Use my location"), nil) { booking.pickup = nil; editingPickup = false }
                }
                ForEach(pickupSearch.results, id: \.self) { r in
                    resultRow("mappin", r.title, r.subtitle) {
                        booking.pickup = await pickupSearch.place(for: r)
                        editingPickup = false
                        pickupSearch.text = ""
                    }
                }
            } else if search.text.isEmpty {
                ForEach(uniqueRecent, id: \.self) { p in
                    resultRow("clock.arrow.circlepath", p.label ?? String(localized: "Place"), nil) { pick(p) }
                }
                resultRow("hand.tap", String(localized: "Choose on the map"), String(localized: "Close this and tap where you’re going")) { close() }
            } else {
                ForEach(search.results, id: \.self) { r in
                    resultRow("mappin.and.ellipse", r.title, r.subtitle) {
                        if let place = await search.place(for: r) { pick(place) }
                    }
                }
            }
        }
    }

    private func resultRow(_ symbol: String, _ title: String, _ subtitle: String?, action: @escaping () async -> Void) -> some View {
        Button { Task { await action() } } label: {
            HStack(spacing: 12) {
                IconTile(symbol: symbol, tint: Theme.ink, background: Theme.soft)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    if let subtitle, !subtitle.isEmpty { Text(subtitle).font(.caption).foregroundStyle(Theme.muted).lineLimit(1) }
                }
                Spacer()
            }
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var uniqueRecent: [Place] {
        var seen = Set<String>()
        return recent.map(\.dropoff).filter { p in
            guard let label = p.label, !seen.contains(label) else { return false }
            seen.insert(label)
            return true
        }.prefix(5).map { $0 }
    }

    private func pick(_ place: Place) {
        booking.dropoff = place
        search.text = ""
        close()
        onPicked()
    }

    private func close() {
        focus = false
        editingPickup = false
        active = false
    }
}

// Now or later, as two big buttons: the first choice of a ride.
struct WhenSwitch: View {
    @Binding var planned: Bool
    var onChange: () -> Void = {}
    @Namespace private var thumb

    var body: some View {
        HStack(spacing: 0) {
            option(false, String(localized: "Now"), "bolt.fill")
            option(true, String(localized: "Plan a ride"), "calendar")
        }
        .padding(3)
        .background(Theme.soft, in: Capsule())
    }

    private func option(_ value: Bool, _ title: String, _ symbol: String) -> some View {
        let on = planned == value
        return Button {
            guard !on else { return }
            withAnimation(.snappy) { planned = value }
            onChange()
        } label: {
            HStack(spacing: 7) {
                Image(systemName: symbol).foregroundStyle(on ? Theme.accentInk : Theme.muted)
                Text(title).foregroundStyle(on ? Theme.ink : Theme.muted)
            }
                .font(.subheadline.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 40)
                .background {
                    if on { Capsule().fill(Theme.raised).lifted(0.5, radius: 20).matchedGeometryEffect(id: "thumb", in: thumb) }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

private struct DriverPageSheet: ViewModifier {
    @Bindable var booking: Booking
    var onBook: (DriverCard, Bool) -> Void

    func body(content: Content) -> some View {
        content.sheet(item: $booking.openDriver) { d in
            NavigationStack {
                DriverProfileView(driverId: d.id, card: d, onBook: { planned in onBook(d, planned) })
            }
        }
    }
}

// How the rider wants to pay, asked on booking. The order goes out once the sheet has gone, so the ride's page can open.
private struct PayChoiceSheet: ViewModifier {
    @Bindable var booking: Booking
    var onPick: (OrderToPay) -> Void
    @State private var picked: OrderToPay?

    func body(content: Content) -> some View {
        content.sheet(item: $booking.payingFor, onDismiss: {
            if let picked { onPick(picked) }
            picked = nil
        }) { order in
            PayChoiceView(order: order) { coin in
                booking.coin = coin
                picked = order
                booking.payingFor = nil
            }
            .presentationDetents([.medium, .large])
        }
    }
}

private struct PayChoiceView: View {
    @Environment(\.dismiss) private var dismiss
    var order: OrderToPay
    var onPick: (String) -> Void

    private var subtitle: String? {
        guard let cents = order.cents else { return nil }
        return order.driver.map { String(localized: "\(Fmt.eur(cents)) with \($0)") } ?? Fmt.eur(cents)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    ScreenTitle(title: String(localized: "How do you want to pay?"), subtitle: subtitle)
                    VStack(spacing: 0) {
                        ForEach(Array(Coins.payWith.enumerated()), id: \.element) { i, coin in
                            if i > 0 { CardDivider() }
                            row(coin)
                        }
                    }
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .lifted(0.45, radius: 22)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
            }
            .background(Theme.page)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    private func row(_ coin: String) -> some View {
        let open = order.takes?.contains(coin) != false
        return Button { onPick(coin) } label: {
            HStack(spacing: 12) {
                CoinBadge(coin: coin, size: 36)
                VStack(alignment: .leading, spacing: 3) {
                    Text(Fmt.coinName(coin)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    if !open {
                        Text(order.driver == nil ? String(localized: "No driver here takes this.") : String(localized: "This driver doesn’t take this.")).font(.caption).foregroundStyle(Theme.muted)
                    } else if coin == Coins.cash {
                        Text("Pay your driver in the car.").font(.caption).foregroundStyle(Theme.muted)
                        Text("With cash you have less protection, and your transaction is finalised with the driver.").font(.caption.weight(.medium)).foregroundStyle(Theme.warn)
                    } else {
                        Text("From your own wallet. Held in escrow until the ride is done.").font(.caption).foregroundStyle(Theme.muted)
                    }
                }
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                if open { Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint) }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!open)
        .opacity(open ? 1 : 0.5)
    }
}

// Asks a name for the route on screen, to keep it in Rides.
private struct RouteNaming: ViewModifier {
    @Bindable var booking: Booking
    @State private var name = ""

    func body(content: Content) -> some View {
        content.alert("Save this route", isPresented: $booking.namingRoute) {
            TextField("Like Home to work", text: $name)
            Button("Save") {
                if let q = booking.quote { SavedRoutes.shared.add(name: name, pickup: q.pickup, dropoff: q.dropoff) }
                name = ""
            }
            Button("Cancel", role: .cancel) { name = "" }
        } message: {
            Text("It keeps the pickup and the drop-off. Find it in Rides, under Booked. It stays on this phone.")
        }
    }
}

// The map's position, for working out what its pins show. Not state: it changes with every frame of a pinch.
private final class MapWatch {
    var region: MKCoordinateRegion?
    var proxy: MapProxy?
    var clearDown: CGFloat = 1000
    var clearWidth: CGFloat = 400
    var pinWidths: [String: CGFloat] = [:]     // each driver's pin as drawn, for taps
}

// A long hold on the map. A recogniser of its own next to the map's, as a SwiftUI gesture on a Map holds up its panning.
private struct MapHold: UIViewRepresentable {
    var onHold: (CGPoint) -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> Host {
        let view = Host()
        view.coordinator = context.coordinator
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: Host, context: Context) { context.coordinator.onHold = onHold }

    final class Host: UIView {
        weak var coordinator: Coordinator?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            coordinator?.attach(to: window)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onHold: (CGPoint) -> Void = { _ in }
        private lazy var recogniser: UILongPressGestureRecognizer = {
            let r = UILongPressGestureRecognizer(target: self, action: #selector(held))
            r.minimumPressDuration = 0.5
            r.cancelsTouchesInView = false
            r.delegate = self
            return r
        }()

        func attach(to window: UIWindow?) {
            recogniser.view?.removeGestureRecognizer(recogniser)
            window?.addGestureRecognizer(recogniser)
        }

        // In the window's own points, which is what SwiftUI calls global.
        @objc private func held(_ r: UILongPressGestureRecognizer) {
            if r.state == .began, let window = r.view { onHold(r.location(in: window)) }
        }

        func gestureRecognizer(_ r: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

        // Only on a map, not on what's over it.
        func gestureRecognizer(_ r: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            var view = touch.view
            while let now = view {
                if now is MKMapView { return true }
                view = now.superview
            }
            return false
        }
    }
}

// A driver's page: pictures, plate, prices, reviews, when they're free. Book now or plan.
struct DriverProfileView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    var driverId: String
    // What's already known from the list: the page is there as the sheet slides up, and the reviews and times follow.
    var card: DriverCard?
    var onBook: ((Bool) -> Void)?

    @State private var profile: DriverProfile?
    @State private var error: String?

    private var driver: DriverCard? { profile?.driver ?? card }

    var body: some View {
        Group {
            if let d = driver {
                content(d)
            } else if let error {
                Text(error).foregroundStyle(Theme.muted).padding(40)
            } else {
                ProgressView().padding(60)
            }
        }
        .navigationTitle(driver?.name ?? String(localized: "Driver"))
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            if app.user?.id != driverId, let d = driver {
                ToolbarItem(placement: .primaryAction) { PersonMenu(userId: d.id, name: d.name ?? String(localized: "this driver")) { dismiss() } }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if let onBook, let d = driver {
                HStack(spacing: 10) {
                    if (profile?.availability?.allowsPlanning ?? d.allowsPlanning) == true {
                        Button("Plan") { onBook(true) }.buttonStyle(GhostButtonStyle())
                    }
                    Button("Book now") { onBook(false) }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(d.online != true || d.busy == true)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(.bar)
            }
        }
        .task {
            let opened = ContinuousClock.now
            do {
                let loaded: DriverProfile = try await APIClient.shared.get("/api/drivers/\(driverId)")
                // Not while the sheet is sliding up: the rest of the page would be laid out in the middle of it.
                if card != nil { try? await Task.sleep(until: opened + .milliseconds(700)) }
                profile = loaded
            } catch { self.error = error.localizedDescription }
        }
    }

    private func content(_ d: DriverCard) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let car = d.car { carCard(car) }
                driverCard(d)
                if let car = d.car {
                    HStack(spacing: 10) {
                        FactTile(symbol: Vehicle.icon(car.kind), title: Vehicle.name(car.kind), note: Fmt.colour(car.colorName))
                        FactTile(symbol: "person.2.fill", title: "\(car.seats ?? 1)", note: (car.seats ?? 1) == 1 ? String(localized: "passenger") : String(localized: "passengers"))
                        FactTile(symbol: "pawprint.fill", title: d.petsAllowed == true ? String(localized: "Yes") : String(localized: "No"), note: String(localized: "pets"))
                    }
                }
                prices(d)
                if app.user?.id != driverId {
                    MessageButton(userId: d.id, name: d.name ?? String(localized: "this driver"), big: true)
                }
                if let p = profile {
                    if let a = p.availability { availability(a, online: d.online == true) }
                    reviews(p)
                } else if error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(.vertical, 24)
                }
            }
            .padding(16)
        }
        .background(Theme.page)
    }

    private func carCard(_ car: Car) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            CarGallery(car: car, height: 200).padding(10)
            HStack(alignment: .center) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(car.title).font(.title3.weight(.bold)).lineLimit(1)
                    HStack(spacing: 8) {
                        PlateView(plate: car.shownPlate, size: 14)
                        if car.verified == true { Label("Checked", systemImage: "checkmark.circle.fill").font(.caption.weight(.semibold)).foregroundStyle(Theme.ok) }
                    }
                }
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .lifted(0.45, radius: 24)
    }

    private func driverCard(_ d: DriverCard) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                Text(String((d.name ?? "D").prefix(1)).uppercased())
                    .font(.system(size: 24, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.onAccent)
                    .frame(width: 56, height: 56)
                    .background(Theme.gradient, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    Text(d.name ?? String(localized: "Driver")).font(.title3.weight(.bold)).lineLimit(1)
                    if d.verified == true { VerifiedBadge() }
                    HStack(spacing: 6) {
                        Stars(rating: Int((d.rating ?? 0).rounded()), size: 12)
                        Text("\(Fmt.rating(d.rating, d.ratingCount)) · \(d.ridesDone ?? 0) \(d.ridesDone == 1 ? String(localized: "ride") : String(localized: "rides"))").font(.caption).foregroundStyle(Theme.muted).lineLimit(1).fixedSize()
                    }
                }
                Spacer()
                StatusPill(text: d.busy == true ? String(localized: "On a ride") : d.online == true ? String(localized: "Online") : String(localized: "Offline"),
                           color: d.online == true && d.busy != true ? Theme.ok : Theme.muted,
                           background: d.online == true && d.busy != true ? Theme.okSoft : Theme.soft)
            }
            HStack(spacing: 10) {
                stat(d.completedPercent.map { "\($0)%" } ?? "–", "completed")
                stat(d.arrivalScore.map { "\($0)%" } ?? "–", String(localized: "on time"))
                stat(d.rating.map { Lang.number(String(format: "%.1f", $0)) } ?? String(localized: "New"), String(localized: "rating"))
            }
            if let bio = d.bio, !bio.isEmpty {
                Text("“\(bio)”").font(.subheadline).foregroundStyle(Theme.muted).italic()
            }
            if let coins = d.coins?.filter(Coins.payWith.contains), !coins.isEmpty {
                HStack(spacing: 8) {
                    Text("Takes").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint)
                    ForEach(coins, id: \.self) { CoinBadge(coin: $0, size: 24) }
                }
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .lifted(0.45, radius: 24)
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value).font(.title3.weight(.bold).monospacedDigit()).kerning(-0.3)
            Text(label).font(.caption).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .background(Theme.soft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func prices(_ d: DriverCard) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Prices").font(.title3.weight(.bold)).kerning(-0.3)
            HStack(spacing: 0) {
                PriceColumn(price: Fmt.rate(d.perKmCents), unit: String(localized: "per km"))
                Divider().frame(height: 40)
                PriceColumn(price: Fmt.rate(d.perMinCents), unit: String(localized: "per minute"))
                Divider().frame(height: 40)
                PriceColumn(price: Fmt.rate(d.pickupPerKmCents), unit: String(localized: "to you, km"))
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .lifted(0.45, radius: 24)
    }

    private func reviews(_ p: DriverProfile) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What riders say").font(.title3.weight(.bold)).kerning(-0.3).padding(.horizontal, 4)
            let list = p.reviews ?? []
            if list.isEmpty {
                Text("No reviews yet.").font(.subheadline).foregroundStyle(Theme.muted)
                    .padding(16).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .lifted(0.45, radius: 22)
            }
            ForEach(Array(list.enumerated()), id: \.offset) { _, r in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Stars(rating: r.stars ?? 0)
                        Spacer()
                        if let at = r.at { Text(Date(ms: at).formatted(.dateTime.day().month(.abbreviated))).font(.caption).foregroundStyle(Theme.faint) }
                    }
                    if let t = r.text, !t.isEmpty { Text(t).font(.subheadline) }
                }
                .padding(14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .lifted(0.45, radius: 22)
            }
        }
    }

    private func availability(_ a: Availability, online: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("When you can book").font(.title3.weight(.bold)).kerning(-0.3)
            HStack(spacing: 10) {
                Label(online ? String(localized: "Online now") : String(localized: "Offline now"), systemImage: online ? "dot.radiowaves.left.and.right" : "moon.zzz.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(online ? Theme.ok : Theme.muted)
                Spacer()
                if let hours = usualHours(a.usualHoursUtc) { Text("Usually \(hours)").font(.caption).foregroundStyle(Theme.faint) }
            }
            Label(a.allowsPlanning == true ? ((a.planDays ?? 7) == 1 ? String(localized: "Plan up to 1 day ahead") : String(localized: "Plan up to \(a.planDays ?? 7) days ahead")) : String(localized: "Doesn’t take planned rides"),
                  systemImage: "calendar")
                .font(.subheadline)
            if a.allowsPlanning == true, a.bookable != true {
                Text("Not online in the last 24 hours, so can’t be planned right now.").font(.footnote).foregroundStyle(Theme.muted)
            }
            ForEach(Array((a.busy ?? []).prefix(5).enumerated()), id: \.offset) { _, b in
                if let from = b.from, let to = b.to {
                    Label("Booked \(Fmt.dayTime(Date(ms: from)))–\(Fmt.time(Date(ms: to)))", systemImage: "clock.badge.xmark").font(.footnote).foregroundStyle(Theme.faint)
                }
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .lifted(0.45, radius: 24)
    }

    // The longest stretch of hours they tend to be online, in this phone's time.
    private func usualHours(_ utc: [Double]?) -> String? {
        guard let utc, utc.count == 24 else { return nil }
        let shift = TimeZone.current.secondsFromGMT() / 3600
        var local = [Bool](repeating: false, count: 24)
        for h in 0..<24 where utc[h] >= 0.15 { local[(h + shift + 24) % 24] = true }
        var best = (start: 0, length: 0), start = -1
        for h in 0...24 {
            if h < 24, local[h] {
                if start < 0 { start = h }
            } else if start >= 0 {
                if h - start > best.length { best = (start, h - start) }
                start = -1
            }
        }
        guard best.length > 0 else { return nil }
        return String(format: "%02d:00–%02d:00", best.start, (best.start + best.length) % 24)
    }
}
