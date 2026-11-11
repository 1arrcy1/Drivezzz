import SwiftUI
import UIKit

// The colour a rider or driver picks in Profile. It runs through the whole app: buttons, tabs, switches, segmented
// controls, icons, stars, the logo and loading screen, map pins and the route.
enum AppAccent: String, CaseIterable, Identifiable {
    case blue, red, yellow

    // Read by Theme; RootView rebuilds when it changes.
    static var current = AppAccent(rawValue: UserDefaults.standard.string(forKey: "accent") ?? "") ?? .blue

    var id: String { rawValue }
    var name: String {
        switch self {
        case .blue: String(localized: "Blue")
        case .red: String(localized: "Red")
        case .yellow: String(localized: "Yellow")
        }
    }
    var color: Color {
        switch self {
        case .blue: Color(hex: 0x1659E0)
        case .red: Color(hex: 0xD92D20)
        case .yellow: Color(hex: 0xF5C400)
        }
    }
    // What's readable on it.
    var onColor: Color { self == .yellow ? Theme.night : .white }
    // For text and small icons on a card: yellow goes with near-black in light, and is itself readable in dark.
    var deep: Color {
        switch self {
        case .blue: Color(light: 0x1659E0, dark: 0x7AA5FF)
        case .red: Color(light: 0xC4251A, dark: 0xFF8A80)
        case .yellow: Color(light: 0x0F172A, dark: 0xF5C400)
        }
    }
    // The same on something that stays white, whatever the appearance.
    var onWhite: Color {
        switch self {
        case .blue: Color(hex: 0x1659E0)
        case .red: Color(hex: 0xC4251A)
        case .yellow: Theme.night
        }
    }
    var soft: Color {
        switch self {
        case .blue: Color(light: 0xEDF2FE, dark: 0x1B2A4D)
        case .red: Color(light: 0xFDECEA, dark: 0x3D1C1A)
        case .yellow: Color(light: 0xFFF7D1, dark: 0x2B2D33)
        }
    }
    // A route on the map: brighter on a dark one.
    var route: Color {
        switch self {
        case .blue: Color(light: 0x1659E0, dark: 0x5B8DFF)
        case .red: Color(light: 0xD92D20, dark: 0xFF6259)
        case .yellow: Color(hex: 0xF5C400)
        }
    }
    var top: Color {
        switch self {
        case .blue: Color(hex: 0x2F7BFF)
        case .red: Color(hex: 0xEF4A3E)
        case .yellow: Color(hex: 0xFFD83D)
        }
    }
    var bottom: Color {
        switch self {
        case .blue: Color(hex: 0x0B4FD6)
        case .red: Color(hex: 0xB91C13)
        case .yellow: Color(hex: 0xF0B800)
        }
    }

    // UIKit's segmented control only takes its colours this way.
    func applyToControls() {
        let segments = UISegmentedControl.appearance()
        segments.selectedSegmentTintColor = UIColor(color)
        segments.setTitleTextAttributes([.foregroundColor: UIColor(onColor)], for: .selected)
    }
}

// Automatic follows the sun where you are; Light and Dark stay as they are. Set in Profile.
enum AppAppearance: String, CaseIterable, Identifiable {
    case auto, light, dark

    static var saved: AppAppearance { AppAppearance(rawValue: UserDefaults.standard.string(forKey: "appearance") ?? "") ?? .auto }

    var id: String { rawValue }
    var name: String {
        switch self {
        case .auto: String(localized: "Automatic")
        case .light: String(localized: "Light")
        case .dark: String(localized: "Dark")
        }
    }
    var symbol: String {
        switch self {
        case .auto: "sun.horizon.fill"
        case .light: "sun.max.fill"
        case .dark: "moon.fill"
        }
    }
}

// Whether it's dark outside at a place, worked out on the phone from the sun's position (NOAA's formulas): nothing is asked of a
// server, and the far north's weeks of sun or dark just work. Dark starts a little after sunset, when it really gets dark.
enum Sunlight {
    private static let darkBelow = -3.0

    // The sun's height above the horizon, in degrees.
    static func elevation(at date: Date, lat: Double, lng: Double) -> Double {
        let rad = Double.pi / 180
        let seconds = date.timeIntervalSince1970
        let t = (seconds / 86400 + 2440587.5 - 2451545) / 36525
        let l0 = (280.46646 + t * (36000.76983 + t * 0.0003032)).truncatingRemainder(dividingBy: 360)
        let m = 357.52911 + t * (35999.05029 - 0.0001537 * t)
        let e = 0.016708634 - t * (0.000042037 + 0.0000001267 * t)
        let center = sin(m * rad) * (1.914602 - t * (0.004817 + 0.000014 * t)) + sin(2 * m * rad) * (0.019993 - 0.000101 * t) + sin(3 * m * rad) * 0.000289
        let omega = 125.04 - 1934.136 * t
        let longitude = l0 + center - 0.00569 - 0.00478 * sin(omega * rad)
        let obliquity = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60 + 0.00256 * cos(omega * rad)
        let declination = asin(sin(obliquity * rad) * sin(longitude * rad))
        let y = pow(tan(obliquity * rad / 2), 2)
        let equation = 4 / rad * (y * sin(2 * l0 * rad) - 2 * e * sin(m * rad) + 4 * e * y * sin(m * rad) * cos(2 * l0 * rad)
                                  - 0.5 * y * y * sin(4 * l0 * rad) - 1.25 * e * e * sin(2 * m * rad))
        let minutes = (seconds / 60).truncatingRemainder(dividingBy: 1440)
        let solar = (minutes + equation + 4 * lng).truncatingRemainder(dividingBy: 1440)
        let hourAngle = (solar / 4 - 180) * rad
        let height = sin(lat * rad) * sin(declination) + cos(lat * rad) * cos(declination) * cos(hourAngle)
        return asin(max(-1, min(1, height))) / rad
    }

    static func isDark(at date: Date, lat: Double, lng: Double) -> Bool {
        elevation(at: date, lat: lat, lng: lng) < darkBelow
    }

    // Before the phone has ever known where it is: the clock has to do.
    static func isDarkByClock(at date: Date) -> Bool {
        let hour = Calendar.current.component(.hour, from: date)
        return hour >= 20 || hour < 7
    }
}

// Drivezzz's look: a calm map, cards that lift off the page with soft shadows, bold type, and one colour of your choice, in light
// and in dark. Green and red for orders and warnings keep their meaning whatever you choose. Everything on screen uses these:
// no fixed white or black, or it breaks in the other appearance.
// `night` is the one dark that stays dark, for what carries white text (the turn banner, the escrow moment, text on yellow).
enum Theme {
    static var accent: Color { AppAccent.current.color }
    static var onAccent: Color { AppAccent.current.onColor }
    static var accentInk: Color { AppAccent.current.deep }
    static var accentSoft: Color { AppAccent.current.soft }
    static var gradient: LinearGradient { LinearGradient(colors: [AppAccent.current.top, AppAccent.current.bottom], startPoint: .top, endPoint: .bottom) }
    // The middle line of the road in the logo, and the edge that keeps a route readable on the map.
    static var roadDash: Color { AppAccent.current == .yellow ? AppAccent.current.color : AppAccent.current.deep }
    static var routeEdge: Color { AppAccent.current == .yellow ? night : Color(light: 0xFFFFFF, dark: 0x0F172A) }
    static var route: Color { AppAccent.current.route }
    static var accentOnWhite: Color { AppAccent.current.onWhite }

    static let ink = Color(light: 0x0F172A, dark: 0xF1F3F7)
    static let muted = Color(light: 0x4B5563, dark: 0xAEB6C2)
    static let faint = Color(light: 0x6B7280, dark: 0x8B93A1)
    static let line = Color(light: 0xE9EBEF, dark: 0x2C313C)
    static let soft = Color(light: 0xF4F5F7, dark: 0x252933)    // a fill inside a card
    static let page = Color(light: 0xF4F5F7, dark: 0x0B0D12)    // behind the cards
    static let card = Color(light: 0xFFFFFF, dark: 0x171A21)
    static let raised = Color(light: 0xFFFFFF, dark: 0x3A404D)  // what slides over a fill: the switch's thumb
    static let night = Color(hex: 0x0F172A)
    static let road = Color(light: 0x0F172A, dark: 0x2F3543)    // the road of the progress bar and the slide to go offline
    static let pickupPin = Color(light: 0xF97316, dark: 0xFB923C)  // the pickup spot, on every map and in every list: orange (Pieter's choice)
    static let ok = Color(light: 0x15803D, dark: 0x4ADE80)
    static let okSoft = Color(light: 0xE7F6EC, dark: 0x12301C)
    static let okFill = Color(hex: 0x15803D)                    // a green button, with white on it
    static let verified = Color(light: 0x1659E0, dark: 0x5B9BFF)   // the check of a verified driver: always blue, whatever colour the app is set to
    static let verifiedSoft = Color(light: 0xEDF2FE, dark: 0x1B2A4D)
    static let danger = Color(light: 0xDC2626, dark: 0xF87171)
    static let dangerSoft = Color(light: 0xFDEEEE, dark: 0x3A1717)
    static let warn = Color(light: 0xC2410C, dark: 0xFB923C)
    static let warnSoft = Color(light: 0xFFF1E6, dark: 0x2F2A2B)
    static let ongoing = Color(hex: 0x0F172A)  // a ride under way: yellow, with ink on it so it can be read
    static let ongoingSoft = Color(hex: 0xFEF08A)
    static let plate = Color(hex: 0xF7C600)
    static let plateBand = Color(hex: 0x0B4FD6)
    static let now = Color(hex: 0x15803D)      // an order looking for a driver now
    static let planned = Color(hex: 0xFACC15)  // an order booked for a time: yellow, with ink on it
    static let radius: CGFloat = 18
    static let buttonRadius: CGFloat = 16
}

// A list's icons in your colour, the words in ink. Set for the whole app.
struct AccentLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        Label {
            configuration.title
        } icon: {
            configuration.icon.foregroundStyle(Theme.accentInk)
        }
        .labelStyle(.automatic)
    }
}

extension Color {
    // One colour for each appearance: it follows by itself, also when the appearance changes on screen.
    init(light: UInt32, dark: UInt32) {
        func make(_ hex: UInt32) -> UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
        let lightColor = make(light), darkColor = make(dark)
        self.init(uiColor: UIColor { $0.userInterfaceStyle == .dark ? darkColor : lightColor })
    }
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
    init?(hexString: String?) {
        guard let hexString, let value = UInt32(hexString.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) else { return nil }
        self.init(hex: value)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var height: CGFloat = 54
    var color: Color = Theme.accent
    var textColor: Color = Theme.onAccent
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 17, weight: .semibold))
            .kerning(-0.2)
            .foregroundStyle(isEnabled ? textColor : Theme.faint)
            .frame(maxWidth: .infinity, minHeight: height)
            .background(isEnabled ? color : Theme.line, in: RoundedRectangle(cornerRadius: Theme.buttonRadius, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Theme.buttonRadius, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// The second choice next to a primary button: a quiet fill, on white and on grey alike.
struct GhostButtonStyle: ButtonStyle {
    var height: CGFloat = 54
    var color: Color = Theme.ink
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .kerning(-0.2)
            .foregroundStyle(isEnabled ? color : Theme.faint)
            .frame(maxWidth: .infinity, minHeight: height)
            .background(color.opacity(configuration.isPressed ? 0.14 : 0.07), in: RoundedRectangle(cornerRadius: Theme.buttonRadius, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: Theme.buttonRadius, style: .continuous))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

// The mark: a road shaped like a Z, with a dashed middle line. In a 1000 x 1000 box, like design/make-icon.swift.
struct ZRoad: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 1000
        let dx = rect.midX - 500 * s, dy = rect.midY - 500 * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: dx + x * s, y: dy + y * s) }
        var path = Path()
        path.move(to: p(270, 290))
        path.addLine(to: p(730, 290))
        path.addLine(to: p(270, 710))
        path.addLine(to: p(730, 710))
        return path
    }
}

struct MarkTile: View {
    var size: CGFloat = 34
    // Moving the dashes makes the road drive.
    var dashPhase: CGFloat = 0

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.22, style: .continuous).fill(Theme.gradient)
            ZRoad().stroke(Theme.onAccent, style: StrokeStyle(lineWidth: size * 0.15, lineCap: .round, lineJoin: .round))
            ZRoad().stroke(Theme.roadDash, style: StrokeStyle(lineWidth: size * 0.016, lineCap: .round, dash: [size * 0.046, size * 0.052], dashPhase: dashPhase))
        }
        .frame(width: size, height: size)
    }
}

struct Logo: View {
    var size: CGFloat = 30

    var body: some View {
        HStack(spacing: size * 0.3) {
            MarkTile(size: size * 1.15)
            Text("Drivezzz")
                .font(.system(size: size * 0.82, weight: .bold))
                .kerning(-size * 0.02)
                .foregroundStyle(Theme.ink)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Drivezzz")
    }
}

// A shadow drawn once and stretched, like a nine-patch. `.shadow` on a card has the GPU blur the card and everything on it again
// for every frame that moves, twice over: a page of them is what made sheets stutter on a real phone.
enum ShadowPlate {
    struct Layer: Hashable {
        var opacity: Double
        var radius: CGFloat
        var y: CGFloat
    }

    static let margin: CGFloat = 64
    private static var cache: [[AnyHashable]: UIImage] = [:]

    static func image(cornerRadius: CGFloat, layers: [Layer]) -> UIImage {
        let key: [AnyHashable] = [cornerRadius] + layers.map(AnyHashable.init)
        if let image = cache[key] { return image }
        let side = (margin + cornerRadius) * 2 + 2
        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        format.opaque = false
        let body = CGRect(x: margin, y: margin, width: side - margin * 2, height: side - margin * 2)
        let image = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { context in
            // The shape itself is off the canvas: only what it casts lands here.
            let away = side * 2
            let shape = UIBezierPath(roundedRect: body.offsetBy(dx: -away, dy: 0), cornerRadius: cornerRadius).cgPath
            for layer in layers {
                context.cgContext.saveGState()
                // Quartz's shadow isn't SwiftUI's: measured side by side on screen, these match `.shadow` to within 3 shades in 255.
                let wide = layer.radius > 6
                context.cgContext.setShadow(offset: CGSize(width: away, height: layer.y), blur: layer.radius * (wide ? 2.4 : 2),
                                            color: UIColor.black.withAlphaComponent(layer.opacity * (wide ? 1.8 : 1)).cgColor)
                context.cgContext.addPath(shape)
                context.cgContext.fillPath()
                context.cgContext.restoreGState()
            }
        }
        cache[key] = image
        return image
    }
}

private struct ShadowPlateView: View {
    var cornerRadius: CGFloat
    var layers: [ShadowPlate.Layer]

    var body: some View {
        let cap = ShadowPlate.margin + cornerRadius
        Image(uiImage: ShadowPlate.image(cornerRadius: cornerRadius, layers: layers))
            .resizable(capInsets: EdgeInsets(top: cap, leading: cap, bottom: cap, trailing: cap), resizingMode: .stretch)
            .padding(-ShadowPlate.margin)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

extension View {
    // Two shadows: a tight one for the edge, a wide one for the lift. `radius` is the corners' of what's lifted: half its height for a capsule.
    func lifted(_ strength: Double = 1, radius: CGFloat) -> some View {
        background(ShadowPlateView(cornerRadius: radius, layers: [
            .init(opacity: 0.05 * strength, radius: 2, y: 1),
            .init(opacity: 0.11 * strength, radius: 20, y: 8),
        ]))
    }

    func shadowPlate(radius: CGFloat, opacity: Double, blur: CGFloat, y: CGFloat) -> some View {
        background(ShadowPlateView(cornerRadius: radius, layers: [.init(opacity: opacity, radius: blur, y: y)]))
    }

func card(radius: CGFloat = Theme.radius, padding: CGFloat = 16) -> some View {
        self
            .padding(padding)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .lifted(0.6, radius: radius)
    }

    func floating(radius: CGFloat = Theme.radius) -> some View {
        self
            .background(Theme.card, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .lifted(radius: radius)
    }
}
