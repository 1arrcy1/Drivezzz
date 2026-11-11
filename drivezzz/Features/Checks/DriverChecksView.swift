import CryptoKit
import PhotosUI
import SwiftUI

// Driving in the Netherlands: what a driver hands in before a car can go online there (server/src/checks.js,
// docs/driver-checks-nl.md). It opens by itself when going online needs it, and from Profile. Four things to hand in, checked
// automatically: approved by itself when everything checks out, and whatever can't be confirmed lands on the admin panel. After
// that the driver is verified, with a blue check, and can go online. A motor or scooter doesn't need it: the taxi law only covers
// cars. Consent isn't one of the four: its page comes up once, before the first of them.
enum ChecksStep: Hashable { case consent, id, chauffeurskaart, permit, kvk }

// Lives next to the tabs, so opening it doesn't redo the map.
struct ChecksSheetHost: View {
    @Environment(AppState.self) private var app

    var body: some View {
        @Bindable var app = app
        Color.clear
            .frame(width: 0, height: 0)
            .sheet(isPresented: $app.checksOpen) { DriverChecksSheet() }
    }
}

struct DriverChecksSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var checks: DriverChecks?
    @State private var path: [ChecksStep] = []
    @State private var error: String?
    @State private var working = false
    @State private var loadFailed: String?
    @State private var afterConsent: ChecksStep?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let loadFailed { failed(loadFailed) } else { status }
                    stillOpen
                    CardGroup(title: String(localized: "What we check"), footer: String(localized: "These are checked automatically. If something can’t be confirmed, a person looks at it once you’ve sent all four. Then you’re verified, with a blue check on your profile, and you can go online as a taxi driver.")) {
                        row(.id, symbol: "person.text.rectangle.fill", title: String(localized: "Your ID and a selfie"), state: idState)
                        CardDivider()
                        row(.chauffeurskaart, symbol: "creditcard.fill", title: String(localized: "Chauffeurskaart"), state: state("chauffeurskaart"))
                        CardDivider()
                        row(.permit, symbol: "doc.text.fill", title: String(localized: "Taxi permit (Kiwa)"), state: state("permit"))
                        CardDivider()
                        row(.kvk, symbol: "building.2.fill", title: String(localized: "KvK number"), state: state("kvk"))
                    }
                    if checks != nil { vehicles }
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
                    Text("Your face is compared on this phone and never sent. We never read your BSN or address. Photos of your documents are deleted 30 days after the decision.")
                        .font(.caption).foregroundStyle(Theme.faint)
                    Link("How we handle your data", destination: URL(string: "https://drivezzz.s3rver.nl/privacy#checks")!)
                        .font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentInk)
                }
                .padding(16)
            }
            .background(Theme.page)
            .foregroundStyle(Theme.ink)
            .navigationTitle("Driving in the Netherlands")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() }.foregroundStyle(Theme.accentInk) } }
            .navigationDestination(for: ChecksStep.self) { step in
                switch step {
                case .consent: ConsentStep { agreed($0) }
                case .id: IDStep { done($0) }
                case .chauffeurskaart: DocumentStep(kind: "chauffeurskaart", known: checks?.chauffeurskaart) { done($0) }
                case .permit: DocumentStep(kind: "permit", known: checks?.permit) { done($0) }
                case .kvk: KvkStep(known: checks?.kvk?.number) { done($0) }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if canDrive {
                    Button { Task { await goOnline() } } label: {
                        if working { ProgressView().tint(Theme.onAccent) } else { Text("Go online") }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(working)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(.bar)
                }
            }
            // Again whenever the sync says the checks changed (a person decided while this was open).
            .task(id: app.driving.checks) { await load() }
        }
    }

    // Nil is still loading: a question that failed mustn't look like one. A photo that couldn't be read is to send again.
    private func state(_ key: String) -> String? {
        if checks?.retake?.contains(key) == true { return "again" }
        return shown(checks?.item(key)) ?? (loadFailed == nil ? nil : "unknown")
    }

    // Something a person has to look at goes to them once everything is in (Pieter: "when everything has been filled"), so until
    // then it's only sent; and once a person approved, it's done.
    private func shown(_ item: String?) -> String? {
        guard item == "waiting" else { return item }
        switch checks?.status {
        case "review": return "waiting"
        case "approved": return "done"
        default: return "sent"
        }
    }

    private func failed(_ why: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            NoteBox(symbol: "exclamationmark.triangle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "Your checks couldn’t be loaded. \(why)"))
            Button("Try again") { Task { await load() } }.buttonStyle(GhostButtonStyle())
        }
    }

    private var idState: String? {
        guard let checks else { return loadFailed == nil ? nil : "unknown" }
        let id = checks.item("id"), face = checks.item("face")
        if id == "expired" { return "expired" }
        if id == "missing" || face == "missing" { return "missing" }
        return shown(id == "waiting" || face == "waiting" ? "waiting" : "done")
    }

    private var activeVehicle: CheckedVehicle? { checks?.vehicles?.first { $0.id == app.driver?.activeCarId } }
    private var canDrive: Bool { checks?.status == "approved" && checks?.verified == true && app.driver?.online != true && (activeVehicle?.ok ?? false || checks?.fake == true) }

    @ViewBuilder private var status: some View {
        switch checks?.status {
        case "approved" where checks?.verified == true:
            NoteBox(symbol: "checkmark.seal.fill", tint: Theme.verified, background: Theme.verifiedSoft, text: String(localized: "You’re verified: you can go online as a taxi driver in the Netherlands. Riders see your blue check."))
        case "approved":
            NoteBox(symbol: "exclamationmark.circle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "Something is missing or has run out. Send it below to keep driving."))
        case "review":
            NoteBox(symbol: "clock.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "A person is checking your documents, usually within a day. You’ll get a notification."))
        case "declined":
            NoteBox(symbol: "xmark.octagon.fill", tint: Theme.danger, background: Theme.dangerSoft, text: String(localized: "Not approved\(checks?.note.map { ": \($0)" } ?? ".") Fix it below and send it again."))
        case "started" where checks?.againWhat != nil:
            // A person asked for one thing again (the panel's "Ask again for…"): not the first-time card.
            NoteBox(symbol: "arrow.clockwise.circle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "A person asked you to send \(checks?.againWhat ?? String(localized: "something")) again\(checks?.note.map { ": \($0)" } ?? ".")"))
        default:
            HeroCard {
                VStack(alignment: .leading, spacing: 8) {
                    Image(systemName: "checkmark.shield.fill").font(.system(size: 30, weight: .semibold))
                    Text("Before you drive a car").font(.title2.weight(.bold))
                    Text("In the Netherlands a taxi needs a licensed driver and a registered car. It takes about 10 minutes: have your passport or ID card, chauffeurskaart, taxi permit and KvK number at hand.")
                        .font(.subheadline).opacity(0.9)
                }
            }
        }
    }

    // Until approved: what waits for review and what to send again, in the server's words, and never why (Pieter, 8 November 2026).
    // Once approved, every row shows done instead.
    @ViewBuilder private var stillOpen: some View {
        if let open = checks?.open, !open.isEmpty, checks?.status != "approved" {
            CardGroup(title: String(localized: "Still open")) {
                ForEach(Array(open.enumerated()), id: \.offset) { i, point in
                    if i > 0 { CardDivider() }
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: "exclamationmark.circle.fill").font(.footnote.weight(.semibold)).foregroundStyle(Theme.warn)
                        Text(point).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(14)
                }
            }
        }
    }

    // Done is done: a check instead of the arrow, and nothing to send over it (Pieter, 8 November 2026). Open again only for what
    // runs out within 30 days (`renew`), and after a decline, when anything may be sent again. What a person asks for again is
    // missing, so it's open anyway.
    private func locked(_ step: ChecksStep, _ state: String?) -> Bool {
        guard state == "done", checks?.status != "declined" else { return false }
        let key = switch step {
        case .id: "id"
        case .chauffeurskaart: "chauffeurskaart"
        case .permit: "permit"
        case .kvk: "kvk"
        case .consent: "consent"
        }
        return !(checks?.renew ?? []).contains(key)
    }

    // Until when a done row is good, for the ones that run out (`renew`).
    private func expiry(_ step: ChecksStep) -> String? {
        switch step {
        case .id: checks?.id?.expires
        case .chauffeurskaart: checks?.chauffeurskaart?.expires
        case .permit: checks?.permit?.expires
        default: nil
        }
    }

    // "Done" always comes with the green check (Pieter, 8 November 2026: two rows said Done without one). A row that runs out within
    // 30 days isn't shown as done: it says until when, in orange, and opens to send the new one.
    private func row(_ step: ChecksStep, symbol: String, title: String, state: String?) -> some View {
        let done = locked(step, state)
        let endsSoon = state == "done" && !done && checks?.status != "declined" ? expiry(step) : nil
        return Button {
            if checks?.item("consent") == "done" { path.append(step) } else { afterConsent = step; path.append(.consent) }
        } label: {
            CardRow(symbol: symbol, title: title, chevron: !done) {
                if let endsSoon {
                    StatusPill(text: String(localized: "Ends \(ChecksDate.showShort(endsSoon))"), color: Theme.warn, background: Theme.warnSoft)
                } else {
                    ChecksPill(state: state)
                    if state == "done" {
                        Image(systemName: "checkmark.circle.fill").font(.body.weight(.semibold)).foregroundStyle(Theme.ok)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .disabled(checks == nil)
        .allowsHitTesting(!done)
    }

    @ViewBuilder private var vehicles: some View {
        let cars = checks?.vehicles ?? []
        CardGroup(title: String(localized: "Your car"), footer: String(localized: "Only a car registered as a taxi at the RDW (blue plates), insured and through its APK can drive in the Netherlands. A motor or scooter doesn’t need any of this.")) {
            if cars.isEmpty {
                Text("Add a car on My page.").font(.subheadline).foregroundStyle(Theme.muted).padding(14)
            }
            ForEach(Array(cars.enumerated()), id: \.element.id) { i, car in
                if i > 0 { CardDivider() }
                HStack(spacing: 12) {
                    IconTile(symbol: "car.fill", tint: car.ok ? Theme.ok : Theme.warn, background: car.ok ? Theme.okSoft : Theme.warnSoft)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(car.plate ?? "").font(.subheadline.weight(.semibold).monospaced())
                        Text(carLine(car)).font(.caption).foregroundStyle(Theme.muted)
                    }
                    Spacer()
                    if car.id == app.driver?.activeCarId { Text("In use").font(.caption.weight(.semibold)).foregroundStyle(Theme.faint) }
                }
                .padding(.horizontal, 14).padding(.vertical, 12)
            }
        }
    }

    private func carLine(_ car: CheckedVehicle) -> String {
        if car.checkedAt == nil { return String(localized: "Not looked up yet: use it, then open this again.") }
        if car.found == false { return checks?.fake == true ? String(localized: "Not in the RDW’s register (fine on the test server)") : String(localized: "Not in the RDW’s register") }
        if car.exported == true { return String(localized: "Exported, says the RDW") }
        var parts = [car.taxi == true ? String(localized: "Taxi") : String(localized: "Not a taxi"), car.insured == true ? String(localized: "insured") : String(localized: "not insured")]
        parts.append(car.apkUntil.map { String(localized: "APK until \(ChecksDate.show($0))") } ?? String(localized: "no APK"))
        if car.plateSeen == false { parts.append(String(localized: "a person checks its plate")) }
        return parts.joined(separator: " · ")
    }

    private func load() async {
        loadFailed = nil
        do {
            let r: ChecksResponse = try await APIClient.shared.get("/api/checks")
            checks = r.checks
        } catch is CancellationError {
            return
        } catch {
            loadFailed = (error as? APIError)?.status == 404 ? String(localized: "This server doesn’t do these checks yet.") : error.localizedDescription
        }
    }

    // Having agreed, on to what they tapped.
    private func agreed(_ new: DriverChecks?) {
        if let new { checks = new }
        path = afterConsent.map { [$0] } ?? []
        afterConsent = nil
    }

    private func done(_ new: DriverChecks?) {
        if let new { checks = new }
        path.removeAll()
        Task { await app.loadDriver() }
    }

    private func goOnline() async {
        working = true
        defer { working = false }
        // Only a person's look left: the Driving tab says so.
        if let problem = await app.goOnline() { error = problem } else if app.driveMode || app.underReview != nil { dismiss() }
    }
}

// Missing, sent (a person looks once everything is in), waiting for review, to send again, expired or done.
struct ChecksPill: View {
    var state: String?
    var body: some View {
        switch state {
        case "done": StatusPill(text: String(localized: "Done"), color: Theme.ok, background: Theme.okSoft)
        case "sent": StatusPill(text: String(localized: "Sent"), color: Theme.ok, background: Theme.okSoft)
        case "waiting": StatusPill(text: String(localized: "In review"), color: Theme.warn, background: Theme.warnSoft)
        case "again": StatusPill(text: String(localized: "Send again"), color: Theme.warn, background: Theme.warnSoft)
        case "expired": StatusPill(text: String(localized: "Expired"), color: Theme.danger, background: Theme.dangerSoft)
        case "unknown": Text("–").font(.subheadline).foregroundStyle(Theme.faint)
        case nil: ProgressView()
        default: StatusPill(text: String(localized: "To do"), color: Theme.muted, background: Theme.soft)
        }
    }
}

// What riders see on a driver whose checks went through.
struct VerifiedBadge: View {
    var body: some View {
        HStack(spacing: 4) {
            VerifiedMark(size: 14)
            Text("Verified").font(.caption.weight(.semibold)).foregroundStyle(Theme.verified)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Verified driver")
    }
}

// The blue check by itself, next to a name. On a coloured card it needs a white rim, or blue disappears on blue.
struct VerifiedMark: View {
    var size: CGFloat = 16
    var rim = false
    var body: some View {
        ZStack {
            if rim { Image(systemName: "checkmark.seal.fill").font(.system(size: size * 1.28, weight: .bold)).foregroundStyle(.white) }
            Image(systemName: "checkmark.seal.fill")
                .symbolRenderingMode(.palette)
                .foregroundStyle(.white, Theme.verified)
                .font(.system(size: size, weight: .semibold))
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Verified driver")
    }
}

// ---------- 1. Consent ----------

struct ConsentStep: View {
    var done: (DriverChecks?) -> Void
    @State private var working = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                explain("person.text.rectangle.fill", String(localized: "Your ID’s chip"), String(localized: "Your phone reads the chip in your passport or ID card. That shows it’s genuine and gives your name, date of birth and until when it’s valid. We never read or keep your BSN or address."))
                explain("faceid", String(localized: "Your face"), String(localized: "A selfie, turning your head, is compared with the photo in the chip. That happens on this phone: the photos never leave it, only how well they match is sent."))
                explain("doc.text.fill", String(localized: "Your documents"), String(localized: "Photos of your chauffeurskaart and taxi permit, and your KvK number. What’s on them is read on this phone and compared with your ID and KvK. Kiwa has no register we can check, so a person may look at the photos. They’re deleted 30 days after the decision."))
                explain("car.fill", String(localized: "Your car"), String(localized: "We look up its plate in the RDW’s open register: registered as a taxi, insured, APK. The plate must be readable on the photo of its back."))
                explain("person.2.fill", String(localized: "Who decides"), String(localized: "When everything checks out you can drive straight away. When something doesn’t, a person looks. Nothing is turned down by a computer."))
                Link("Read how we handle your data", destination: URL(string: "https://drivezzz.s3rver.nl/privacy#checks")!)
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.accentInk)
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            }
            .padding(16)
        }
        .background(Theme.page)
        .navigationTitle("Agree to the checks")
        .safeAreaInset(edge: .bottom) {
            Button { Task { await agree() } } label: { if working { ProgressView().tint(Theme.onAccent) } else { Text("I agree") } }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working)
                .padding(.horizontal, 16).padding(.vertical, 8).background(.bar)
        }
    }

    private func explain(_ symbol: String, _ title: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            IconTile(symbol: symbol)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(text).font(.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func agree() async {
        working = true
        defer { working = false }
        do {
            let r: ChecksResponse = try await APIClient.shared.post("/api/checks/consent", ["version": 1])
            done(r.checks)
        } catch { self.error = error.localizedDescription }
    }
}

// ---------- 2. ID and face ----------

struct IDStep: View {
    @Environment(AppState.self) private var app
    var done: (DriverChecks?) -> Void

    enum Stage: Equatable { case key, reading, selfie, matching, finished }
    @State private var stage: Stage = .key
    @State private var number = ""
    @State private var birth = Calendar.current.date(byAdding: .year, value: -30, to: Date()) ?? Date()
    @State private var expiry = Calendar.current.date(byAdding: .year, value: 5, to: Date()) ?? Date()
    // The scan read all three parts the chip needs. Its dates aren't shown: they're printed on the front of an ID card, and
    // showing them made it look like the side to scan (Pieter, 5 November 2026). Typing it in shows them, as a way out.
    @State private var scanned = false
    @State private var typing = !MRZCapture.available
    @State private var partly = false
    @State private var scanning = false
    @State private var chip: ChipRead?
    @State private var who: CheckedID?
    @State private var latest: DriverChecks?
    @State private var faceOK: Bool?
    @State private var faceMatched: Bool?       // what this phone found: the same person, with a turn of the head
    @State private var capture: SelfieCapture?
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                switch stage {
                case .key, .reading: keyForm
                case .selfie: selfie
                case .matching: HStack(spacing: 10) { ProgressView(); Text("Comparing your face with your ID…") }.padding(14).card(padding: 0)
                case .finished: result
                }
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            }
            .padding(16)
        }
        .background(Theme.page)
        .navigationTitle("Your ID and a selfie")
        .fullScreenCover(isPresented: $scanning) {
            MRZScanner { found in
                scanning = false
                if let found { use(found) }
            }
        }
        .onDisappear { capture?.stop() }
    }

    // What the camera read goes in the form, for the driver to check: what opens the chip. Not the name: it has no check digit and
    // was too often read wrong (Pieter, 8 November 2026), while the chip gives it exactly, and that's the one shown and kept.
    private func use(_ read: MRZRead) {
        guard read.number != nil || read.birth != nil || read.expiry != nil else { return }
        if let n = read.number { number = n }
        if let b = read.birth.flatMap({ MRZKey.date($0, past: true) }) { birth = b }
        if let e = read.expiry.flatMap({ MRZKey.date($0, past: false) }) { expiry = e }
        // Cancelled halfway: what it read is kept, and the rest is typed in.
        scanned = read.number != nil && read.birth != nil && read.expiry != nil
        partly = !scanned
        if partly { typing = true }
    }

    private var keyForm: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Scan the back of your ID card").font(.headline)
                Text("The side without your photo, with three lines of <<< at the bottom. With a passport it’s the two lines at the bottom of the photo page. What it reads opens your ID’s chip.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
            if MRZCapture.available {
                Button { scanning = true } label: { Label(scanned ? String(localized: "Scan again") : String(localized: "Scan the back"), systemImage: "text.viewfinder") }
                    .buttonStyle(scanned ? AnyButtonStyle(GhostButtonStyle()) : AnyButtonStyle(PrimaryButtonStyle()))
            }
            #if DEBUG && targetEnvironment(simulator)
            Button("Pretend to scan (no camera here)") { use(MRZScan.read(["I<NLDSPECI20212<<<<<<<<<<<<<<<", "6503101F3108022NLD<<<<<<<<<<<6", "DE<BRUIJN<<WILLEKE<LISELOTTE<<"])) }
                .buttonStyle(GhostButtonStyle())
            #endif
            if partly {
                NoteBox(symbol: "exclamationmark.triangle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "Not everything could be read. Scan again, or fill in the rest."))
            }
            if scanned || typing {
                VStack(spacing: 0) {
                    LabeledContent("Document number") {
                        TextField("", text: $number)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .multilineTextAlignment(.trailing)
                            .font(.body.monospaced())
                    }
                    .padding(14)
                    if typing && !scanned {
                        CardDivider()
                        DatePicker("Date of birth", selection: $birth, in: ...Date(), displayedComponents: .date).padding(.horizontal, 14).padding(.vertical, 8)
                        CardDivider()
                        // No limit: the chip only opens with the date as printed, also on an ID that has run out.
                        DatePicker("Valid until", selection: $expiry, displayedComponents: .date).padding(.horizontal, 14).padding(.vertical, 8)
                    }
                }
                .card(padding: 0)
                if expiry < Calendar.current.startOfDay(for: Date()) {
                    NoteBox(symbol: "exclamationmark.triangle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "This ID has run out: you need one that’s still valid."))
                }
                if scanned {
                    Text("Check the document number, then tap Read ID. Your name comes from the chip.").font(.footnote.weight(.semibold))
                }
                Button { Task { await readChip() } } label: {
                    if stage == .reading { ProgressView().tint(Theme.onAccent) } else { Text("Read ID") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(stage == .reading || number.filter { $0.isLetter || $0.isNumber }.count < 6)
            } else {
                Button("Can’t scan it? Type it in") { typing = true }
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.accentInk)
            }
            if !ChipReader.available {
                NoteBox(symbol: "exclamationmark.triangle.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "This device can’t read chips. Use an iPhone."))
            }
        }
    }

    private var selfie: some View {
        VStack(spacing: 16) {
            if let who { idSummary(who) }
            if let capture {
                ZStack {
                    CameraPreview(session: capture.session)
                        .frame(width: 280, height: 280)
                        .clipShape(Circle())
                        .overlay(Circle().stroke(Theme.accent, lineWidth: 4))
                        // Which way to turn, on that side of your face.
                        .overlay(alignment: capture.arrow == .left ? .leading : .trailing) {
                            if let arrow = capture.arrow {
                                Image(systemName: arrow == .left ? "arrow.left" : "arrow.right")
                                    .font(.system(size: 24, weight: .bold))
                                    .foregroundStyle(Theme.onAccent)
                                    .frame(width: 52, height: 52)
                                    .background(Theme.accent, in: Circle())
                                    .padding(10)
                                    .transition(.scale.combined(with: .opacity))
                            }
                        }
                        .animation(.spring(duration: 0.3), value: capture.arrow)
                }
                .frame(maxWidth: .infinity)
                selfieSteps(capture)
                Text(hintText(capture)).font(.headline).multilineTextAlignment(.center).frame(maxWidth: .infinity)
                if case .failed = capture.phase {
                    Button("Try again") { Task { await startSelfie() } }.buttonStyle(PrimaryButtonStyle())
                }
            } else {
                ProgressView()
            }
        }
    }

    // Where you are: looking straight, the two turns, straight again. Done is green, the one now is the app's colour.
    private func selfieSteps(_ c: SelfieCapture) -> some View {
        HStack(spacing: 6) {
            ForEach(0..<c.stepCount, id: \.self) { i in
                Capsule()
                    .fill(i < c.stepsDone ? Theme.ok : i == c.stepsDone ? Theme.accent : Theme.line)
                    .frame(width: 28, height: 6)
            }
        }
        .frame(maxWidth: .infinity)
        .animation(.easeOut(duration: 0.2), value: c.stepsDone)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(min(c.stepsDone + 1, c.stepCount)) of \(c.stepCount)")
    }

    private func hintText(_ c: SelfieCapture) -> String {
        if case .failed(let why) = c.phase { return why }
        return c.hint
    }

    private var result: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let who { idSummary(who) }
            // What the phone found, said as it is: a good match the server can't take by itself (it wasn't signed by the app) is
            // still a match, and was shown as if it wasn't (Pieter, 7 November 2026). Otherwise only that a person reviews it, not why
            // (Pieter, 8 November 2026). As DriverChecks.kt.
            if faceOK == true {
                NoteBox(symbol: "checkmark.seal.fill", tint: Theme.ok, background: Theme.okSoft, text: String(localized: "Your face matches your ID."))
            } else if faceMatched == true {
                NoteBox(symbol: "checkmark.seal.fill", tint: Theme.ok, background: Theme.okSoft, text: String(localized: "Your face matches your ID. A person confirms it once more before you’re verified. You can carry on with the rest."))
            } else {
                NoteBox(symbol: "clock.fill", tint: Theme.warn, background: Theme.warnSoft, text: String(localized: "Your selfie is waiting for review. You can carry on with the rest."))
            }
            Button("Next") { done(latest) }.buttonStyle(PrimaryButtonStyle())
        }
    }

    private func idSummary(_ id: CheckedID) -> some View {
        HStack(spacing: 12) {
            IconTile(symbol: "person.text.rectangle.fill", tint: Theme.ok, background: Theme.okSoft)
            VStack(alignment: .leading, spacing: 2) {
                Text([id.givenNames, id.surname].compactMap { $0?.capitalized }.joined(separator: " ")).font(.subheadline.weight(.semibold))
                Text("Read from your ID’s chip").font(.caption).foregroundStyle(Theme.muted)
            }
            Spacer()
        }
        .padding(14)
        .card(padding: 0)
    }

    private func readChip() async {
        error = nil
        stage = .reading
        do {
            let key = MRZKey(documentNumber: number, birth: MRZKey.yymmdd.string(from: birth), expiry: MRZKey.yymmdd.string(from: expiry))
            let challenge: CheckChallenge = try await APIClient.shared.post("/api/checks/challenge", ["kind": "chip"])
            let read = try await ChipReader.read(key, challenge: Data(base64Encoded: challenge.nonce) ?? Data())
            var body: [String: Any] = ["challengeId": challenge.id, "sod": read.sod.base64EncodedString(), "dg1": read.dg1.base64EncodedString()]
            if let dg15 = read.dg15 { body["dg15"] = dg15.base64EncodedString() }
            if let sig = read.aaSignature { body["aaSignature"] = sig.base64EncodedString() }
            let r: ChecksResponse = try await APIClient.shared.post("/api/checks/chip", body)
            chip = read
            who = r.checks?.id
            latest = r.checks
            await startSelfie()
        } catch let e as ChipError where e == .cancelled {
            stage = .key
        } catch let e as ChipError where e == .wrongKey {
            stage = .key
            self.error = e.localizedDescription
            // A scan's dates aren't shown, so they couldn't be checked: now they are, to compare with the front of the ID.
            if scanned {
                scanned = false
                typing = true
            }
        } catch {
            stage = .key
            self.error = error.localizedDescription
        }
    }

    private func startSelfie() async {
        error = nil
        if !SelfieCapture.cameraAllowed, !(await SelfieCapture.askCamera()) {
            error = String(localized: "Drivezzz needs the camera for the selfie. Allow it in Settings.")
            return
        }
        var steps: [String] = []
        var challengeId: String?
        do {
            let c: CheckChallenge = try await APIClient.shared.post("/api/checks/challenge", ["kind": "face"])
            steps = c.steps
            challengeId = c.id
        } catch { self.error = error.localizedDescription; return }
        let c = SelfieCapture()
        c.steps = steps
        c.onDone = { pictures in Task { await finish(pictures, challengeId: challengeId, steps: steps) } }
        capture = c
        stage = .selfie
        c.start()
    }

    private func finish(_ pictures: [CGImage], challengeId: String?, steps: [String]) async {
        stage = .matching
        capture = nil
        do {
            guard let chip, let photo = chip.photo?.cgImage, let challengeId else { throw FaceMatchError.noFace }
            // Off the main thread: a few hundred milliseconds of work.
            let (score, same) = try await Task.detached(priority: .userInitiated) { () -> (Double, Double) in
                let matcher = FaceMatcher.shared
                let id = try matcher.features(of: photo)
                let selfies = try pictures.map { try matcher.features(of: $0, onlyOne: true) }
                let scores = selfies.map { FaceMatcher.cosine(id, $0) }
                let same = selfies.count > 1 ? FaceMatcher.cosine(selfies[0], selfies[1]) : 1
                return (scores.reduce(0, +) / Double(max(scores.count, 1)), same)
            }.value
            // The two pictures must be the same person: the head turned, the face didn't change.
            let live = same > 0.5
            let payload: [String: Any] = [
                "v": 1, "challengeId": challengeId, "score": (score * 1000).rounded() / 1000, "live": live, "steps": steps,
                "model": FaceMatcher.modelName, "dg1": SHA256.hash(data: chip.dg1).map { String(format: "%02x", $0) }.joined(), "at": Date().ms,
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
            let text = String(decoding: data, as: UTF8.self)
            var body: [String: Any] = ["payload": text]
            if let user = app.user?.id, let keyId = await AppAttest.keyId(userId: user), let assertion = await AppAttest.sign(data, keyId: keyId, userId: user) {
                body["keyId"] = keyId
                body["assertion"] = assertion
            }
            let r: ChecksResponse = try await APIClient.shared.post("/api/checks/face", body)
            latest = r.checks
            faceOK = r.face?.passed
            faceMatched = live && score >= FaceMatcher.samePerson
            stage = .finished
        } catch {
            stage = .selfie
            self.error = error.localizedDescription
            await startSelfie()
        }
    }
}

// ---------- 3 and 4. Chauffeurskaart and taxi permit ----------

struct DocumentStep: View {
    @Environment(AppState.self) private var app
    var kind: String
    var known: CheckedDocument?
    var done: (DriverChecks?) -> Void

    @State private var image: UIImage?
    @State private var text = ""
    @State private var number = ""
    @State private var validUntil = Date()
    @State private var hasEnd = true
    @State private var camera = false
    @State private var fromCamera = false
    @State private var picked: PhotosPickerItem?
    @State private var reading = false
    @State private var working = false
    @State private var error: String?

    private var title: String { kind == "permit" ? String(localized: "Taxi permit") : String(localized: "Chauffeurskaart") }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(kind == "permit"
                     ? String(localized: "Your vergunning taxivervoer from Kiwa (or the one of the taxi company you drive for). Photograph the page with its number.")
                     : String(localized: "The front of your chauffeurskaart, with your photo, its number and the date it’s valid until."))
                    .font(.footnote).foregroundStyle(Theme.muted)
                if let image {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxHeight: 240).clipShape(RoundedRectangle(cornerRadius: 14)).frame(maxWidth: .infinity)
                }
                if DocumentCamera.available {
                    Button { camera = true } label: { Label(image == nil ? String(localized: "Photograph it") : String(localized: "Photograph it again"), systemImage: "doc.viewfinder") }
                        .buttonStyle(image == nil ? AnyButtonStyle(PrimaryButtonStyle()) : AnyButtonStyle(GhostButtonStyle()))
                } else {
                    PhotosPicker(selection: $picked, matching: .images) { Label("Choose a photo of it", systemImage: "photo") }
                        .buttonStyle(GhostButtonStyle())
                }
                if reading { HStack(spacing: 8) { ProgressView(); Text("Reading it…").font(.footnote) } }
                if image != nil {
                    VStack(spacing: 0) {
                        TextField("Number", text: $number)
                            .textInputAutocapitalization(.characters).autocorrectionDisabled().font(.body.monospaced()).padding(14)
                        CardDivider()
                        if kind == "permit" {
                            Toggle("It has an end date", isOn: $hasEnd).tint(Theme.accent).padding(.horizontal, 14).padding(.vertical, 8)
                            if hasEnd { CardDivider() }
                        }
                        if hasEnd {
                            DatePicker("Valid until", selection: $validUntil, in: Date()..., displayedComponents: .date).padding(.horizontal, 14).padding(.vertical, 8)
                        }
                    }
                    .card(padding: 0)
                    Text("Check that these match what’s on it.").font(.caption).foregroundStyle(Theme.faint)
                }
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            }
            .padding(16)
        }
        .background(Theme.page)
        .navigationTitle(title)
        .safeAreaInset(edge: .bottom) {
            if image != nil {
                Button { Task { await send() } } label: { if working { ProgressView().tint(Theme.onAccent) } else { Text("Send") } }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(working || number.count < 4)
                    .padding(.horizontal, 16).padding(.vertical, 8).background(.bar)
            }
        }
        .fullScreenCover(isPresented: $camera) {
            DocumentCamera { scanned in
                camera = false
                if let scanned { Task { await use(scanned, fromCamera: true) } }
            }
            .ignoresSafeArea()
        }
        .onChange(of: picked) { _, item in
            Task {
                if let data = try? await item?.loadTransferable(type: Data.self), let img = UIImage(data: data) { await use(img, fromCamera: false) }
            }
        }
        .onAppear {
            if let n = known?.number { number = n }
            if kind == "permit", known != nil, known?.expires == nil { hasEnd = false }
        }
    }

    private func use(_ img: UIImage, fromCamera: Bool) async {
        image = img
        self.fromCamera = fromCamera
        reading = true
        let read = await DocumentReader.read(img)
        reading = false
        text = read.text
        if let n = read.number { number = n }
        if let d = read.validUntil, d > Date() { validUntil = d; hasEnd = true }
    }

    private func send() async {
        guard let image, let jpeg = DocumentReader.jpeg(image) else { return }
        working = true
        defer { working = false }
        let expires = hasEnd ? ChecksDate.iso.string(from: validUntil) : ""
        let camera = fromCamera ? "1" : "0"
        let read = String(text.prefix(3000))
        var q = URLComponents()
        q.queryItems = [
            URLQueryItem(name: "kind", value: kind),
            URLQueryItem(name: "number", value: number),
            URLQueryItem(name: "expires", value: expires),
            URLQueryItem(name: "camera", value: camera),
            URLQueryItem(name: "text", value: read),
        ]
        do {
            let headers = await AppAttest.headers(signing: ["drivezzz-doc-1", kind, number, expires, camera, AppAttest.hash(Data(read.utf8))], photo: jpeg, userId: app.user?.id)
            // A plus sign in a query means a space, and what's signed must arrive as it was.
            let query = (q.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
            let r: ChecksResponse = try await APIClient.shared.upload("/api/checks/document?\(query)", jpeg: jpeg, headers: headers)
            done(r.checks)
        } catch { self.error = error.localizedDescription }
    }
}

struct AnyButtonStyle: ButtonStyle {
    private let make: (Configuration) -> AnyView
    init<S: ButtonStyle>(_ style: S) { make = { AnyView(style.makeBody(configuration: $0)) } }
    func makeBody(configuration: Configuration) -> some View { make(configuration) }
}

// ---------- 5. KvK ----------

struct KvkStep: View {
    var known: String?
    var done: (DriverChecks?) -> Void
    @State private var number = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("The 8 digits of your business at the Kamer van Koophandel (or the taxi company you drive for).").font(.footnote).foregroundStyle(Theme.muted)
                TextField("KvK number", text: $number)
                    .keyboardType(.numberPad)
                    .font(.title3.monospaced())
                    .padding(14)
                    .card(padding: 0)
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            }
            .padding(16)
        }
        .background(Theme.page)
        .navigationTitle("KvK number")
        .onAppear { if let known { number = known } }
        .safeAreaInset(edge: .bottom) {
            Button { Task { await send() } } label: { if working { ProgressView().tint(Theme.onAccent) } else { Text("Send") } }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working || number.filter(\.isNumber).count != 8)
                .padding(.horizontal, 16).padding(.vertical, 8).background(.bar)
        }
    }

    private func send() async {
        working = true
        defer { working = false }
        do {
            let r: ChecksResponse = try await APIClient.shared.post("/api/checks/kvk", ["number": number.filter(\.isNumber)])
            done(r.checks)
        } catch { self.error = error.localizedDescription }
    }
}
