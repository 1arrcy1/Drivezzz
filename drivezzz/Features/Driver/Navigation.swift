import AVFoundation
import CoreLocation
import MapKit
import SwiftUI

// Turn-by-turn inside the app, on Apple's routes: they know traffic, speak the phone's language and don't touch our server.
// A route step means: drive along its line, then do what it says at the end of that line.
@Observable
final class DriveNavigator: NSObject, AVSpeechSynthesizerDelegate {
    enum Turn {
        case straight, slightLeft, left, sharpLeft, slightRight, right, sharpRight, uTurn, arrive

        var symbol: String {
            switch self {
            case .straight: "arrow.up"
            case .slightLeft: "arrow.up.left"
            case .left, .sharpLeft: "arrow.turn.up.left"
            case .slightRight: "arrow.up.right"
            case .right, .sharpRight: "arrow.turn.up.right"
            case .uTurn: "arrow.uturn.down"
            case .arrive: "flag.checkered"
            }
        }

        // From the road's direction before and after: the words of an instruction depend on the phone's language.
        init(from incoming: Double, to outgoing: Double) {
            let angle = (outgoing - incoming + 540).truncatingRemainder(dividingBy: 360) - 180
            switch angle {
            case ..<(-160), 160...: self = .uTurn
            case ..<(-110): self = .sharpLeft
            case ..<(-45): self = .left
            case ..<(-15): self = .slightLeft
            case ...15: self = .straight
            case ...45: self = .slightRight
            case ...110: self = .right
            default: self = .sharpRight
            }
        }
    }

    struct Step {
        var text: String
        var endsAt: Double      // metres along the route
        var turn: Turn
    }

    private(set) var line: [CLLocationCoordinate2D] = []
    private(set) var steps: [Step] = []
    private(set) var index = 0
    private(set) var failed = false
    private(set) var muted = UserDefaults.standard.bool(forKey: "navigationMuted")
    private var along = 0.0
    private var total = 0.0
    private var seconds = 0.0

    @ObservationIgnored private var target: CLLocationCoordinate2D?
    @ObservationIgnored private var cumulative: [Double] = []
    @ObservationIgnored private var routing = false
    @ObservationIgnored private var lastRouted = Date.distantPast
    @ObservationIgnored private var offRoute = 0
    @ObservationIgnored private var routeNumber = 0
    @ObservationIgnored private var spoken = Set<String>()
    // Made when it first has to speak. This class is made again whenever the Driving tab's view is, and starting a speech engine
    // holds up the main thread for a moment, so nothing that isn't navigating should pay for it.
    @ObservationIgnored private var voice: AVSpeechSynthesizer?

    var current: Step? { index < steps.count ? steps[index] : nil }
    var next: Step? { index + 1 < steps.count ? steps[index + 1] : nil }
    var metresToTurn: Double? { current.map { max(0, $0.endsAt - along) } }
    var metresLeft: Double? { line.isEmpty ? nil : max(0, total - along) }
    var secondsLeft: Double? { total > 0 ? seconds * (metresLeft ?? 0) / total : nil }

    func go(to place: CLLocationCoordinate2D, from here: CLLocation?) {
        target = place
        clear()
        if let here { update(here) }
    }

    func stop() {
        target = nil
        clear()
        voice?.stopSpeaking(at: .immediate)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func toggleMuted() {
        muted.toggle()
        UserDefaults.standard.set(muted, forKey: "navigationMuted")
        if muted { voice?.stopSpeaking(at: .immediate) }
    }

    func update(_ here: CLLocation) {
        guard target != nil else { return }
        guard line.count > 1 else {
            if Date().timeIntervalSince(lastRouted) > 15 { route(from: here) }
            return
        }
        // The nearest spot on the route, just behind or ahead of where we were: roads can pass close to themselves.
        var nearest = Double.infinity, spot = along
        let metresPerLng = 111_320 * cos(here.coordinate.latitude * .pi / 180)
        for i in 0..<(line.count - 1) where cumulative[i + 1] >= along - 100 && cumulative[i] <= along + 1500 {
            let bx = (line[i + 1].longitude - line[i].longitude) * metresPerLng, by = (line[i + 1].latitude - line[i].latitude) * 111_320
            let px = (here.coordinate.longitude - line[i].longitude) * metresPerLng, py = (here.coordinate.latitude - line[i].latitude) * 111_320
            let squared = bx * bx + by * by
            let t = squared > 0 ? min(1, max(0, (px * bx + py * by) / squared)) : 0
            let off = hypot(px - t * bx, py - t * by)
            if off < nearest {
                nearest = off
                spot = cumulative[i] + t * (cumulative[i + 1] - cumulative[i])
            }
        }
        if nearest > max(50, here.horizontalAccuracy * 1.5) {
            offRoute += 1
            if offRoute >= 3, Date().timeIntervalSince(lastRouted) > 10 { route(from: here) }
            return
        }
        offRoute = 0
        along = spot
        while index < steps.count - 1, along > steps[index].endsAt - 5 { index += 1 }
        announce(speed: max(0, here.speed))
    }

    private func clear() {
        line = []
        steps = []
        cumulative = []
        index = 0
        along = 0
        total = 0
        seconds = 0
        failed = false
        offRoute = 0
        lastRouted = .distantPast
        spoken = []
    }

    private func route(from here: CLLocation) {
        guard let target, !routing else { return }
        // Already there: there's no way left to show, and Apple answers that with an error.
        guard here.distance(from: CLLocation(latitude: target.latitude, longitude: target.longitude)) > 30 else { return }
        routing = true
        lastRouted = Date()
        offRoute = 0
        let request = MKDirections.Request()
        request.source = MKMapItem(placemark: MKPlacemark(coordinate: here.coordinate))
        request.destination = MKMapItem(placemark: MKPlacemark(coordinate: target))
        request.transportType = .automobile
        Task { @MainActor in
            defer { routing = false }
            do {
                let response = try await MKDirections(request: request).calculate()
                // Still where we're going: the ride may have moved on while this was on its way.
                guard let route = response.routes.first, let now = self.target, now.latitude == target.latitude, now.longitude == target.longitude else { return }
                use(route)
            } catch {
                if line.isEmpty { failed = true }
            }
        }
    }

    private func use(_ route: MKRoute) {
        let raw = route.steps.filter { $0.polyline.pointCount > 1 }
        var points: [CLLocationCoordinate2D] = [], metres: [Double] = [], ends: [Double] = []
        for step in raw {
            for point in UnsafeBufferPointer(start: step.polyline.points(), count: step.polyline.pointCount).map(\.coordinate) {
                if let last = points.last {
                    let gap = Self.metres(last, point)
                    if gap == 0 { continue }
                    metres.append((metres.last ?? 0) + gap)
                } else {
                    metres.append(0)
                }
                points.append(point)
            }
            ends.append(metres.last ?? 0)
        }
        guard points.count > 1, let length = metres.last else {
            failed = line.isEmpty
            return
        }
        line = points
        cumulative = metres
        steps = zip(raw, ends).enumerated().map { i, pair in
            // A step can end some way into its turn, so the road's direction is taken further back and further ahead.
            let end = pair.1
            let turn = i == raw.count - 1 ? Turn.arrive : Turn(
                from: Self.bearing(spot(end - 50), spot(end - 15)),
                to: Self.bearing(spot(end), spot(end + 35))
            )
            return Step(text: pair.0.instructions.isEmpty ? String(localized: "Continue") : pair.0.instructions, endsAt: end, turn: turn)
        }
        index = 0
        along = 0
        total = length
        seconds = route.expectedTravelTime
        failed = false
        routeNumber += 1
    }

    // The spot so many metres along the route.
    private func spot(_ metres: Double) -> CLLocationCoordinate2D {
        guard let after = cumulative.firstIndex(where: { $0 >= metres }), after > 0 else { return metres <= 0 ? line[0] : line[line.count - 1] }
        let start = cumulative[after - 1], t = (metres - start) / (cumulative[after] - start)
        return CLLocationCoordinate2D(latitude: line[after - 1].latitude + t * (line[after].latitude - line[after - 1].latitude),
                                      longitude: line[after - 1].longitude + t * (line[after].longitude - line[after - 1].longitude))
    }

    // Once well before a turn, once just before it. Further ahead the faster you go.
    private func announce(speed: Double) {
        guard !muted, let step = current, let metres = metresToTurn else { return }
        let key = "\(routeNumber)-\(index)"
        if metres <= max(50, speed * 4) {
            guard !spoken.contains(key + "near") else { return }
            spoken.formUnion([key + "near", key + "far"])
            say(step.text)
        } else if metres <= max(250, speed * 15) {
            guard !spoken.contains(key + "far") else { return }
            spoken.insert(key + "far")
            say(step.text)
        }
    }

    private func say(_ text: String) {
        // Music dips while it speaks, and comes back afterwards.
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .voicePrompt, options: [.duckOthers])
        try? session.setActive(true)
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: Lang.dutch ? "nl-NL" : Locale.preferredLanguages.first)
        if voice == nil {
            let made = AVSpeechSynthesizer()
            made.delegate = self
            voice = made
        }
        voice?.speak(utterance)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        if !synthesizer.isSpeaking { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
    }

    private static func metres(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude).distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    private static func bearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let lat1 = a.latitude * .pi / 180, lat2 = b.latitude * .pi / 180, dLng = (b.longitude - a.longitude) * .pi / 180
        return atan2(sin(dLng) * cos(lat2), cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)) * 180 / .pi
    }

    static func spoken(_ metres: Double) -> String {
        if metres >= 1000 { return Lang.number(String(format: "%.1f km", metres / 1000)) }
        return "\(Int((metres / 10).rounded()) * 10) m"
    }
}

// The next turn, along the top of the map.
struct NavigationBanner: View {
    var nav: DriveNavigator

    var body: some View {
        if let step = nav.current {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 14) {
                    Image(systemName: step.turn.symbol)
                        .font(.system(size: 32, weight: .bold))
                        .frame(width: 44)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(DriveNavigator.spoken(nav.metresToTurn ?? 0)).font(.title2.weight(.bold).monospacedDigit())
                        Text(step.text).font(.subheadline.weight(.medium)).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                }
                if let then = nav.next, (nav.metresToTurn ?? 0) < 300 {
                    HStack(spacing: 6) {
                        Text("Then").font(.caption.weight(.semibold))
                        Image(systemName: then.turn.symbol).font(.caption.weight(.bold))
                    }
                    .opacity(0.85)
                }
            }
            .foregroundStyle(.white)
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.night, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
            .lifted(radius: 24)
        }
    }
}

// A round button floating over a map.
struct MapRoundButton: View {
    var symbol: String
    var label: String
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .frame(width: 48, height: 48)
                .background(Theme.card, in: Circle())
                .lifted(radius: 24)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

// Which way your vehicle on the map points, and where it stands. GPS wobbles, also standing still, so only a real move counts: it points the
// way it's really moving, whichever way the map is turned, and standing still it stays put. A class of its own, read only by the
// vehicle where it can be: it changes with every fix and every frame of turning the map, and the screen around it, with its map, needn't know.
@Observable
final class DriveHeading {
    private(set) var angle = 0.0                        // never jumps: from 359 to 1 it turns the short way round
    private(set) var parked: CLLocationCoordinate2D?    // standing still: here, rather than wherever GPS wanders to
    @ObservationIgnored private(set) var course = 0.0   // the way it's moving, from north
    @ObservationIgnored private var mapHeading = 0.0
    @ObservationIgnored private var lastSpot: CLLocation?
    @ObservationIgnored private var stillSpot: CLLocation?
    // Following on a drive the map itself turns with the car, so it just points up.
    @ObservationIgnored var pinned = false { didSet { if pinned != oldValue { refresh() } } }

    static let realMove = 15.0      // metres; as on the server (`sameSpotWithin`)
    static let realSpeed = 3.0      // metres a second: about 10 km/h. Under that a phone's own course is mostly noise
    static let standing = 0.5       // metres a second: under this, by the phone's own speed, it stands still
    static let creeping = 1.0       // metres a second: from this it's moving, if slowly, as in a queue
    static let wobbleUpTo = 50.0    // metres: how much of a fix's own accuracy counts, at most

    // Whether `here` is only GPS wandering around `spot`, not a move (Pieter, 8 November 2026: the car crept and jumped while
    // standing still). Within 15 m it never is, as on the server. Not moving by the phone's own speed, or when it doesn't say, the
    // fix's own accuracy counts too, up to 50 m, and the phone saying it stands still allows twice that around a spot no worse than
    // this fix. Faster than a walk is always a move, and a queue's creeping keeps to the 15 m.
    static func wobble(_ here: CLLocation, around spot: CLLocation) -> Bool {
        if here.speed > realSpeed { return false }
        let d = here.distance(from: spot)
        if here.speed >= creeping { return d < realMove }
        let radius = max(realMove, min(max(here.horizontalAccuracy, 0), wobbleUpTo))
        if d < radius { return true }
        let still = here.speed >= 0 && here.speed < standing
        return still && spot.horizontalAccuracy >= 0 && spot.horizontalAccuracy <= max(here.horizontalAccuracy, realMove) && d < 2 * radius
    }

    func moved(to here: CLLocation) {
        let wobbling = stillSpot.map { Self.wobble(here, around: $0) } ?? false
        if here.course >= 0, here.speed > Self.realSpeed {
            course = here.course
            lastSpot = here
        } else if let last = lastSpot {
            // Slowly, or when the phone doesn't say: from two spots, once they're far enough apart to mean something. Never from
            // wobbling, or a car standing still would turn on the spot.
            if !wobbling, here.distance(from: last) >= max(Self.realMove, here.horizontalAccuracy) {
                course = Self.bearing(from: last.coordinate, to: here.coordinate)
                lastSpot = here
            }
        } else {
            lastSpot = here
        }
        if wobbling, let spot = stillSpot {
            // Parked at once when the phone says it stands still; otherwise after 4 seconds without a real move.
            let stopped = here.speed >= 0 && here.speed < Self.standing
            if parked == nil, stopped || here.timestamp.timeIntervalSince(spot.timestamp) >= 4 { parked = spot.coordinate }
        } else {
            stillSpot = here
            if parked != nil { parked = nil }
        }
        refresh()
    }

    func mapTurned(to heading: Double) {
        guard abs(heading - mapHeading) > 0.5 else { return }
        mapHeading = heading
        refresh()
    }

    private func refresh() {
        let wanted = pinned ? 0 : course - mapHeading
        let turn = (wanted - angle).truncatingRemainder(dividingBy: 360)
        let shortest = turn > 180 ? turn - 360 : turn < -180 ? turn + 360 : turn
        if abs(shortest) > 0.5 { angle += shortest }
    }

    static func bearing(from a: CLLocationCoordinate2D, to b: CLLocationCoordinate2D) -> Double {
        let lat1 = a.latitude * .pi / 180, lat2 = b.latitude * .pi / 180, dLng = (b.longitude - a.longitude) * .pi / 180
        let degrees = atan2(sin(dLng) * cos(lat2), cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)) * 180 / .pi
        return degrees < 0 ? degrees + 360 : degrees
    }
}

// A driver's car as a rider sees it, from the positions the server passes on: GPS wobbles, and a car standing still mustn't creep or
// jump (Pieter, 8 November 2026). The server keeps a position within 15 m as no move (`sameSpotWithin`); this holds the car still
// for what's still about a fix's accuracy, and a real move glides there instead of jumping. Read only by the map's car.
@Observable
final class SteadyCar {
    private(set) var spot: CLLocationCoordinate2D?
    @ObservationIgnored private var id: String?

    static let hold = 30.0          // metres: twice the server's 15, as a phone standing still wanders about that far

    // `id`: whose ride, so another ride's car starts where it is.
    func follow(_ c: CLLocationCoordinate2D?, ride id: String?) {
        guard let c else {
            if spot != nil { spot = nil }
            return
        }
        guard let shown = spot, id == self.id else {
            self.id = id
            spot = c
            return
        }
        let d = CLLocation(latitude: shown.latitude, longitude: shown.longitude).distance(from: CLLocation(latitude: c.latitude, longitude: c.longitude))
        guard d >= Self.hold else { return }
        withAnimation(.easeInOut(duration: 1)) { spot = c }
    }
}

// Your own vehicle on the map, seen from above and pointing where you're going.
struct OwnVehicle: View {
    var kind: String?
    var heading: DriveHeading

    var body: some View {
        Group {
            if kind == nil || kind == "car" {
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.night)
                    RoundedRectangle(cornerRadius: 3, style: .continuous).fill(.white.opacity(0.9)).frame(width: 17, height: 8).offset(y: -9)
                    RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Theme.accent).frame(width: 17, height: 13).offset(y: 3)
                    RoundedRectangle(cornerRadius: 2, style: .continuous).fill(.white.opacity(0.9)).frame(width: 15, height: 4).offset(y: 14)
                    HStack(spacing: 10) {
                        Capsule().fill(.red).frame(width: 5, height: 2)
                        Capsule().fill(.red).frame(width: 5, height: 2)
                    }
                    .offset(y: 20)
                }
                .frame(width: 24, height: 44)
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).stroke(.white, lineWidth: 2))
                .shadow(color: .black.opacity(0.35), radius: 4, y: 2)
                .rotationEffect(.degrees(heading.angle))
            } else {
                // Drawn from the side, so it stays upright, and an arrow around it shows the way.
                CarPin(vehicle: kind)
                    .frame(width: 58, height: 58)
                    .overlay(alignment: .top) { Image(systemName: "arrowtriangle.up.fill").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.accentInk) }
                    .rotationEffect(.degrees(heading.angle))
                    .overlay { CarPin(vehicle: kind).allowsHitTesting(false) }
            }
        }
        .animation(.easeInOut(duration: 0.6), value: heading.angle)
        .accessibilityHidden(true)
    }
}
