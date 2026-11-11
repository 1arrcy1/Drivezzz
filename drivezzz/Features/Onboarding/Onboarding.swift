import SwiftUI

// The loading screen: the road drives.
struct LoadingView: View {
    @State private var phase: CGFloat = 0
    @State private var shown = false

    var body: some View {
        ZStack {
            Theme.gradient.ignoresSafeArea()
            VStack(spacing: 22) {
                ZStack {
                    ZRoad().stroke(Theme.onAccent, style: StrokeStyle(lineWidth: 26, lineCap: .round, lineJoin: .round))
                    ZRoad().stroke(Theme.roadDash, style: StrokeStyle(lineWidth: 3, lineCap: .round, dash: [8, 9], dashPhase: phase))
                }
                .frame(width: 170, height: 170)
                Text("Drivezzz")
                    .font(.system(size: 38, weight: .bold))
                    .kerning(-0.5)
                    .foregroundStyle(Theme.onAccent)
            }
            .opacity(shown ? 1 : 0)
            .scaleEffect(shown ? 1 : 0.94)
        }
        .onAppear {
            withAnimation(.easeOut(duration: 0.35)) { shown = true }
            withAnimation(.linear(duration: 0.7).repeatForever(autoreverses: false)) { phase = -17 }
        }
    }
}

// The first screen: the biggest features, then Continue, which opens the EULA, or log in.
struct IntroView: View {
    @State private var showLogin = false
    @State private var showEula = false
    @State private var eula: Eula?

    private let features: [(icon: String, title: String, text: String)] = [
        ("eurosign.circle.fill", String(localized: "Cheapest driver nearby"), String(localized: "Drivers set their own rates. The quote includes their way to you.")),
        ("hand.raised.fill", String(localized: "Name your price"), String(localized: "Say what you’ll pay. A driver near you can claim it.")),
        ("calendar", String(localized: "Plan a ride"), String(localized: "Book up to a week ahead, at the best price of all planned drives.")),
        ("checkmark.shield.fill", String(localized: "Check the plate"), String(localized: "Check in once you’re in the car. Your route is followed by both phones.")),
        ("bitcoinsign.circle.fill", String(localized: "Pay your way"), String(localized: "USDC or SOL from your own wallet, once a driver takes your ride: it waits in escrow until the ride is done. Or cash, in the car.")),
        ("steeringwheel", String(localized: "Drive when you want"), String(localized: "Set your price and get paid to your own wallet within 24 hours.")),
    ]

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    hero
                    VStack(alignment: .leading, spacing: 20) {
                        ForEach(features.indices, id: \.self) { i in
                            HStack(alignment: .top, spacing: 14) {
                                Image(systemName: features[i].icon)
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(Theme.accentInk)
                                    .frame(width: 44, height: 44)
                                    .background(Theme.accentSoft, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(features[i].title).font(.headline).foregroundStyle(Theme.ink)
                                    Text(features[i].text).font(.subheadline).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 24)
                    .padding(.bottom, 8)
                    .frame(maxWidth: Room.page, alignment: .leading)
                    .frame(maxWidth: .infinity)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .ignoresSafeArea(edges: .top)
            VStack(spacing: 10) {
                Button("Continue") { showEula = true }
                    .buttonStyle(PrimaryButtonStyle())
                Button("I already have an account") { showLogin = true }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 36)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
            .frame(maxWidth: Room.page)
        }
        .sheet(isPresented: $showLogin) { LoginView() }
        .sheet(isPresented: $showEula) { EulaView(eula: eula) }
        // Fetched here so it's there as soon as the sheet opens.
        .task { eula = try? await APIClient.shared.get("/api/eula") }
    }

    // Your colour, the road from the logo large behind it, and what Drivezzz is in one line.
    private var hero: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                ZRoad()
                    .stroke(Theme.onAccent, style: StrokeStyle(lineWidth: 5, lineCap: .round, lineJoin: .round))
                    .frame(width: 44, height: 44)
                Text("Drivezzz").font(.system(size: 24, weight: .bold)).kerning(-0.4)
            }
            Text("Rides at the price drivers set themselves")
                .font(.system(size: 36, weight: .bold))
                .kerning(-0.9)
                .fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Theme.onAccent)
        .padding(.horizontal, 24)
        .padding(.bottom, 30)
        .frame(maxWidth: Room.page, alignment: .leading)
        .frame(maxWidth: .infinity, minHeight: 340, alignment: .bottom)
        .background(alignment: .topTrailing) {
            ZRoad()
                .stroke(Theme.onAccent.opacity(0.1), style: StrokeStyle(lineWidth: 64, lineCap: .round, lineJoin: .round))
                .frame(width: 400, height: 400)
                .offset(x: 130, y: -40)
        }
        .background(Theme.accent)
        .clipShape(UnevenRoundedRectangle(bottomLeadingRadius: 32, bottomTrailingRadius: 32, style: .continuous))
    }
}

// After the EULA: the ID is made. The name can be anything; the ID stays.
struct NameView: View {
    @Environment(AppState.self) private var app
    @State private var name = ""
    @State private var working = false
    @State private var error: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    MarkTile(size: 44).padding(.top, 30)
                    ScreenTitle(title: String(localized: "What’s your name?"), subtitle: String(localized: "Drivers and riders see it. Keep the ID if you like; you can change this later."))
                    TextField(app.user?.id ?? String(localized: "Your name"), text: $name)
                        .font(.title3.weight(.semibold))
                        .textInputAutocapitalization(.words)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .focused($focused)
                        .onSubmit { Task { await start() } }
                        .padding(18)
                        .background(Theme.soft, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).stroke(focused ? Theme.accent : .clear, lineWidth: 2))
                        .onChange(of: name) { _, value in if value.count > 30 { name = String(value.prefix(30)) } }
                    HStack(spacing: 8) {
                        Text("Your user ID").foregroundStyle(Theme.muted)
                        Text(app.user?.id ?? "").font(.subheadline.monospaced().weight(.semibold)).foregroundStyle(Theme.ink)
                    }
                    .font(.subheadline)
                    Text("Your ID stays yours. Add an email and password in Profile to use your account on another phone.")
                        .font(.footnote)
                        .foregroundStyle(Theme.faint)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 24)
            }
            .scrollBounceBehavior(.basedOnSize)
            VStack(spacing: 10) {
                ErrorText(text: error)
                Button { Task { await start() } } label: {
                    if working { ProgressView().tint(Theme.onAccent) } else { Text("Start") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working)
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 12)
        }
    }

    private func start() async {
        guard !working else { return }
        working = true
        error = nil
        defer { working = false }
        do { try await app.finishName(name) } catch { self.error = error.localizedDescription }
    }
}

struct LoginView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                ScreenTitle(title: String(localized: "Log in"), subtitle: String(localized: "With the email and password you added in Profile."))
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .fieldStyle()
                PasswordField(placeholder: String(localized: "Password"), text: $password)
                    .fieldStyle()
                ErrorText(text: error)
                Button { Task { await go() } } label: {
                    if working { ProgressView().tint(Theme.onAccent) } else { Text("Log in") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working || email.isEmpty || password.isEmpty)
                Spacer()
            }
            .padding(24)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    private func go() async {
        working = true
        error = nil
        defer { working = false }
        do {
            try await app.login(email: email.trimmingCharacters(in: .whitespacesAndNewlines), password: password.trimmingCharacters(in: .newlines))
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

struct CreateLoginView: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                ScreenTitle(title: String(localized: "Create a login"), subtitle: String(localized: "Keeps your account and user ID, so you can use them on another phone."))
                TextField("Email", text: $email)
                    .textContentType(.username)
                    .keyboardType(.emailAddress)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .fieldStyle()
                PasswordField(placeholder: String(localized: "Password (at least 8 characters)"), text: $password, isNew: true)
                    .fieldStyle()
                ErrorText(text: error)
                Button { Task { await go() } } label: {
                    if working { ProgressView().tint(Theme.onAccent) } else { Text("Create login") }
                }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(working || email.isEmpty || password.count < 8)
                Spacer()
            }
            .padding(24)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    private func go() async {
        working = true
        error = nil
        defer { working = false }
        do {
            try await app.register(email: email.trimmingCharacters(in: .whitespaces), password: password)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}

// SwiftUI's SecureField can stop passing on what's typed after a dash, while still showing the dots: "review-test-1"
// reached the server as "review-". This one hands over every change, and nothing rewrites the text.
struct PasswordField: UIViewRepresentable {
    var placeholder: String
    @Binding var text: String
    var isNew = false

    func makeUIView(context: Context) -> UITextField {
        let field = UITextField()
        field.isSecureTextEntry = true
        field.placeholder = placeholder
        field.textContentType = isNew ? .newPassword : .password
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.smartDashesType = .no
        field.smartQuotesType = .no
        field.smartInsertDeleteType = .no
        field.font = .preferredFont(forTextStyle: .body)
        field.adjustsFontForContentSizeCategory = true
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        field.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        // One line high, not whatever space is on offer.
        field.setContentHuggingPriority(.required, for: .vertical)
        field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
        return field
    }

    func updateUIView(_ field: UITextField, context: Context) {
        context.coordinator.text = $text
        if field.text != text { field.text = text }
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject {
        var text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        @objc func changed(_ field: UITextField) { text.wrappedValue = field.text ?? "" }
    }
}

extension View {
    func fieldStyle() -> some View {
        self
            .padding(16)
            .background(Theme.soft, in: RoundedRectangle(cornerRadius: Theme.buttonRadius, style: .continuous))
    }
}

// Banned: why, for how long, and an appeal once per 24 hours, until a decision is made.
struct BanView: View {
    @Environment(AppState.self) private var app
    @State private var message = ""
    @State private var working = false
    @State private var error: String?
    @State private var checking = false
    @State private var checked: String?
    @State private var nextCheck: Date?

    private var ban: Ban? { app.standing?.ban }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image(systemName: "hand.raised.slash.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(Theme.danger)
                    .padding(.top, 40)
                ScreenTitle(title: ban?.endsAt == nil ? String(localized: "You’re banned") : String(localized: "You’re banned for a week"),
                            subtitle: ban?.reason)
                if let ends = ban?.endsAt {
                    Label("Until \(Fmt.dayTime(Date(ms: ends)))", systemImage: "clock")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Theme.ink)
                }
                if let strikes = app.standing?.strikes, strikes > 0 {
                    Text("\(strikes) of \(app.standing?.maxStrikes ?? 3) strikes. At \(app.standing?.maxStrikes ?? 3), the ban is permanent.")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
                // No way out but the appeal: a ban stays on the phone, whichever account or install asks.
                appeal
                checkAgainButton
                if let checked { Text(checked).font(.footnote).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 24)
        }
        .task {
            while !Task.isCancelled {
                await app.refreshMe()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    @ViewBuilder
    private var appeal: some View {
        if ban?.decided == true {
            VStack(alignment: .leading, spacing: 6) {
                Text("A decision was made").font(.headline).foregroundStyle(Theme.ink)
                if let answer = ban?.answer { Text(answer).font(.subheadline).foregroundStyle(Theme.muted) }
                Text("You can’t appeal again from the app.").font(.footnote).foregroundStyle(Theme.faint)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text("Appeal").font(.headline).foregroundStyle(Theme.ink)
                ForEach(ban?.appeals ?? []) { appeal in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(appeal.message ?? "").font(.subheadline).foregroundStyle(Theme.ink)
                        if let at = appeal.at { Text("Sent \(Fmt.dayTime(Date(ms: at)))").font(.caption).foregroundStyle(Theme.faint) }
                    }
                }
                if ban?.canAppeal == true {
                    TextEditor(text: $message)
                        .frame(minHeight: 110)
                        .padding(8)
                        .background(Theme.soft, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                        .overlay(alignment: .topLeading) {
                            if message.isEmpty {
                                Text("Tell us what happened").foregroundStyle(Theme.faint).padding(14).allowsHitTesting(false)
                            }
                        }
                    ErrorText(text: error)
                    Button { Task { await send() } } label: {
                        if working { ProgressView().tint(Theme.onAccent) } else { Text("Send appeal") }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(working || message.trimmingCharacters(in: .whitespacesAndNewlines).count < 5)
                    Text("One appeal per 24 hours.").font(.footnote).foregroundStyle(Theme.faint)
                } else if let next = ban?.nextAppealAt {
                    Text("We have your appeal. You can send another after \(Fmt.dayTime(Date(ms: next))).")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .card()
        }
    }

    // Once every half a minute, like the check that runs by itself: asking more often can't change the answer any sooner.
    private var checkAgainButton: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let wait = nextCheck.map { Int($0.timeIntervalSince(context.date).rounded(.up)) } ?? 0
            Button { Task { await checkAgain() } } label: {
                if checking {
                    ProgressView().tint(Theme.accentInk)
                } else if wait > 0 {
                    Text("Check again in \(wait)s").monospacedDigit()
                } else {
                    Text("Check again")
                }
            }
            .buttonStyle(GhostButtonStyle())
            .disabled(checking || wait > 0)
        }
    }

    // A lifted ban also shows by itself within half a minute; this is for not having to wait.
    private func checkAgain() async {
        checking = true
        defer {
            checking = false
            nextCheck = Date().addingTimeInterval(30)
        }
        do {
            try await app.checkStanding()
            checked = String(localized: "Still banned. Checked at \(Fmt.time(Date())).")
        } catch {
            checked = error.localizedDescription
        }
    }

    private func send() async {
        working = true
        error = nil
        defer { working = false }
        do {
            let s: Standing = try await APIClient.shared.post("/api/appeals", ["message": message])
            app.standing = s
            message = ""
        } catch { self.error = error.localizedDescription }
    }
}
