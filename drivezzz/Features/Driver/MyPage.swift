import PhotosUI
import SwiftUI

// A driver's own page: their vehicles (cars, motors, scooters), each with its own prices. The active one is what riders see and pay for.
struct MyPageView: View {
    @Environment(AppState.self) private var app
    @State private var bio = ""
    @State private var bioSaved = true
    @State private var error: String?
    @State private var showAddCar = false
    @State private var showPreview = false
    @State private var allowsPlanning = false
    @State private var planDays = 7

    private var driver: OwnDriver? { app.driver }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    header
                    vehicles
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger).padding(.horizontal, 4) }
                    planning
                    about
                }
                .padding(16)
            }
            .background(Theme.page)
            .navigationTitle("My page")
            .foregroundStyle(Theme.ink)
            .scrollDismissesKeyboard(.interactively)
            .sheet(isPresented: $showAddCar) { AddCarView() }
            .sheet(isPresented: $showPreview) {
                if let id = app.user?.id { NavigationStack { DriverProfileView(driverId: id) } }
            }
            .task {
                await app.loadDriver()
                bio = driver?.bio ?? ""
                allowsPlanning = driver?.allowsPlanning == true
                planDays = driver?.planDays ?? 7
            }
        }
    }

    // Who you are to riders: your name, rating and how often you're on time.
    private var header: some View {
        VStack(spacing: 16) {
            HStack(spacing: 14) {
                Text(String(app.user?.name.first ?? "D").uppercased())
                    .font(.title.weight(.bold))
                    .foregroundStyle(Theme.onAccent)
                    .frame(width: 62, height: 62)
                    .background(Theme.gradient, in: Circle())
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(app.user?.name ?? String(localized: "Driver")).font(.title2.weight(.bold)).lineLimit(1)
                        if app.driver?.verified == true { VerifiedMark(size: 20) }
                    }
                    HStack(spacing: 6) {
                        Stars(rating: Int((driver?.rating ?? 0).rounded()), size: 12)
                        Text(Fmt.rating(driver?.rating, driver?.ratingCount)).font(.footnote).foregroundStyle(Theme.muted)
                    }
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 10) {
                Stat(value: driver?.arrivalScore.map { "\($0)%" } ?? "–", label: String(localized: "On time"))
                Stat(value: driver?.completedPercent.map { "\($0)%" } ?? "–", label: String(localized: "Completed"))
                Stat(value: driver?.allowsPlanning == true ? String(localized: "\(driver?.planDays ?? 7) d") : String(localized: "Off"), label: String(localized: "Planning"))
            }
            Button { showPreview = true } label: {
                Label("See what riders see", systemImage: "eye").frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle(height: 44, color: Theme.accentSoft, textColor: Theme.accentInk))
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
    }

    private var vehicles: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text("My vehicles").font(.title3.weight(.bold))
                Spacer()
                Button { showAddCar = true } label: { Label("Add", systemImage: "plus").font(.subheadline.weight(.semibold)) }
                    .foregroundStyle(Theme.accentInk)
            }
            .padding(.horizontal, 4)
            if (driver?.cars ?? []).isEmpty {
                Button { showAddCar = true } label: {
                    VStack(spacing: 8) {
                        Image(systemName: "plus.circle.fill").font(.largeTitle).foregroundStyle(Theme.accentInk)
                        Text("Add a car, motor or scooter").font(.headline)
                        Text("Fill in the number plate and we look up the rest.").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 26)
                    .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .lifted(0.45, radius: 22)
                }
                .buttonStyle(.plain)
            }
            ForEach(driver?.cars ?? []) { car in carRow(car) }
            if (driver?.cars?.count ?? 0) > 1 {
                Text("Riders see your active vehicle and pay its prices.").font(.footnote).foregroundStyle(Theme.faint).padding(.horizontal, 4)
            }
        }
    }

    private func carRow(_ car: Car) -> some View {
        let active = driver?.activeCarId == car.id
        return NavigationLink { VehiclePage(carId: car.id) } label: {
            HStack(spacing: 14) {
                VehicleThumb(car: car)
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        Text(car.title).font(.headline).lineLimit(1)
                        if active { StatusPill(text: String(localized: "Active"), color: Theme.ok, background: Theme.okSoft) }
                    }
                    Text(car.shownPlate).font(.footnote.monospaced().weight(.semibold)).foregroundStyle(Theme.muted)
                    Text("\(Fmt.rate(car.perKmCents))/km · \(Fmt.rate(car.perMinCents))/min").font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentInk)
                    if car.photosMissing?.isEmpty == false { StatusPill(text: String(localized: "Photos needed"), color: Theme.warn, background: Theme.warnSoft) }
                    if let hold = car.hold {
                        if hold.plate { StatusPill(text: String(localized: "Plate under review"), color: Theme.accentInk, background: Theme.accentSoft) } else { StatusPill(text: String(localized: "Not cleared"), color: Theme.warn, background: Theme.warnSoft) }
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.faint)
            }
            .padding(12)
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(active ? Theme.accent : .clear, lineWidth: 2))
            .lifted(0.45, radius: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if !active { Button("Drive with this one", systemImage: "checkmark.circle") { Task { await activate(car) } } }
        }
    }

    private var planning: some View {
        VStack(alignment: .leading, spacing: 12) {
            Toggle(isOn: $allowsPlanning) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Planned rides").font(.headline)
                    Text(allowsPlanning ? String(localized: "Riders can book you for later. You can pass a drive on if you can’t make it.") : String(localized: "Riders can only book you for right now."))
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
            }
            .tint(Theme.accent)
            .onChange(of: allowsPlanning) { _, _ in Task { await savePlanning() } }
            if allowsPlanning {
                Divider()
                Stepper(planDays == 1 ? String(localized: "Up to 1 day ahead") : String(localized: "Up to \(planDays) days ahead"), value: $planDays, in: 1...(driver?.maxPlanDays ?? 7))
                    .font(.subheadline)
                    .onChange(of: planDays) { _, _ in Task { await savePlanning() } }
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
    }

    private var about: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("About you").font(.headline)
            TextField("A little about you (optional)", text: $bio, axis: .vertical)
                .lineLimit(2...4)
                .padding(12)
                .background(Theme.soft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .onChange(of: bio) { _, value in bioSaved = value == (driver?.bio ?? "") }
            if !bioSaved {
                Button("Save") { Task { await saveBio() } }.buttonStyle(PrimaryButtonStyle(height: 44))
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
    }

    private func saveBio() async {
        do {
            let r: OwnDriverResponse = try await APIClient.shared.send("PATCH", "/api/driver", ["bio": bio])
            app.driver = r.driver
            bioSaved = true
            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        } catch { self.error = error.localizedDescription }
    }

    private func savePlanning() async {
        guard allowsPlanning != driver?.allowsPlanning || planDays != driver?.planDays else { return }
        do {
            let r: OwnDriverResponse = try await APIClient.shared.send("PATCH", "/api/driver", ["allowsPlanning": allowsPlanning, "planDays": planDays])
            app.driver = r.driver
        } catch { self.error = error.localizedDescription }
    }

    private func activate(_ car: Car) async {
        error = nil
        do {
            let r: OwnDriverResponse = try await APIClient.shared.post("/api/cars/\(car.id)/activate")
            app.driver = r.driver
        } catch { self.error = error.localizedDescription }
    }
}

private let carBodies = ["hatchback", "sedan", "estate", "suv", "mpv", "van"]
private let carColours = [("Black", "#1C1C1E"), ("White", "#F4F4F2"), ("Grey", "#8A8D91"), ("Silver", "#B8BBBF"), ("Blue", "#1F4E9E"), ("Red", "#B3202A"), ("Green", "#2C6B47"), ("Yellow", "#E6B422"), ("Orange", "#D9711C"), ("Brown", "#6B4A32"), ("Beige", "#C8B898"), ("Purple", "#5C3A82"), ("Pink", "#D98BA6"), ("Cream", "#E8E0C8")]
private func bodyName(_ body: String) -> String { Fmt.carBody(body) ?? body }
private func euros(_ cents: Int?) -> String { Lang.number(String(format: "%.2f", Double(cents ?? 0) / 100)) }
private func cents(_ text: String) -> Int? {
    Double(text.replacingOccurrences(of: ",", with: ".")).map { Int(($0 * 100).rounded()) }
}

// A price in euros, on one row.
private struct PriceRow: View {
    var label: String
    @Binding var value: String

    var body: some View {
        LabeledContent(label) {
            HStack(spacing: 4) {
                Text("€").foregroundStyle(Theme.faint)
                TextField("0.00", text: $value)
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    .frame(width: 64)
            }
        }
    }
}

// What a car is, and what it costs: the same fields for adding and for editing.
private struct CarDetailsSection: View {
    var kind: String
    @Binding var make: String
    @Binding var model: String
    @Binding var seats: Int
    @Binding var body_: String
    @Binding var colorName: String

    var body: some View {
        Section(kind == "car" ? String(localized: "The car") : String(localized: "The \(kind)")) {
            TextField("Make", text: $make)
            TextField("Model", text: $model)
            if kind == "car" {
                Stepper(seats == 1 ? String(localized: "1 passenger") : String(localized: "\(seats) passengers"), value: $seats, in: 1...16)
                Picker("Body", selection: $body_) {
                    ForEach(carBodies, id: \.self) { Text(bodyName($0)) }
                }
            } else {
                LabeledContent("Passengers", value: "1")
            }
            Picker("Colour", selection: $colorName) {
                ForEach(carColours, id: \.0) { Text(Fmt.colour($0.0)) }
            }
        }
    }
}

private struct CarPricesSection: View {
    @Binding var perKm: String
    @Binding var perMin: String
    @Binding var pickup: String
    @Binding var pets: Bool

    var body: some View {
        Section {
            PriceRow(label: String(localized: "Per km"), value: $perKm)
            PriceRow(label: String(localized: "Per minute"), value: $perMin)
            PriceRow(label: String(localized: "To the pickup, per km"), value: $pickup)
            Toggle("Pets allowed", isOn: $pets).tint(Theme.accent)
        } header: {
            Text("Prices for this vehicle")
        } footer: {
            Text("An open market: riders see the cheapest first. Your way to the pickup counts in the price.")
        }
    }
}

struct AddCarView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var kind = "car"
    @State private var plate = ""
    @State private var found: PlateCar?
    @State private var looked = false
    @State private var make = ""
    @State private var model = ""
    @State private var seats = 4
    @State private var body_ = "hatchback"
    @State private var colorName = "Grey"
    @State private var perKm = ""
    @State private var perMin = ""
    @State private var pickup = ""
    @State private var pets = false
    @State private var working = false
    @State private var error: String?

    private var hex: String { carColours.first { $0.0 == colorName }?.1 ?? "#8A8D91" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("Vehicle", selection: $kind) {
                        ForEach(Vehicle.all, id: \.self) { Text(Vehicle.name($0)).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .listRowInsets(EdgeInsets(top: 10, leading: 16, bottom: 10, trailing: 16))
                    .onChange(of: kind) { _, new in seats = new == "car" ? max(seats, 4) : 1 }
                    HStack {
                        TextField("Number plate", text: $plate)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .font(.body.monospaced())
                            .submitLabel(.search)
                            .onSubmit { Task { await lookup() } }
                        Button("Look up") { Task { await lookup() } }
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(Theme.accentInk)
                            .disabled(working || plate.count < 4)
                    }
                } footer: {
                    if !looked { Text("Dutch plates are looked up in the RDW register. We make pictures of your vehicle from that.") }
                    else if found != nil { Label("Found in the register", systemImage: "checkmark.seal").labelStyle(.titleAndIcon).foregroundStyle(Theme.ok) }
                    else { Text("Not in the Dutch register. Fill it in yourself.") }
                }
                if looked {
                    CarDetailsSection(kind: kind, make: $make, model: $model, seats: $seats, body_: $body_, colorName: $colorName)
                    CarPricesSection(perKm: $perKm, perMin: $perMin, pickup: $pickup, pets: $pets)
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(Theme.danger) } }
                if looked {
                    Section {
                        Button { Task { await save() } } label: {
                            if working { ProgressView().tint(Theme.onAccent) } else { Text("Add \(Vehicle.name(kind).lowercased())") }
                        }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(working)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                    }
                }
            }
            .navigationTitle("Add a vehicle")
            .navigationBarTitleDisplayMode(.inline)
            .foregroundStyle(Theme.ink)
            .scrollDismissesKeyboard(.interactively)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            .onAppear {
                // A new car starts with the prices of the car in use.
                let d = app.driver
                perKm = euros(d?.perKmCents)
                perMin = euros(d?.perMinCents)
                pickup = euros(d?.pickupPerKmCents)
                pets = d?.petsAllowed == true
            }
        }
    }

    private func lookup() async {
        guard plate.count >= 4 else { return }
        working = true
        error = nil
        defer { working = false }
        let clean = plate.uppercased().filter { $0.isLetter || $0.isNumber }
        do {
            let r: PlateLookup = try await APIClient.shared.get("/api/plates/\(clean)")
            found = r.found == true ? r.car : nil
            if let c = found {
                kind = c.vehicle ?? kind
                make = c.make ?? make
                model = c.model ?? model
                seats = c.seats ?? seats
                body_ = c.body ?? body_
                colorName = c.colorName ?? colorName
            }
            looked = true
        } catch { self.error = error.localizedDescription }
    }

    private func save() async {
        working = true
        error = nil
        defer { working = false }
        guard let km = cents(perKm), let min = cents(perMin), let pick = cents(pickup) else {
            error = String(localized: "Fill in your prices as amounts, like 0.90.")
            return
        }
        do {
            let r: OwnDriverResponse = try await APIClient.shared.post("/api/cars", [
                "vehicle": kind, "plate": plate, "make": make, "model": model, "seats": seats, "body": body_, "colorName": colorName, "colorHex": hex,
                "perKmCents": km, "perMinCents": min, "pickupPerKmCents": pick, "petsAllowed": pets,
            ])
            app.driver = r.driver
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct EditCarView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State var car: Car
    @State private var make = ""
    @State private var model = ""
    @State private var seats = 4
    @State private var body_ = "hatchback"
    @State private var colorName = "Grey"
    @State private var perKm = ""
    @State private var perMin = ""
    @State private var pickup = ""
    @State private var pets = false
    @State private var pick: PhotosPickerItem?
    @State private var pickFront: PhotosPickerItem?
    @State private var pickBack: PhotosPickerItem?
    @State private var pickInside: PhotosPickerItem?
    @State private var working = false
    @State private var error: String?
    @State private var confirmDelete = false

    private var hex: String { carColours.first { $0.0 == colorName }?.1 ?? car.colorHex ?? "#8A8D91" }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    CarGallery(car: car, height: 170)
                        .listRowInsets(EdgeInsets(top: 12, leading: 12, bottom: 10, trailing: 12))
                    LabeledContent("Number plate") { PlateView(plate: car.shownPlate, size: 15) }
                }
                CarPricesSection(perKm: $perKm, perMin: $perMin, pickup: $pickup, pets: $pets)
                CarDetailsSection(kind: car.kind, make: $make, model: $model, seats: $seats, body_: $body_, colorName: $colorName)
                Section {
                    photoSlot(String(localized: "Front of the \(Vehicle.name(car.kind).lowercased())"), kind: "front", selection: $pickFront)
                    photoSlot(String(localized: "Back of the \(Vehicle.name(car.kind).lowercased())"), kind: "back", selection: $pickBack)
                    if car.kind == "car" { photoSlot(String(localized: "Inside the car"), kind: "inside", selection: $pickInside) }
                    PhotosPicker(selection: $pick, matching: .images) { Label("Add another photo", systemImage: "camera").foregroundStyle(Theme.accentInk) }
                    ForEach((car.photos ?? []).filter { !["front", "back", "inside"].contains($0.kind ?? "") }) { photo in
                        HStack {
                            RemotePhoto(url: photo.url.flatMap { APIClient.shared.imageURL($0) })
                                .frame(width: 64, height: 44)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                            Text("Other").font(.subheadline).foregroundStyle(Theme.muted)
                            Spacer()
                            Button("Remove", role: .destructive) { Task { await remove(photo) } }
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(Theme.danger)
                                .buttonStyle(.plain)
                        }
                    }
                } header: {
                    Text("Photos")
                } footer: {
                    Text("Riders see these. The front, the back\(car.kind == "car" ? String(localized: " and the inside") : "") are needed before you can go online.")
                }
                if let error { Section { Text(error).font(.footnote).foregroundStyle(Theme.danger) } }
                Section {
                    Button(role: .destructive) { confirmDelete = true } label: {
                        Label("Delete \(Vehicle.name(car.kind).lowercased())", systemImage: "trash").labelStyle(.automatic).foregroundStyle(Theme.danger)
                    }
                }
            }
            .navigationTitle(car.title)
            .navigationBarTitleDisplayMode(.inline)
            .foregroundStyle(Theme.ink)
            .scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await save() } }.disabled(working) }
            }
            .onAppear {
                make = car.make ?? ""
                model = car.model ?? ""
                seats = car.seats ?? 4
                body_ = car.body ?? "hatchback"
                colorName = car.colorName ?? "Grey"
                perKm = euros(car.perKmCents)
                perMin = euros(car.perMinCents)
                pickup = euros(car.pickupPerKmCents)
                pets = car.petsAllowed == true
            }
            .onChange(of: pick) { _, item in if let item { Task { await upload(item, kind: "outside"); pick = nil } } }
            .onChange(of: pickFront) { _, item in if let item { Task { await upload(item, kind: "front"); pickFront = nil } } }
            .onChange(of: pickBack) { _, item in if let item { Task { await upload(item, kind: "back"); pickBack = nil } } }
            .onChange(of: pickInside) { _, item in if let item { Task { await upload(item, kind: "inside"); pickInside = nil } } }
            .confirmationDialog("Delete this \(Vehicle.name(car.kind).lowercased())?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { Task { await delete() } }
            }
        }
    }

    private func save() async {
        working = true
        error = nil
        defer { working = false }
        guard let km = cents(perKm), let min = cents(perMin), let pick = cents(pickup) else {
            error = String(localized: "Fill in your prices as amounts, like 0.90.")
            return
        }
        do {
            let r: OwnDriverResponse = try await APIClient.shared.send("PATCH", "/api/cars/\(car.id)", [
                "make": make, "model": model, "seats": seats, "body": body_, "colorName": colorName, "colorHex": hex,
                "perKmCents": km, "perMinCents": min, "pickupPerKmCents": pick, "petsAllowed": pets,
            ])
            app.driver = r.driver
            dismiss()
        } catch { self.error = error.localizedDescription }
    }

    // One of the required photos: tap to add it, or to replace it.
    private func photoSlot(_ title: String, kind: String, selection: Binding<PhotosPickerItem?>) -> some View {
        let photo = car.photos?.first { $0.kind == kind }
        return PhotosPicker(selection: selection, matching: .images) {
            HStack {
                Group {
                    if let photo {
                        RemotePhoto(url: photo.url.flatMap { APIClient.shared.imageURL($0) })
                    } else {
                        Image(systemName: "camera").foregroundStyle(Theme.accentInk).frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.accentSoft)
                    }
                }
                .frame(width: 64, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.subheadline).foregroundStyle(Theme.ink)
                    Text(photo == nil ? String(localized: "Tap to add") : String(localized: "Tap to replace")).font(.caption).foregroundStyle(Theme.faint)
                }
                Spacer()
                if photo == nil {
                    StatusPill(text: String(localized: "Needed"), color: Theme.warn, background: Theme.warnSoft)
                } else {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.ok)
                }
            }
        }
    }

    private func upload(_ item: PhotosPickerItem, kind: String) async {
        working = true
        error = nil
        defer { working = false }
        do {
            guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data), let jpeg = shrink(image) else {
                error = String(localized: "That photo can’t be used.")
                return
            }
            // A car's back: what's on it goes along, for the plate (checks.js). The photo counts, not the plate someone typed in.
            var path = "/api/cars/\(car.id)/photos?kind=\(kind)"
            var headers: [String: String] = [:]
            var plateRead = true
            if kind == "back", car.kind == "car" {
                let read = String(await DocumentReader.lines(in: image).joined(separator: "\n").prefix(1000))
                var q = URLComponents()
                q.queryItems = [URLQueryItem(name: "read", value: read)]
                path += "&" + (q.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
                headers = await AppAttest.headers(signing: ["drivezzz-plate-1", car.id, AppAttest.hash(Data(read.utf8))], photo: jpeg, userId: app.user?.id)
                plateRead = Self.letters(read).contains(Self.letters(car.plate))
            }
            let r: OwnDriverResponse = try await APIClient.shared.upload(path, jpeg: jpeg, headers: headers)
            app.driver = r.driver
            if let c = r.car { car = c }
            if !plateRead { error = String(localized: "The plate can’t be read in this photo. In the Netherlands a person then has to check it, so take one with the plate clearly in view.") }
        } catch { self.error = error.localizedDescription }
    }

    private static func letters(_ s: String) -> String { s.uppercased().filter { $0.isLetter || $0.isNumber } }

    private func shrink(_ image: UIImage) -> Data? {
        let side: CGFloat = 1400
        let scale = min(1, side / max(image.size.width, image.size.height))
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }.jpegData(compressionQuality: 0.78)
    }

    private func remove(_ photo: CarPhoto) async {
        do {
            let r: OwnDriverResponse = try await APIClient.shared.send("DELETE", "/api/car-photos/\(photo.id)")
            app.driver = r.driver
            car = r.driver?.cars?.first { $0.id == car.id } ?? car
        } catch { self.error = error.localizedDescription }
    }

    private func delete() async {
        do {
            let r: OwnDriverResponse = try await APIClient.shared.send("DELETE", "/api/cars/\(car.id)")
            app.driver = r.driver
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

private struct Stat: View {
    var value: String
    var label: String

    var body: some View {
        VStack(spacing: 2) {
            Text(value).font(.headline.monospacedDigit())
            Text(label).font(.caption).foregroundStyle(Theme.faint)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 10)
        .background(Theme.soft, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}
