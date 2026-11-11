import SwiftUI

// The generated pictures of a car: drawn from what its number plate says in the register (body, colour, plate).
// Shown when a driver has no photos, or next to them.
struct CarArt: View {
    enum Angle: CaseIterable { case side, front, rear, inside }

    // A motor or scooter has no inside, and its picture is simpler.
    static func angles(for car: Car) -> [Angle] { car.kind == "car" ? Angle.allCases : [.side, .rear] }

    var car: Car
    var angle: Angle = .side

    private var paint: Color { Color(hexString: car.colorHex) ?? Color(hex: 0xB8BBBF) }
    private var isLight: Bool {
        guard let hex = car.colorHex?.uppercased() else { return true }
        return ["#F4F4F2", "#E8E0C8", "#C8B898", "#B8BBBF", "#E6B422"].contains(hex)
    }
    private var body_: String { car.body ?? "hatchback" }

    var body: some View {
        GeometryReader { geo in
            ZStack {
                Theme.accentSoft
                Ellipse()
                    .fill(Theme.ink.opacity(0.08))
                    .frame(width: geo.size.width * 0.8, height: geo.size.height * 0.1)
                    .position(x: geo.size.width / 2, y: geo.size.height * 0.84)
                if car.kind != "car" {
                    twoWheeler(geo.size)
                } else {
                switch angle {
                case .side: side(geo.size)
                case .front: faceOn(geo.size, front: true)
                case .rear: faceOn(geo.size, front: false)
                case .inside: inside(geo.size)
                }
                }
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .accessibilityLabel("Generated picture of a \(car.colorName ?? "") \(car.title)")
    }

    private func twoWheeler(_ size: CGSize) -> some View {
        VStack(spacing: size.height * 0.05) {
            Image(systemName: Vehicle.icon(car.kind))
                .resizable()
                .scaledToFit()
                .foregroundStyle(paintOrGrey)
                .frame(height: size.height * (angle == .rear ? 0.42 : 0.6))
            if angle == .rear { PlateView(plate: car.shownPlate, size: min(size.width * 0.05, size.height * 0.1)) }
        }
    }

    private var paintOrGrey: Color { isVeryLight ? Theme.faint : paint }
    private var isVeryLight: Bool { ["#F4F4F2", "#E8E0C8"].contains(car.colorHex?.uppercased() ?? "") }

    // Roof and bonnet heights for each body, as shares of the picture.
    private var shape: (roofStart: CGFloat, roofEnd: CGFloat, roof: CGFloat, belly: CGFloat, tail: CGFloat, nose: CGFloat) {
        switch body_ {
        case "sedan": (0.34, 0.62, 0.30, 0.74, 0.46, 0.52)
        case "estate": (0.34, 0.82, 0.30, 0.74, 0.40, 0.52)
        case "suv": (0.32, 0.82, 0.22, 0.72, 0.34, 0.46)
        case "mpv": (0.26, 0.86, 0.22, 0.74, 0.34, 0.50)
        case "van": (0.22, 0.92, 0.18, 0.74, 0.20, 0.46)
        default: (0.34, 0.76, 0.28, 0.74, 0.38, 0.52)
        }
    }

    private func side(_ size: CGSize) -> some View {
        let w = size.width, h = size.height, s = shape
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * w, y: y * h) }
        let bodyPath = Path { path in
            path.move(to: p(0.06, s.belly))
            path.addLine(to: p(0.06, s.nose + 0.06))
            path.addQuadCurve(to: p(0.10, s.nose), control: p(0.06, s.nose))
            path.addLine(to: p(s.roofStart - 0.10, s.nose - 0.06))
            path.addQuadCurve(to: p(s.roofStart, s.roof), control: p(s.roofStart - 0.04, s.roof + 0.06))
            path.addLine(to: p(s.roofEnd, s.roof))
            path.addQuadCurve(to: p(0.94, s.tail), control: p(0.92, s.roof))
            path.addLine(to: p(0.94, s.belly))
            path.closeSubpath()
        }
        let window = Path { path in
            path.move(to: p(s.roofStart + 0.012, s.roof + 0.035))
            path.addLine(to: p(s.roofEnd - 0.01, s.roof + 0.035))
            path.addQuadCurve(to: p(min(0.90, s.roofEnd + 0.09), s.tail + 0.01), control: p(s.roofEnd + 0.07, s.roof + 0.04))
            path.addLine(to: p(s.roofStart - 0.075, s.tail + 0.01))
            path.closeSubpath()
        }
        let pillar = Path { path in
            let x = (s.roofStart + s.roofEnd) / 2
            path.move(to: p(x, s.roof + 0.03))
            path.addLine(to: p(x, s.tail + 0.01))
        }
        return ZStack {
            bodyPath.fill(LinearGradient(colors: [paint.opacity(0.92), paint], startPoint: .top, endPoint: .bottom))
            bodyPath.stroke(Theme.ink.opacity(0.18), lineWidth: 1)
            window.fill(Color(hex: 0x1A2B44).opacity(0.85))
            pillar.stroke(paint, lineWidth: max(2, w * 0.012))
            // Door line, handle, lights.
            Path { path in
                let x = (s.roofStart + s.roofEnd) / 2
                path.move(to: p(x, s.tail + 0.02))
                path.addLine(to: p(x, s.belly - 0.02))
            }
            .stroke(Theme.ink.opacity(0.18), lineWidth: 1)
            Capsule().fill(Color(hex: 0xFFF3B0)).frame(width: w * 0.045, height: h * 0.035).position(p(0.085, s.nose + 0.05))
            Capsule().fill(Color(hex: 0xD92D20)).frame(width: w * 0.03, height: h * 0.05).position(p(0.925, s.tail + 0.07))
            wheel(w, h).position(p(0.24, s.belly))
            wheel(w, h).position(p(0.76, s.belly))
        }
    }

    private func wheel(_ w: CGFloat, _ h: CGFloat) -> some View {
        let d = min(w * 0.17, h * 0.3)
        return ZStack {
            Circle().fill(Color(hex: 0x14171C))
            Circle().fill(Color(hex: 0xC7CCD4)).frame(width: d * 0.55, height: d * 0.55)
            Circle().fill(Color(hex: 0x6A7280)).frame(width: d * 0.16, height: d * 0.16)
        }
        .frame(width: d, height: d)
    }

    private func faceOn(_ size: CGSize, front: Bool) -> some View {
        let w = size.width, h = size.height
        let tall: CGFloat = ["suv", "mpv", "van"].contains(body_) ? 0.18 : 0.26
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * w, y: y * h) }
        let cabin = Path { path in
            path.move(to: p(0.27, 0.52))
            path.addLine(to: p(0.33, tall))
            path.addQuadCurve(to: p(0.67, tall), control: p(0.5, tall - 0.04))
            path.addLine(to: p(0.73, 0.52))
            path.closeSubpath()
        }
        let lower = Path(roundedRect: CGRect(x: 0.18 * w, y: 0.49 * h, width: 0.64 * w, height: 0.3 * h), cornerRadius: h * 0.05)
        let glass = Path { path in
            path.move(to: p(0.31, 0.5))
            path.addLine(to: p(0.355, tall + 0.04))
            path.addQuadCurve(to: p(0.645, tall + 0.04), control: p(0.5, tall))
            path.addLine(to: p(0.69, 0.5))
            path.closeSubpath()
        }
        return ZStack {
            RoundedRectangle(cornerRadius: 3).fill(Color(hex: 0x14171C)).frame(width: w * 0.09, height: h * 0.1).position(p(0.25, 0.83))
            RoundedRectangle(cornerRadius: 3).fill(Color(hex: 0x14171C)).frame(width: w * 0.09, height: h * 0.1).position(p(0.75, 0.83))
            cabin.fill(paint)
            cabin.stroke(Theme.ink.opacity(0.18), lineWidth: 1)
            lower.fill(paint)
            lower.stroke(Theme.ink.opacity(0.18), lineWidth: 1)
            glass.fill(Color(hex: 0x1A2B44).opacity(0.85))
            if front {
                Capsule().fill(Color(hex: 0xFFF3B0)).frame(width: w * 0.12, height: h * 0.055).position(p(0.28, 0.57))
                Capsule().fill(Color(hex: 0xFFF3B0)).frame(width: w * 0.12, height: h * 0.055).position(p(0.72, 0.57))
                RoundedRectangle(cornerRadius: 4).fill(Color(hex: 0x14171C).opacity(0.75)).frame(width: w * 0.26, height: h * 0.06).position(p(0.5, 0.58))
            } else {
                Capsule().fill(Color(hex: 0xD92D20)).frame(width: w * 0.13, height: h * 0.055).position(p(0.28, 0.57))
                Capsule().fill(Color(hex: 0xD92D20)).frame(width: w * 0.13, height: h * 0.055).position(p(0.72, 0.57))
            }
            PlateView(plate: car.shownPlate, size: min(w * 0.042, h * 0.07)).position(p(0.5, 0.69))
        }
    }

    private func inside(_ size: CGSize) -> some View {
        let w = size.width, h = size.height
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * w, y: y * h) }
        return ZStack {
            Color(hex: 0x1F2A3C)
            // Windscreen with the sky.
            Path { path in
                path.move(to: p(0.08, 0.5))
                path.addLine(to: p(0.16, 0.08))
                path.addLine(to: p(0.84, 0.08))
                path.addLine(to: p(0.92, 0.5))
                path.closeSubpath()
            }
            .fill(LinearGradient(colors: [Color(hex: 0xBFDAFF), Color(hex: 0xEAF1FF)], startPoint: .top, endPoint: .bottom))
            // Dashboard.
            Path(roundedRect: CGRect(x: 0, y: 0.48 * h, width: w, height: 0.2 * h), cornerRadius: 6).fill(Color(hex: 0x2E3A4F))
            RoundedRectangle(cornerRadius: 4).fill(Color(hex: 0x0B1B33)).frame(width: w * 0.16, height: h * 0.1).position(p(0.5, 0.57))
            // Wheel.
            Circle().stroke(Color(hex: 0x0E1420), lineWidth: max(3, h * 0.03)).frame(width: h * 0.34, height: h * 0.34).position(p(0.72, 0.66))
            Rectangle().fill(Color(hex: 0x0E1420)).frame(width: h * 0.3, height: max(2, h * 0.02)).position(p(0.72, 0.66))
            // Seats, in the car's colour.
            RoundedRectangle(cornerRadius: h * 0.05).fill(paint.opacity(0.9)).frame(width: w * 0.2, height: h * 0.28).position(p(0.28, 0.88))
            RoundedRectangle(cornerRadius: h * 0.05).fill(paint.opacity(0.9)).frame(width: w * 0.2, height: h * 0.28).position(p(0.72, 0.92))
        }
    }
}

// A car's photos and generated pictures, swiped through. Tap one to see it big.
struct CarGallery: View {
    var car: Car
    var height: CGFloat = 190
    @State private var page = 0
    @State private var showBig = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TabView(selection: $page) {
                CarPages(car: car, height: height, fit: false)
            }
            .tabViewStyle(.page(indexDisplayMode: .automatic))
            .indexViewStyle(.page(backgroundDisplayMode: .interactive))
            .frame(height: height)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
            .contentShape(Rectangle())
            .onTapGesture { showBig = true }
            .accessibilityAddTraits(.isButton)
            .accessibilityHint("Shows the picture full screen")
            if car.photos?.isEmpty != false {
                Text("Pictures generated from the number plate").font(.caption).foregroundStyle(Theme.faint)
            }
        }
        .fullScreenCover(isPresented: $showBig) { CarPicturesBig(car: car, page: $page) }
    }
}

// The pages of a gallery, numbered for TabView's selection.
private struct CarPages: View {
    var car: Car
    var height: CGFloat?
    var fit: Bool

    var body: some View {
        let photos = car.photos ?? []
        ForEach(Array(photos.enumerated()), id: \.offset) { i, photo in
            RemotePhoto(url: photo.url.flatMap { APIClient.shared.imageURL($0) }, contentMode: fit ? .fit : .fill, placeholder: fit ? .black : Theme.soft)
            .frame(height: height)
            .frame(maxWidth: .infinity)
            .clipped()
            .tag(i)
        }
        // The generated pictures are for a vehicle without photos yet: nobody can drive without them now.
        ForEach(Array((photos.isEmpty ? CarArt.angles(for: car) : []).enumerated()), id: \.offset) { i, angle in
            Group {
                if fit {
                    CarArt(car: car, angle: angle).aspectRatio(1.6, contentMode: .fit).padding(.horizontal, 12)
                } else {
                    CarArt(car: car, angle: angle).frame(height: height)
                }
            }
            .tag(photos.count + i)
        }
    }
}

private struct CarPicturesBig: View {
    @Environment(\.dismiss) private var dismiss
    var car: Car
    @Binding var page: Int

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            TabView(selection: $page) {
                CarPages(car: car, height: nil, fit: true)
            }
            .tabViewStyle(.page(indexDisplayMode: .automatic))
            .ignoresSafeArea(edges: .bottom)
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(.white.opacity(0.18), in: Circle())
            }
            .padding(16)
            .accessibilityLabel("Close")
        }
    }
}
