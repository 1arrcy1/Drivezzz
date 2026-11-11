import SwiftUI

// One of your vehicles, the way riders see it: pictures, prices, your rating and reviews. Edit is top right.
struct VehiclePage: View {
    @Environment(AppState.self) private var app
    var carId: String
    @State private var profile: DriverProfile?
    @State private var editing: Car?
    @State private var working = false
    @State private var error: String?

    private var car: Car? { app.driver?.cars?.first { $0.id == carId } }
    private var active: Bool { app.driver?.activeCarId == carId }

    var body: some View {
        ScrollView {
            if let car {
                VStack(alignment: .leading, spacing: 16) {
                    hero(car)
                    if let hold = car.hold { holdNote(hold, car) }
                    if car.photosMissing?.isEmpty == false {
                        Button { editing = car } label: {
                            NoteBox(symbol: "camera.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "Add photos of the \(ListFormatter.localizedString(byJoining: (car.photosMissing ?? []).map(Fmt.photoSide))) before you can go online with this one."))
                        }
                        .buttonStyle(.plain)
                    }
                    facts(car)
                    prices(car)
                    rating
                    reviews
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
                }
                .padding(16)
            }
        }
        .background(Theme.page)
        .navigationTitle(car?.title ?? String(localized: "Vehicle"))
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
        .toolbar {
            ToolbarItem(placement: .primaryAction) { Button("Edit") { editing = car }.foregroundStyle(Theme.accentInk) }
        }
        .sheet(item: $editing) { EditCarView(car: $0) }
        .safeAreaInset(edge: .bottom) {
            if car != nil, !active {
                Button { Task { await activate() } } label: {
                    if working { ProgressView().tint(Theme.onAccent) } else { Text("Drive with this one") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(.bar)
            }
        }
        .task {
            if let id = app.user?.id { profile = try? await APIClient.shared.get("/api/drivers/\(id)") }
        }
    }

    private func hero(_ car: Car) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            CarGallery(car: car, height: 210)
                .padding(10)
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    Text(car.title).font(.title2.weight(.bold)).lineLimit(1).minimumScaleFactor(0.8)
                    Spacer(minLength: 8)
                    if active { StatusPill(text: String(localized: "Active"), color: Theme.ok, background: Theme.okSoft) }
                }
                HStack(spacing: 10) {
                    PlateView(plate: car.shownPlate, size: 15)
                    if let year = car.year { Text(String(year)).font(.subheadline).foregroundStyle(Theme.muted) }
                    if car.verified == true { Label("Checked", systemImage: "checkmark.circle.fill").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ok) }
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 16)
        }
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
    }

    // What still stops this car in the Netherlands (Pieter, 8 November 2026). Its plate waiting for a person: how long, and what the
    // driver can do meanwhile, as going online says it. Anything else: the RDW's word.
    @ViewBuilder
    private func holdNote(_ hold: CarHold, _ car: Car) -> some View {
        if hold.plate {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    IconTile(symbol: "hourglass", tint: Theme.accentInk, background: Theme.accentSoft)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Number plate under review").font(.subheadline.weight(.bold))
                        Text("\(hold.text ?? String(localized: "A person is checking this car’s number plate.")) You’ll hear when it is. Meanwhile you can drive another vehicle that’s cleared, or take the back photo again.")
                            .font(.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Button("Take the back photo again") { editing = car }.buttonStyle(GhostButtonStyle(height: 42))
            }
            .padding(14)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .lifted(0.45, radius: 22)
        } else if let text = hold.text {
            NoteBox(symbol: "exclamationmark.triangle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "Can’t drive in the Netherlands yet: \(text)"))
        }
    }

    private func facts(_ car: Car) -> some View {
        HStack(spacing: 10) {
            FactTile(symbol: Vehicle.icon(car.kind), title: Vehicle.name(car.kind), note: Fmt.carBody(car.body) ?? Fmt.colour(car.colorName))
            FactTile(symbol: "person.2.fill", title: "\(car.seats ?? 1)", note: (car.seats ?? 1) == 1 ? String(localized: "passenger") : String(localized: "passengers"))
            FactTile(symbol: "pawprint.fill", title: car.petsAllowed == true ? String(localized: "Yes") : String(localized: "No"), note: String(localized: "pets"))
        }
    }

    private func prices(_ car: Car) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Prices").font(.headline)
            HStack(spacing: 0) {
                PriceColumn(price: Fmt.rate(car.perKmCents), unit: String(localized: "per km"))
                Divider().frame(height: 40)
                PriceColumn(price: Fmt.rate(car.perMinCents), unit: String(localized: "per minute"))
                Divider().frame(height: 40)
                PriceColumn(price: Fmt.rate(car.pickupPerKmCents), unit: String(localized: "to pickup, km"))
            }
            if let km = car.perKmCents, let min = car.perMinCents {
                HStack(spacing: 8) {
                    Image(systemName: "sparkles").foregroundStyle(Theme.accentInk)
                    Text("A 10 km ride of 20 minutes: \(Fmt.eur(10 * km + 20 * min)), plus your way to the pickup.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
    }

    private var rating: some View {
        let d = app.driver
        return HStack(spacing: 16) {
            VStack(spacing: 4) {
                Text(d?.rating.map { String(format: "%.1f", $0) } ?? "–").font(.system(size: 38, weight: .bold))
                Stars(rating: Int((d?.rating ?? 0).rounded()), size: 12)
                Text(d?.ratingCount == 1 ? String(localized: "1 review") : String(localized: "\(d?.ratingCount ?? 0) reviews")).font(.caption).foregroundStyle(Theme.faint)
            }
            .frame(width: 104)
            Divider().frame(height: 70)
            VStack(alignment: .leading, spacing: 10) {
                LabeledContent("Rides", value: "\(profile?.driver.ridesDone ?? 0)")
                LabeledContent("Completed", value: d?.completedPercent.map { "\($0)%" } ?? "–")
                LabeledContent("On time at the pickup", value: d?.arrivalScore.map { "\($0)%" } ?? "–")
            }
            .font(.subheadline)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
    }

    private var reviews: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("What riders say").font(.headline).padding(.horizontal, 4)
            let list = (profile?.reviews ?? []).filter { $0.stars != nil }
            if list.isEmpty {
                Text(profile == nil ? String(localized: "Loading…") : String(localized: "No reviews yet. They show here after your first rides."))
                    .font(.subheadline)
                    .foregroundStyle(Theme.muted)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .lifted(0.45, radius: 22)
            }
            ForEach(Array(list.prefix(20).enumerated()), id: \.offset) { _, r in
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

    private func activate() async {
        working = true
        error = nil
        defer { working = false }
        do {
            let r: OwnDriverResponse = try await APIClient.shared.post("/api/cars/\(carId)/activate")
            app.driver = r.driver
        } catch { self.error = error.localizedDescription }
    }
}

struct FactTile: View {
    var symbol: String
    var title: String
    var note: String

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: symbol).font(.title3).foregroundStyle(Theme.accentInk).frame(height: 26)
            Text(title).font(.subheadline.weight(.bold)).lineLimit(1)
            Text(note).font(.caption).foregroundStyle(Theme.faint).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
    }
}

struct PriceColumn: View {
    var price: String
    var unit: String

    var body: some View {
        VStack(spacing: 3) {
            Text(price).font(.title3.weight(.bold).monospacedDigit()).foregroundStyle(Theme.accentInk)
            Text(unit).font(.caption).foregroundStyle(Theme.faint).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity)
    }
}

// A small picture of a vehicle: its first photo, or the drawn one.
struct VehicleThumb: View {
    var car: Car
    var width: CGFloat = 84
    var height: CGFloat = 60

    var body: some View {
        Group {
            if let url = car.photos?.first?.url.flatMap({ APIClient.shared.imageURL($0) }) {
                RemotePhoto(url: url)
            } else {
                CarArt(car: car, angle: CarArt.angles(for: car)[0]).padding(4)
            }
        }
        .frame(width: width, height: height)
        .background(Theme.page)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
