import MapKit
import SwiftUI

struct ErrorText: View {
    var text: String?
    var body: some View {
        if let text {
            Text(text)
                .font(.footnote.weight(.medium))
                .foregroundStyle(Theme.danger)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct ScreenTitle: View {
    var title: String
    var subtitle: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 30, weight: .bold)).kerning(-0.6).foregroundStyle(Theme.ink)
            if let subtitle {
                Text(subtitle).font(.subheadline).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct SectionLabel: View {
    var text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, alignment: .leading)
    }
}

// The way a Dutch number plate looks.
struct PlateView: View {
    var plate: String
    var size: CGFloat = 20

    var body: some View {
        HStack(spacing: 0) {
            Text("NL")
                .font(.system(size: size * 0.5, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: size * 1.05)
                .frame(maxHeight: .infinity)
                .background(Theme.plateBand)
            Text(plate)
                .font(.system(size: size, weight: .bold, design: .monospaced))
                .foregroundStyle(.black)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.horizontal, size * 0.45)
        }
        .frame(height: size * 1.7)
        .background(Theme.plate)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.2))
        .overlay(RoundedRectangle(cornerRadius: size * 0.2).stroke(.black.opacity(0.65), lineWidth: 1))
        .accessibilityLabel("Number plate \(plate)")
    }
}

// A small picture of a car, in its colour.
struct CarTile: View {
    var car: Car?
    var size: CGFloat = 44
    @Environment(\.colorScheme) private var scheme

    private var tint: Color {
        guard let hex = car?.colorHex?.uppercased(), !["#F4F4F2", "#E8E0C8"].contains(hex), let color = Color(hexString: hex) else { return Theme.ink }
        // A black car on a dark tile wouldn't show.
        if scheme == .dark, let value = UInt32(hex.dropFirst(), radix: 16) {
            let brightness = 0.3 * Double((value >> 16) & 0xFF) + 0.59 * Double((value >> 8) & 0xFF) + 0.11 * Double(value & 0xFF)
            if brightness < 70 { return Theme.ink }
        }
        return color
    }

    var body: some View {
        Image(systemName: Vehicle.icon(car?.kind))
            .font(.system(size: size * 0.44))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(Theme.soft, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct Stars: View {
    var rating: Int
    var size: CGFloat = 13
    var body: some View {
        HStack(spacing: 1) {
            ForEach(1...5, id: \.self) { i in
                Image(systemName: i <= rating ? "star.fill" : "star")
                    .font(.system(size: size))
                    .foregroundStyle(i <= rating ? Theme.route : Theme.line)
            }
        }
    }
}

struct RatingLabel: View {
    var rating: Double?
    var count: Int?
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "star.fill").font(.caption2).foregroundStyle(Theme.route)
            Text(Fmt.rating(rating, count)).font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink)
        }
    }
}

struct StatusPill: View {
    var text: String
    var color: Color = Theme.accentInk
    var background: Color = Theme.accentSoft
    var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 6, height: 6)
            Text(text).font(.caption.weight(.semibold)).foregroundStyle(color).lineLimit(1)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(background, in: Capsule())
        .fixedSize()
    }
}

extension StatusPill {
    // The same colours everywhere, also in the admin panel: completed green, under way yellow, cancelled red.
    init(text: String, ride: Ride) {
        switch ride.status {
        case "completed": self.init(text: text, color: Theme.ok, background: Theme.okSoft)
        case "cancelled": self.init(text: text, color: Theme.danger, background: Theme.dangerSoft)
        default: self.init(text: text, color: Theme.ongoing, background: Theme.ongoingSoft)
        }
    }
}

// How a screen uses the room it has. An open iPhone Duo is wider than any iPhone, a closed one wide and short, and Split View halves
// them: an app can be any size now, so this looks at the room itself, never at the device or the way it's held.
enum Room {
    static let wideFrom: CGFloat = 640  // from here a panel stands beside the map
    static let panel: CGFloat = 400     // that panel: the width of a phone, and on an open Duo clear of the fold
    static let edge: CGFloat = 12       // between it and the side of the screen
    static let page: CGFloat = 620      // a page of text or a list stops growing here

    static func wide(_ width: CGFloat) -> Bool { width >= wideFrom }

    // Room for the tab bar floating over the bottom of a panel. A closed Duo has its bars at the side, so nothing to keep free there
    // (a keyboard counts as a bar here: it covers the panel's bottom anyway).
    static func tabBar(_ bottomInset: CGFloat) -> CGFloat { bottomInset > 60 ? 84 : bottomInset }
}

extension View {
    // Keeps what matters on a map clear of its panel, with `cover` from where the panel came to rest (PanelRest). A map only takes touches
    // inside this: what's past it still shows, but ignores one finger and two. So nothing beside a panel: it stands on the right, leaving
    // all of the map live and its Legal in the free corner, bottom left.
    func clearOfPanel(_ cover: CGFloat, width: CGFloat) -> some View {
        safeAreaPadding(.bottom, Room.wide(width) ? 0 : cover)
    }

    // A page that stops growing and stays in the middle, for everything without a map. Backgrounds still reach the sides.
    func pageWidth() -> some View { modifier(PageWidth()) }
}

private struct PageWidth: ViewModifier {
    @State private var margin: CGFloat = 0

    func body(content: Content) -> some View {
        content
            .safeAreaPadding(.horizontal, margin)
            .onGeometryChange(for: CGFloat.self) { max(0, ($0.size.width - Room.page) / 2) } action: { margin = $0 }
    }
}

// The panel over a map: swipe it down to see the map, up for all of it. Where there's room it stands at the side instead.
enum PanelDetent {
    case peek, middle, full
    // How a panel comes to rest. PanelRest waits for this to finish, so change them together.
    static let spring = Animation.spring(response: 0.46, dampingFraction: 0.88)
}

struct BottomPanel<Content: View, Footer: View>: View {
    @Binding var detent: PanelDetent
    var peek: CGFloat = 150
    var middleShare: CGFloat = 0.62
    // Room for the tab bar floating over the bottom of the panel.
    var tabBar: CGFloat = 84
    @ViewBuilder var content: () -> Content
    @ViewBuilder var footer: () -> Footer
    @State private var scroll = PanelScroll()

    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(Theme.ink.opacity(0.16)).frame(width: 36, height: 5).padding(.top, 9).padding(.bottom, 8)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
            ScrollViewReader { reader in
                ScrollView {
                    VStack(spacing: 0) {
                        GeometryReader { inner in
                            Color.clear.preference(key: ScrollTopKey.self, value: inner.frame(in: .named("panel")).minY)
                        }
                        .frame(height: 0)
                        .id(PanelTop.id)
                        content()
                    }
                    .padding(.bottom, 16)
                }
                .coordinateSpace(name: "panel")
                // Also when it all fits: only a list that moves cancels the button under the finger. Without that, a swipe that
                // starts on one moves the panel and taps it too. Down there's no scrolling, so what shows then uses panelTap.
                .scrollBounceBehavior(.always)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: detent) { _, now in
                    if now == .peek { reader.scrollTo(PanelTop.id, anchor: .top) }
                }
                .modifier(ScrollTopWatch(scroll: scroll))
            }
            // Down, only the first line of the list stays: no buttons.
            if detent != .peek { footer() }
            Color.clear.frame(height: tabBar)
        }
        .modifier(PanelFrame(detent: $detent, peek: peek, middleShare: middleShare, tabBar: tabBar, scroll: scroll))
    }

    // How much of a map this panel covers, so the map can keep what matters above it. The map doesn't follow the panel as it's dragged,
    // like Apple's Maps: going along frame by frame has it lay itself out all over again, 30 frames a second on a real phone, so pass
    // where the panel came to rest (PanelRest), not where it is now.
    static func cover(_ d: PanelDetent, peek: CGFloat, total: CGFloat, middleShare: CGFloat = 0.62, tabBar: CGFloat = 84) -> CGFloat {
        switch d {
        case .peek: max(0, peek + tabBar - 84)
        case .middle, .full: max(0, total * middleShare - 84)
        }
    }
}

private enum PanelTop { static let id = "panel-top" }

// Where a panel came to rest. A map lays itself out for that once, after the panel has stopped: following it frame by frame is what costs.
// A view of its own, so the screen with the map isn't made again when the panel starts to move.
struct PanelRest: View {
    @Binding var detent: PanelDetent
    @Binding var rest: PanelDetent

    var body: some View {
        Color.clear
            .allowsHitTesting(false)
            .task(id: detent) {
                // As long as PanelDetent.spring takes: a map laying itself out under a panel that still moves is what stutters.
                try? await Task.sleep(for: .milliseconds(540))
                if !Task.isCancelled { rest = detent }
            }
    }
}

// How far the panel's list is scrolled. Not state: only a drag asks for it, and state would redo the whole panel with every point scrolled.
private final class PanelScroll {
    var top: CGFloat = 0
    var dragFromTop = false     // the drag going on started with the list at the top
}

// Keeps PanelScroll up to date while the list moves. A geometry reader in the list stops reporting on iOS 26: `top` stayed 0, so every
// swipe down counted as the list being at the top and took the panel with it.
private struct ScrollTopWatch: ViewModifier {
    var scroll: PanelScroll

    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.onScrollGeometryChange(for: CGFloat.self) { -($0.contentOffset.y + $0.contentInsets.top) } action: { _, top in scroll.top = top }
        } else {
            content.onPreferenceChange(ScrollTopKey.self) { scroll.top = $0 }
        }
    }
}

// A drag of the panel. Whether it may pull the panel down is settled as it starts: with the list scrolled the finger is scrolling, also
// once the list reaches the top under it.
private struct PanelDrag: Equatable {
    var offset: CGFloat = 0
    var fromTop: Bool?
    var pulling = false     // it pulled the panel down, so it's the panel's now, both ways, until the finger lets go
}

// The panel's height and its drag, apart from what's in it: a drag moves the frame without redoing the content, frame after frame.
private struct PanelFrame: ViewModifier {
    @Binding var detent: PanelDetent
    var peek: CGFloat
    var middleShare: CGFloat
    var tabBar: CGFloat
    var scroll: PanelScroll
    @GestureState private var drag = PanelDrag()
    // The bottom corners stay off the screen: rounding all four corners alike is far cheaper to draw than rounding two.
    private let below: CGFloat = 40

    func body(content: Content) -> some View {
        GeometryReader { geo in
            let total = geo.size.height
            let target = height(of: detent, total: total)
            let shown = max(peek + tabBar - 40, min(total, target - drag.offset))
            let wide = Room.wide(geo.size.width)
            content
                // Down, the panel shows its first line and nothing else: a list scrolling in that strip would end on whatever comes last.
                // Pulled, the list holds still: with both going by the finger, every wobble of a thumb hands it from one to the other, and
                // the panel stops and jumps. Here and not on the list: it only changes when a pull starts and ends.
                .scrollDisabled(detent == .peek || drag.pulling)
                .frame(width: wide ? Room.panel : geo.size.width, height: shown, alignment: .top)
                .padding(.bottom, below)
                .background(Theme.card)
                .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
                .shadowPlate(radius: 28, opacity: 0.16, blur: 24, y: -4)
                .offset(y: below)
                .padding(.trailing, wide ? Room.edge : 0)
                // An exact height: a flexible one grows with a panel taller than the screen, and it would hang off the bottom, under the tab bar.
                .frame(width: geo.size.width, height: total, alignment: .bottomTrailing)
                .simultaneousGesture(
                    DragGesture(minimumDistance: 12, coordinateSpace: .global)
                        .updating($drag) { value, state, _ in
                            if state.fromTop == nil { state.fromTop = scroll.top >= -2 }
                            scroll.dragFromTop = state.fromTop == true
                            // Down only moves the panel when its list was at the top to begin with, and still is.
                            if value.translation.height > 0, scroll.dragFromTop, scroll.top >= -2 { state.pulling = true }
                            if value.translation.height < 0 || state.pulling { state.offset = value.translation.height }
                        }
                        .onEnded { value in
                            let moved = value.predictedEndTranslation.height
                            guard moved < 0 || (scroll.dragFromTop && scroll.top >= -2) else { return }
                            let best = settle(from: detent, moved: moved, finger: target - value.translation.height, total: total)
                            withAnimation(PanelDetent.spring) { detent = best }
                        }
                )
                // Quick under the finger. Let go, and it's the panel's own spring: this one would otherwise win, and snap it there.
                .animation(drag.offset == 0 ? PanelDetent.spring : .interactiveSpring(), value: drag.offset)
        }
        .ignoresSafeArea(.container, edges: .bottom)
    }

    // Where a swipe ends. From all the way down or up, any swipe more than a nudge goes to the middle: that's where a panel likes to stay.
    // Going all the way down takes the finger itself most of the way there, so a swipe made to scroll never ends up down there.
    private func settle(from: PanelDetent, moved: CGFloat, finger: CGFloat, total: CGFloat) -> PanelDetent {
        let middle = height(of: .middle, total: total), low = height(of: .peek, total: total)
        let pulledDown = finger < low + (middle - low) * 0.3
        switch from {
        case .peek:
            guard moved < -16 else { return .peek }
            return finger > (middle + height(of: .full, total: total)) / 2 ? .full : .middle
        case .full:
            guard moved > 16 else { return .full }
            return pulledDown ? .peek : .middle
        case .middle:
            if moved > 0 { return pulledDown ? .peek : .middle }
            return abs(height(of: .full, total: total) - (middle - moved)) < abs(moved) ? .full : .middle
        }
    }

    private func height(of d: PanelDetent, total: CGFloat) -> CGFloat {
        switch d {
        case .peek: peek + tabBar
        case .middle: total * middleShare
        case .full: total - 8
        }
    }
}

extension View {
    // Something to tap on the part of a panel that shows when it's down. Not a Button: its list can't scroll there, so nothing cancels
    // the Button when the finger moves, and a short swipe up would both tap it and move the panel, each undoing the other.
    func panelTap(_ action: @escaping () -> Void) -> some View {
        contentShape(Rectangle())
            .onTapGesture(perform: action)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
    }
}

// A button in a panel's footer, which has no list to cancel it: it looks like `look` and fires only if the finger didn't move.
// `.buttonStyle(PanelTap(PrimaryButtonStyle()))`
struct PanelTap<Look: ButtonStyle>: PrimitiveButtonStyle {
    var look: Look
    init(_ look: Look) { self.look = look }

    func makeBody(configuration: Configuration) -> some View {
        Face(look: look, configuration: configuration)
    }

    private struct Face: View {
        @Environment(\.isEnabled) private var enabled
        var look: Look
        var configuration: Configuration

        var body: some View {
            Button {} label: { configuration.label }
                .buttonStyle(look)
                .allowsHitTesting(false)
                .panelTap { if enabled { configuration.trigger() } }
        }
    }
}

extension BottomPanel where Footer == EmptyView {
    init(detent: Binding<PanelDetent>, peek: CGFloat = 150, tabBar: CGFloat = 84, @ViewBuilder content: @escaping () -> Content) {
        self.init(detent: detent, peek: peek, tabBar: tabBar, content: content, footer: { EmptyView() })
    }
}

private struct ScrollTopKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

// A car on the map.
// A driver on the rider's map, with how long until they're at the pickup.
struct DriverPin: View {
    var vehicle: String?
    var eta: String?

    var body: some View {
        CarPin(vehicle: vehicle)
            .overlay(alignment: .top) {
                if let eta {
                    Text(eta)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Theme.night, in: Capsule())
                        .shadow(color: .black.opacity(0.22), radius: 4, y: 2)
                        .fixedSize()
                        .offset(y: -27)
                }
            }
    }
}

// Time left, on the server's clock: minutes and seconds, red near the end.
struct Countdown: View {
    var until: Double
    var redBelow = 60

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let left = max(0, Int(ServerClock.date(until).timeIntervalSince(ctx.date)))
            HStack(spacing: 4) {
                Image(systemName: "timer").font(.caption.weight(.bold))
                Text(String(format: "%d:%02d", left / 60, left % 60))
                    .font(.subheadline.weight(.semibold).monospacedDigit())
                    .contentTransition(.numericText(countsDown: true))
            }
            .foregroundStyle(left < redBelow ? Theme.danger : Theme.ink)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(left < redBelow ? Theme.dangerSoft : Theme.soft, in: Capsule())
            .animation(.snappy, value: left)
        }
    }
}

// The same time left, as a ring that runs out: for a choice that has to be made in time.
struct CountdownRing: View {
    var until: Double
    var total: Double = 300
    var size: CGFloat = 66
    var redBelow = 60

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let left = max(0, Int(ServerClock.date(until).timeIntervalSince(ctx.date)))
            let color = left < redBelow ? Theme.danger : Theme.accent
            ZStack {
                Circle().stroke(Theme.line, lineWidth: 5)
                Circle()
                    .trim(from: 0, to: min(1, Double(left) / total))
                    .stroke(color, style: StrokeStyle(lineWidth: 5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                    .animation(.linear(duration: 1), value: left)
                Text(String(format: "%d:%02d", left / 60, left % 60))
                    .font(.system(size: size * 0.25, weight: .bold).monospacedDigit())
                    .foregroundStyle(left < redBelow ? Theme.danger : Theme.ink)
            }
            .frame(width: size, height: size)
        }
    }
}

// Dashes that run along a road, at 30 frames a second: on screen for hours in a car, they shouldn't take the battery to 120.
struct RunningDashes<Line: Shape>: View {
    var line: Line
    var color: Color
    var lineWidth: CGFloat
    var dash: [CGFloat]
    var seconds: Double

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { context in
            let length = dash.reduce(0, +)
            let phase = -length * context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: seconds) / seconds
            line.stroke(color, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, dash: dash, dashPhase: phase))
        }
    }
}

// How far along a ride is, on Drivezzz's own road, the one from the logo: a car drives along it while the dashes run.
struct RideSteps: View {
    var ride: Ride
    // Cash is paid in the car, so there's no step for it.
    private var labels: [String] {
        ride.isCash ? [String(localized: "Driver"), String(localized: "Pickup"), String(localized: "Ride")]
            : [String(localized: "Driver"), String(localized: "Pay"), String(localized: "Pickup"), String(localized: "Ride")]
    }

    private var step: Int {
        let step = switch ride.status {
        case "searching", "offered", "open": 0
        case "awaiting_payment": 1
        case "accepted", "arrived", "scheduled": 2
        case "riding": 3
        default: 4
        }
        return ride.isCash && step > 1 ? step - 1 : step
    }
    // How far along the part that's under way: halfway, or while the driver comes and on the ride, as far as they've got, so the
    // car on the road moves with every position (Pieter, 8 November 2026: a rider waiting wants to see the driver getting there).
    private var along: CGFloat {
        func share(_ left: Int?, of all: Int?) -> CGFloat? {
            guard let left, let all, all > 0 else { return nil }
            return min(0.9, max(0.1, 1 - CGFloat(left) / CGFloat(all)))
        }
        switch ride.status {
        case "accepted": return share(ride.driverToPickupM, of: ride.pickupM) ?? 0.5
        case "riding": return share(ride.driverToDropoffM, of: ride.distanceM) ?? 0.5
        default: return 0.5
        }
    }
    private var progress: CGFloat { min(1, (CGFloat(step) + along) / CGFloat(labels.count)) }

    var body: some View {
        VStack(spacing: 6) {
            GeometryReader { geo in
                let width = geo.size.width, height = geo.size.height
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.road).frame(height: 16)
                    Capsule().fill(Theme.accent).frame(width: max(16, width * progress), height: 16)
                    RunningDashes(line: Path { p in
                        p.move(to: CGPoint(x: 8, y: height / 2))
                        p.addLine(to: CGPoint(x: width - 8, y: height / 2))
                    }, color: .white.opacity(0.65), lineWidth: 1.5, dash: [5, 6], seconds: 0.8)
                    Image(systemName: Vehicle.icon(ride.driver?.car?.kind))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(Theme.night)
                        .frame(width: 26, height: 26)
                        .background(.white, in: Circle())
                        .shadow(color: .black.opacity(0.3), radius: 3, y: 1)
                        .offset(x: min(width - 26, max(0, width * progress - 13)))
                }
                .animation(.spring(response: 0.7, dampingFraction: 0.75), value: progress)
            }
            .frame(height: 26)
            HStack(spacing: 0) {
                ForEach(labels.indices, id: \.self) { i in
                    Text(labels[i])
                        .font(.caption2.weight(i == step ? .bold : .medium))
                        .foregroundStyle(i <= step ? Theme.ink : Theme.faint)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(min(step + 1, labels.count)) of \(labels.count)")
    }
}

// What a pin on the map shows of a driver: their price and stars while they fit, or only the circle. A tap on a circle zooms in on it.
enum PinStyle: Equatable {
    case hidden, circle, label     // hidden: far out, or it would land under someone's bubble. It shows when zooming in
}

// A circle with the vehicle in it, with a short line up to a bubble with the price and the stars. Every driver sets their own price, so the map is the market.
struct PricePin: View {
    var vehicle: String?
    var text: String
    var eta: String?
    var rating: Double?
    var verified = false
    var selected = false
    var busy = false
    var style: PinStyle = .label

    private static let circle: CGFloat = 26
    private static let bubble: CGFloat = 24
    private static let line: CGFloat = 8        // from the bubble down to the circle

    private var shown: PinStyle { selected ? .label : style }
    private var fill: Color { selected ? Theme.night : Theme.accent }

    var body: some View {
        Group {
            switch shown {
            case .hidden:
                Color.clear.frame(width: 1, height: 1)
            case .circle:
                vehicleCircle
                    .frame(width: 30, height: 30)
                    .contentShape(Circle())
            case .label:
                VStack(spacing: 0) {
                    bubble
                    Rectangle().fill(fill).frame(width: 3, height: Self.line)
                    vehicleCircle
                }
                .contentShape(Rectangle())
                // A map centres a pin on its spot: the same room below the circle keeps the circle there. It's outside what a finger can tap.
                .padding(.bottom, Self.bubble + Self.line)
            }
        }
        .opacity(busy ? 0.6 : 1)
        .animation(.snappy(duration: 0.2), value: shown)
    }

    private var bubble: some View {
        HStack(spacing: 4) {
            Text(text).font(.system(size: 11.5, weight: .bold)).kerning(-0.2).monospacedDigit().contentTransition(.numericText())
            stars
            if selected, let eta { Text(eta).font(.system(size: 10, weight: .semibold)).opacity(0.75) }
            if verified { VerifiedMark(size: 11, rim: true) }
        }
        .foregroundStyle(selected ? .white : Theme.onAccent)
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 10)
        .frame(height: Self.bubble)
        .background(fill, in: Capsule())
        .shadow(color: .black.opacity(0.22), radius: 3, y: 1)
    }

    private var vehicleCircle: some View {
        Image(systemName: Vehicle.icon(vehicle))
            .font(.system(size: Self.circle * 0.45, weight: .bold))
            .foregroundStyle(Theme.onAccent)
            .frame(width: Self.circle, height: Self.circle)
            .background(Theme.accent, in: Circle())
            .overlay(Circle().stroke(Theme.card, lineWidth: 2))
    }

    @ViewBuilder
    private var stars: some View {
        if let rating {
            HStack(spacing: 2) {
                Image(systemName: "star.fill").font(.system(size: 8))
                Text(Lang.number(String(format: "%.1f", rating))).font(.system(size: 11, weight: .semibold)).monospacedDigit()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(String(localized: "\(Lang.number(String(format: "%.1f", rating))) stars"))
        } else {
            Text("New").font(.system(size: 10, weight: .semibold)).opacity(0.85)
        }
    }
}

// Rings going out from a spot: looking for a driver, or a driver who's online.
struct Radar: View {
    var color: Color = Theme.accent
    var size: CGFloat = 170
    @State private var going = false

    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(color.opacity(0.14))
                    .overlay(Circle().stroke(color.opacity(0.75), lineWidth: 1.5))
                    .scaleEffect(going ? 1 : 0.08)
                    .opacity(going ? 0 : 1)
                    .animation(.easeOut(duration: 2.7).repeatForever(autoreverses: false).delay(Double(i) * 0.9), value: going)
            }
        }
        .frame(width: size, height: size)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
        .onAppear { going = true }
    }
}

// The moment a payment lands: the coin drops in and the escrow locks. This is what no other ride app has, so it gets its moment.
struct EscrowMoment: View {
    var price: String
    var coin: String?
    var done: () -> Void
    @State private var dropped = false
    @State private var locked = false

    var body: some View {
        ZStack {
            Theme.night.ignoresSafeArea()
            VStack(spacing: 26) {
                ZStack {
                    Circle().stroke(.white.opacity(0.13), lineWidth: 9)
                    Circle()
                        .trim(from: 0, to: locked ? 1 : 0)
                        .stroke(Theme.accent, style: StrokeStyle(lineWidth: 9, lineCap: .round))
                        .rotationEffect(.degrees(-90))
                    CoinBadge(coin: coin, size: 72)
                        .offset(y: dropped ? 0 : -260)
                        .scaleEffect(locked ? 0.2 : 1)
                        .opacity(locked ? 0 : 1)
                    Image(systemName: "lock.fill")
                        .font(.system(size: 50, weight: .semibold))
                        .foregroundStyle(.white)
                        .scaleEffect(locked ? 1 : 0.2)
                        .opacity(locked ? 1 : 0)
                }
                .frame(width: 150, height: 150)
                VStack(spacing: 8) {
                    Text("Locked in escrow").font(.system(size: 30, weight: .bold)).kerning(-0.6).foregroundStyle(.white)
                    Text("\(price) waits safely on Solana until your ride is done.")
                        .font(.subheadline)
                        .foregroundStyle(.white.opacity(0.72))
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 34)
                .opacity(locked ? 1 : 0)
                .offset(y: locked ? 0 : 12)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { done() }
        .sensoryFeedback(.success, trigger: locked)
        .task {
            withAnimation(.spring(response: 0.55, dampingFraction: 0.6)) { dropped = true }
            try? await Task.sleep(for: .milliseconds(650))
            withAnimation(.spring(response: 0.6, dampingFraction: 0.72)) { locked = true }
            try? await Task.sleep(for: .milliseconds(2300))
            done()
        }
    }
}

// Shows that moment over a screen when a ride goes from waiting for payment to paid.
private struct EscrowMomentOver: ViewModifier {
    var status: String?
    var price: String
    var coin: String?
    @State private var showing = false

    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: $showing) {
                EscrowMoment(price: price, coin: coin) { showing = false }
                    .presentationBackground(Theme.night)
            }
            .onChange(of: status) { old, new in
                if old == "awaiting_payment", ["accepted", "arrived", "riding", "scheduled"].contains(new ?? "") { showing = true }
            }
    }
}

extension View {
    func escrowMoment(status: String?, price: String, coin: String?) -> some View {
        modifier(EscrowMomentOver(status: status, price: price, coin: coin))
    }

    // Apple's glass on what floats over a map; plain white before iOS 26.
    @ViewBuilder
    func glassy<S: Shape>(in shape: S, radius: CGFloat = 22) -> some View {
        if #available(iOS 26, *) {
            self.glassEffect(.regular, in: shape)
        } else {
            self.background(Theme.card, in: shape).lifted(radius: radius)
        }
    }
}

// Naming your price: a ruler you slide under a needle, ticking as it goes, with the cheapest driver's price marked on it.
struct PriceRuler: View {
    @Binding var cents: Int
    var cheapest: Int?
    private let step = 50, low = 100, high = 30_000
    private let tickWidth: CGFloat = 16
    @State private var tick: Int?

    private var count: Int { (high - low) / step }
    private func index(_ value: Int) -> Int { max(0, min(count, (value - low + step / 2) / step)) }

    var body: some View {
        GeometryReader { geo in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 0) {
                    ForEach(0...count, id: \.self) { i in
                        let value = low + i * step
                        let major = value % 500 == 0
                        VStack(spacing: 5) {
                            Capsule()
                                .fill(i == cheapestIndex ? Theme.ok : Theme.ink.opacity(major ? 0.85 : 0.22))
                                .frame(width: i == cheapestIndex ? 3 : 2, height: major || i == cheapestIndex ? 30 : 16)
                            if major {
                                Text("€\(value / 100)").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted).fixedSize()
                            }
                        }
                        .frame(width: tickWidth, height: 56, alignment: .top)
                        .id(i)
                    }
                }
                .scrollTargetLayout()
            }
            .safeAreaPadding(.horizontal, geo.size.width / 2 - tickWidth / 2)
            .scrollTargetBehavior(.viewAligned)
            .scrollPosition(id: $tick, anchor: .center)
            .overlay(alignment: .top) {
                Capsule().fill(Theme.accent).frame(width: 4, height: 38).offset(y: -4).allowsHitTesting(false)
            }
            .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.16), .init(color: .black, location: 0.84), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
        }
        .frame(height: 58)
        .sensoryFeedback(.selection, trigger: tick)
        .onAppear { tick = index(cents) }
        .onChange(of: tick) { _, i in
            if let i { cents = low + i * step }
        }
        .onChange(of: cents) { _, value in
            if tick != index(value) { withAnimation(.snappy) { tick = index(value) } }
        }
        .accessibilityHidden(true)
    }

    private var cheapestIndex: Int? { cheapest.map(index) }
}

extension MapStyle {
    // Calm, without shops and the like, so that a route and its pins stand out. Not `.muted`: that looks washed out on a real iPhone.
    // Flat: raised 3D roads hide the route, and crashed Apple's map renderer in testing.
    static func drivezzz(traffic: Bool = false) -> MapStyle {
        .standard(elevation: .flat, pointsOfInterest: .excludingAll, showsTraffic: traffic)
    }
}

struct CarPin: View {
    var color: Color = Theme.accent
    var heading: Double?
    var vehicle: String?

    var body: some View {
        Image(systemName: vehicle == "motor" ? "motorcycle.fill" : vehicle == "scooter" ? "scooter" : "car.fill")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Theme.onAccent)
            .frame(width: 36, height: 36)
            .background(color, in: Circle())
            .overlay(Circle().stroke(.white, lineWidth: 2.5))
            .shadow(color: .black.opacity(0.26), radius: 6, y: 3)
    }
}

// Green: now. Red: booked for a time.
struct OrderPin: View {
    var planned: Bool
    var cents: Int?
    var booked = false      // the driver's own ride: a check before the price, and a tap opens the ride

    var body: some View {
        HStack(spacing: 3) {
            if booked { Image(systemName: "checkmark").font(.caption2.weight(.heavy)) }
            Text(Fmt.eur(cents)).font(.caption.weight(.bold))
        }
        .foregroundStyle(planned ? Theme.night : .white)
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(planned ? Theme.planned : Theme.now, in: Capsule())
        .overlay(Capsule().stroke(.white, lineWidth: 2))
        .shadow(color: .black.opacity(0.26), radius: 6, y: 3)
    }
}

// A QR code for a wallet to scan.
import CoreImage.CIFilterBuiltins

struct QRCode: View {
    var text: String
    var size: CGFloat = 180

    var body: some View {
        if let image = make() {
            // Always on white: a wallet can't scan it on a dark page.
            Image(uiImage: image).interpolation(.none).resizable().frame(width: size, height: size)
                .padding(12)
                .background(.white, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
    }

    private func make() -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let out = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)),
              let cg = CIContext().createCGImage(out, from: out.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}

func openInMaps(_ place: Place, name: String) {
    let item = MKMapItem(placemark: MKPlacemark(coordinate: place.coordinate))
    item.name = name
    item.openInMaps(launchOptions: [MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving])
}

// Going online or offline takes a slide, so a bump in the car can't do it by accident.
struct SlideControl: View {
    var title: String
    var fill: Color
    var ink: Color
    var working = false
    var action: () -> Void
    @State private var moved: CGFloat = 0
    @State private var completed = 0
    private let knob: CGFloat = 50

    var body: some View {
        GeometryReader { geo in
            let room = max(1, geo.size.width - knob - 8)
            ZStack(alignment: .leading) {
                Capsule().fill(fill)
                RunningDashes(line: Path { p in
                    p.move(to: CGPoint(x: knob, y: geo.size.height / 2))
                    p.addLine(to: CGPoint(x: geo.size.width - 22, y: geo.size.height / 2))
                }, color: ink.opacity(0.28), lineWidth: 2, dash: [8, 9], seconds: 0.9)
                .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .clear, location: 0.28), .init(color: .clear, location: 0.72), .init(color: .black, location: 1)], startPoint: .leading, endPoint: .trailing))
                .opacity(1 - min(1, moved / room * 1.5))
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .kerning(-0.2)
                    .foregroundStyle(ink)
                    .frame(maxWidth: .infinity)
                    .padding(.leading, knob * 0.7)
                    .opacity(1 - min(1, moved / room * 1.5))
                ZStack {
                    Circle().fill(.white)
                    if working {
                        ProgressView().tint(Theme.night)
                    } else {
                        Image(systemName: "car.side.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(Theme.night)
                            .scaleEffect(x: -1)
                    }
                }
                .frame(width: knob, height: knob)
                .shadow(color: .black.opacity(0.2), radius: 3, y: 1)
                .offset(x: 4 + moved)
            }
            .contentShape(Capsule())
            .gesture(
                DragGesture(minimumDistance: 2)
                    .onChanged { value in if !working { moved = min(room, max(0, value.translation.width)) } }
                    .onEnded { _ in
                        let far = moved >= room * 0.85
                        withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) { moved = 0 }
                        if far, !working {
                            completed += 1
                            action()
                        }
                    }
            )
        }
        .frame(height: 58)
        .lifted(radius: 29)
        .sensoryFeedback(.success, trigger: completed)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction { if !working { action() } }
    }
}


// What cancelling costs, said before ordering.
struct CancelTerms: View {
    var planned: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle.fill").foregroundStyle(Theme.faint)
            Text(planned
                 ? String(localized: "Ordering is free. You pay once a driver takes it, at least 30 minutes before. Free to cancel until 3 hours before; later you get 50% back and the driver 50%. If the driver cancels, you get everything back.")
                 : String(localized: "Ordering is free. A driver has 5 minutes to accept, then you have 5 minutes to pay. Cancelling before you pay is free. Once you’ve paid: 50% back, or everything if the driver is late or cancels."))
                .font(.caption)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.soft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

// A round chat button that opens the conversation with someone.
struct MessageButton: View {
    var userId: String
    var name: String
    var big = false
    @State private var open = false

    var body: some View {
        Button { open = true } label: {
            if big {
                Label("Message \(name)", systemImage: "bubble.left.and.bubble.right.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accentInk)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: Theme.buttonRadius, style: .continuous))
            } else {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Theme.accentInk)
                    .frame(width: 46, height: 46)
                    .background(Theme.accentSoft, in: Circle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Message \(name)")
        .sheet(isPresented: $open) {
            NavigationStack {
                ChatScreen(userId: userId, name: name)
                    .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { open = false } } }
            }
        }
    }
}

// ---------- cards ----------

// A coin's round badge in its own colours, like a wallet app shows it.
struct CoinBadge: View {
    var coin: String?
    var size: CGFloat = 40

    private var look: (glyph: String, colors: [Color], ink: Color) {
        switch coin {
        case "sol": ("◎", [Color(hex: 0x9945FF), Color(hex: 0x14F195)], .white)
        case "usdc-sol": ("$", [Color(hex: 0x2775CA), Color(hex: 0x1C5BA3)], .white)
        case "cash": ("€", [Color(hex: 0x2E9E6B), Color(hex: 0x1F7A52)], .white)
        case "xrp": ("✕", [Color(hex: 0x23292F), Color(hex: 0x3A434D)], .white)
        case "ltc": ("Ł", [Color(hex: 0x345D9D), Color(hex: 0x6A8FCB)], .white)
        case "xlm": ("✦", [Color(hex: 0x0F0F0F), Color(hex: 0x3D3D3D)], .white)
        default: ("¤", [Theme.accent, Theme.accentInk], Theme.onAccent)
        }
    }

    var body: some View {
        Text(look.glyph)
            .font(.system(size: size * 0.46, weight: .heavy, design: .rounded))
            .foregroundStyle(look.ink)
            .frame(width: size, height: size)
            .background(LinearGradient(colors: look.colors, startPoint: .topLeading, endPoint: .bottomTrailing), in: Circle())
            .overlay(alignment: .bottomTrailing) {
                // USDC lives on Solana: a small Solana mark says where.
                if coin == "usdc-sol" {
                    Circle()
                        .fill(LinearGradient(colors: [Color(hex: 0x9945FF), Color(hex: 0x14F195)], startPoint: .topLeading, endPoint: .bottomTrailing))
                        .frame(width: size * 0.38, height: size * 0.38)
                        .overlay(Circle().stroke(.white, lineWidth: 1.5))
                        .offset(x: 2, y: 2)
                }
            }
            .accessibilityHidden(true)
    }
}

// A small rounded square with a coloured symbol, at the start of a menu row.
struct IconTile: View {
    var symbol: String
    var tint: Color = Theme.accentInk
    var background: Color = Theme.accentSoft

    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(tint)
            .frame(width: 36, height: 36)
            .background(background, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
    }
}

// A row in a card: icon, title, what's on the right, a chevron when it opens something.
struct CardRow<Trailing: View>: View {
    var symbol: String
    var title: String
    var subtitle: String?
    var tint: Color = Theme.accentInk
    var background: Color = Theme.accentSoft
    var chevron = true
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 12) {
            IconTile(symbol: symbol, tint: tint, background: background)
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(.body.weight(.medium)).foregroundStyle(tint == Theme.danger ? Theme.danger : Theme.ink)
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(Theme.faint).lineLimit(2) }
            }
            Spacer(minLength: 8)
            trailing
            if chevron { Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.faint) }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }
}

extension CardRow where Trailing == EmptyView {
    init(symbol: String, title: String, subtitle: String? = nil, tint: Color = Theme.accentInk, background: Color = Theme.accentSoft, chevron: Bool = true) {
        self.init(symbol: symbol, title: title, subtitle: subtitle, tint: tint, background: background, chevron: chevron) { EmptyView() }
    }
}

// The line between two rows of a card.
struct CardDivider: View {
    var body: some View { Divider().padding(.leading, 62) }
}

// A white card under a small title; put a CardDivider between its rows.
struct CardGroup<Content: View>: View {
    var title: String?
    var footer: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let title { Text(title).font(.title3.weight(.bold)).kerning(-0.3).padding(.horizontal, 4) }
            VStack(spacing: 0) { content }
                .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .lifted(0.45, radius: 22)
            if let footer { Text(footer).font(.footnote).foregroundStyle(Theme.faint).padding(.horizontal, 4) }
        }
    }
}

// The big coloured card at the top of a screen, in your colour.
struct HeroCard<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .foregroundStyle(Theme.onAccent)
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.accent)
            .clipShape(RoundedRectangle(cornerRadius: 28, style: .continuous))
            .lifted(0.7, radius: 28)
    }
}
