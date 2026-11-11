import SwiftUI

// You and your account: riding or driving, your wallet, how the app looks.
struct ProfileView: View {
    @Environment(AppState.self) private var app
    @State private var editingName = false
    @State private var name = ""
    @State private var showLogin = false
    @State private var confirmDelete = false
    @State private var confirmLogout = false
    @State private var error: String?
    @State private var becomingDriver = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    header
                    if let lock = app.modeLock {
                        NoteBox(symbol: "lock.fill", tint: Theme.accentInk, background: Theme.accentSoft, text: lock)
                    }
                    shortcuts
                    appearance
                    account
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
                    Text("Drivezzz · \(app.user?.id ?? "")\(ServerConfig.shownServer)").font(.caption.monospaced()).foregroundStyle(Theme.faint).frame(maxWidth: .infinity).textSelection(.enabled)
                }
                .padding(16)
            }
            .background(Theme.page)
            .navigationTitle("Profile")
            .foregroundStyle(Theme.ink)
            .sheet(isPresented: $showLogin) { CreateLoginView().presentationDetents([.medium, .large]) }
            .alert("Your name", isPresented: $editingName) {
                TextField("Name", text: $name)
                Button("Save") { Task { await rename() } }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Your user ID stays \(app.user?.id ?? String(localized: "the same")).")
            }
            .confirmationDialog("Log out?", isPresented: $confirmLogout, titleVisibility: .visible) {
                Button("Log out", role: .destructive) { Task { await app.logout() } }
            } message: {
                Text("You can log back in with your email and password.")
            }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete account", role: .destructive) { Task { await delete() } }
            } message: {
                Text("This can’t be undone.")
            }
        }
    }

    // You, in your colour, with the switch between riding and driving.
    private var header: some View {
        HeroCard {
            VStack(alignment: .leading, spacing: 18) {
                HStack(spacing: 14) {
                    Text(String((app.user?.name ?? "D").prefix(1)).uppercased())
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(Theme.accentOnWhite)
                        .frame(width: 64, height: 64)
                        .background(.white, in: Circle())
                        .overlay(Circle().stroke(Theme.onAccent.opacity(0.35), lineWidth: 3).padding(-4))
                    VStack(alignment: .leading, spacing: 4) {
                        Button { name = app.user?.name ?? ""; editingName = true } label: {
                            HStack(spacing: 6) {
                                Text(app.user?.name ?? "").font(.title2.weight(.bold)).lineLimit(1)
                                if app.driver?.verified == true { VerifiedMark(size: 18, rim: true) }
                                Image(systemName: "pencil.circle.fill").font(.title3).opacity(0.85)
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Change your name")
                        Text(app.user?.email ?? String(localized: "Automatic account · no email yet")).font(.footnote).opacity(0.85).lineLimit(1)
                    }
                }
                modeSwitch
            }
        }
    }

    private var modeSwitch: some View {
        HStack(spacing: 4) {
            modeButton(.rider, String(localized: "Riding"), "figure.wave")
            modeButton(.driver, String(localized: "Driving"), "steeringwheel")
        }
        .padding(4)
        .background(Theme.onAccent.opacity(0.16), in: Capsule())
        .opacity(app.modeLock == nil ? 1 : 0.6)
        .disabled(app.modeLock != nil || becomingDriver)
    }

    private func modeButton(_ mode: AppMode, _ title: String, _ symbol: String) -> some View {
        let on = app.mode == mode
        return Button { Task { await setMode(mode) } } label: {
            // Not a Label: the app's label style colours its icon, which couldn't be read on your colour.
            HStack(spacing: 7) {
                // Becoming a driver asks the server first: show that the tap landed.
                if becomingDriver, mode == .driver {
                    ProgressView().controlSize(.small).tint(Theme.onAccent)
                } else {
                    Image(systemName: symbol)
                }
                Text(title)
            }
                .font(.subheadline.weight(.bold))
                .foregroundStyle(on ? Theme.accentOnWhite : Theme.onAccent)
                .frame(maxWidth: .infinity, minHeight: 40)
                .background(on ? AnyShapeStyle(.white) : AnyShapeStyle(.clear), in: Capsule())
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    // Wallet and standing, the two things people come here for.
    private var shortcuts: some View {
        HStack(spacing: 12) {
            NavigationLink { WalletScreen() } label: {
                shortcut(symbol: "wallet.bifold.fill", title: String(localized: "Wallet"), detail: String(localized: "Coins and addresses"))
            }
            NavigationLink { StandingScreen() } label: {
                let n = app.standing?.strikes ?? 0
                shortcut(symbol: n == 0 ? "checkmark.shield.fill" : "exclamationmark.shield.fill", title: String(localized: "Standing"), detail: n == 0 ? String(localized: "No strikes") : String(localized: "\(n) of \(app.standing?.maxStrikes ?? 4) strikes"), tint: n == 0 ? Theme.ok : Theme.warn, background: n == 0 ? Theme.okSoft : Theme.warnSoft)
            }
        }
        .buttonStyle(.plain)
    }

    private func shortcut(symbol: String, title: String, detail: String, tint: Color = Theme.accentInk, background: Color = Theme.accentSoft) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            IconTile(symbol: symbol, tint: tint, background: background)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(detail).font(.caption).foregroundStyle(Theme.faint).lineLimit(1)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .lifted(0.45, radius: 22)
    }

    // Automatic goes dark when it's dark outside; the other two stay as they are.
    private var appearance: some View {
        @Bindable var app = app
        return VStack(alignment: .leading, spacing: 8) {
            Text("Appearance").font(.title3.weight(.bold)).kerning(-0.3).padding(.horizontal, 4)
            HStack(spacing: 10) {
                ForEach(AppAppearance.allCases) { choice in
                    let on = app.appearance == choice
                    Button { app.appearance = choice } label: {
                        VStack(spacing: 8) {
                            Image(systemName: choice.symbol)
                                .font(.title2)
                                .foregroundStyle(on ? Theme.accentInk : Theme.muted)
                                .frame(height: 34)
                            Text(choice.name).font(.footnote.weight(on ? .bold : .medium)).foregroundStyle(on ? Theme.ink : Theme.muted)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).stroke(on ? Theme.accent : .clear, lineWidth: 2.5))
                        .lifted(0.45, radius: 22)
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(on ? .isSelected : [])
                }
            }
            if app.appearance == .auto {
                Text("Goes dark when it’s dark outside where you are.").font(.footnote).foregroundStyle(Theme.faint).padding(.horizontal, 4)
            }
            colours
        }
    }

    // Blue, red or yellow, and the whole app follows. Set once and left alone, so it stays out of the way until it's asked for.
    private var colours: some View {
        @Bindable var app = app
        return VStack(spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.22)) { app.coloursOpen.toggle() }
            } label: {
                HStack(spacing: 8) {
                    Text("Colour").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                    Spacer()
                    Circle().fill(app.accent.color).frame(width: 14, height: 14)
                    Text(app.accent.name).font(.subheadline).foregroundStyle(Theme.muted)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(Theme.faint)
                        .rotationEffect(.degrees(app.coloursOpen ? 180 : 0))
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Colour")
            .accessibilityValue(app.accent.name)
            .accessibilityHint(app.coloursOpen ? String(localized: "Hides the colours") : String(localized: "Shows the colours"))
            if app.coloursOpen {
                HStack(spacing: 8) {
                    ForEach(AppAccent.allCases) { choice in
                        let on = app.accent == choice
                        Button { app.accent = choice } label: {
                            VStack(spacing: 6) {
                                ZStack {
                                    Circle().fill(choice.color).frame(width: 34, height: 34)
                                    if on { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(choice.onColor) }
                                }
                                Text(choice.name).font(.caption.weight(on ? .semibold : .regular)).foregroundStyle(on ? Theme.ink : Theme.muted)
                            }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(choice.name)
                        .accessibilityAddTraits(on ? .isSelected : [])
                    }
                }
                .padding(.bottom, 12)
                .transition(.opacity)
            }
        }
        .background(Theme.soft, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .padding(.top, 2)
    }

    private var account: some View {
        VStack(alignment: .leading, spacing: 18) {
            // A car in the Netherlands needs these before it goes online (DriverChecksSheet), and a blue check comes with them.
            // A motor or scooter needs none of it, so someone with only those isn't asked.
            if app.user?.isDriver == true, app.driver?.verified == true || app.driver?.cars?.contains(where: { $0.kind == "car" }) == true {
                CardGroup(title: String(localized: "Driving")) {
                    Button { app.checksOpen = true } label: {
                        CardRow(symbol: "checkmark.seal.fill", title: String(localized: "Driving in the Netherlands"),
                                subtitle: app.checksAttention ?? (app.driver?.verified == true ? String(localized: "You’re verified") : String(localized: "Your ID, chauffeurskaart, taxi permit and KvK"))) {
                            if app.driver?.verified == true { VerifiedMark(size: 20) }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            CardGroup(title: String(localized: "Account")) {
                NavigationLink { BlockedPeopleScreen() } label: { CardRow(symbol: "hand.raised.fill", title: String(localized: "Blocked people")) }.buttonStyle(.plain)
                if app.user?.hasLogin != true {
                    CardDivider()
                    Button { showLogin = true } label: { CardRow(symbol: "person.badge.key.fill", title: String(localized: "Create a login"), subtitle: String(localized: "Use your account on another phone")) }.buttonStyle(.plain)
                }
            }
            CardGroup(title: String(localized: "Help")) {
                Link(destination: URL(string: "https://drivezzz.s3rver.nl/support")!) { CardRow(symbol: "questionmark.bubble.fill", title: String(localized: "Support")) }
                CardDivider()
                Link(destination: URL(string: "https://drivezzz.s3rver.nl/terms")!) { CardRow(symbol: "doc.text.fill", title: String(localized: "Terms")) }
                CardDivider()
                Link(destination: URL(string: "https://drivezzz.s3rver.nl/eula")!) { CardRow(symbol: "signature", title: String(localized: "Licence agreement")) }
                CardDivider()
                Link(destination: URL(string: "https://drivezzz.s3rver.nl/privacy")!) { CardRow(symbol: "lock.shield.fill", title: String(localized: "Privacy")) }
            }
            CardGroup {
                // Without an email there's nothing to log back in with, so an account like that can only be deleted.
                if app.user?.hasLogin == true {
                    Button { confirmLogout = true } label: { CardRow(symbol: "rectangle.portrait.and.arrow.right", title: String(localized: "Log out"), tint: Theme.danger, background: Theme.dangerSoft, chevron: false) }.buttonStyle(.plain)
                    CardDivider()
                }
                Button { confirmDelete = true } label: { CardRow(symbol: "trash.fill", title: String(localized: "Delete account"), tint: Theme.danger, background: Theme.dangerSoft, chevron: false) }.buttonStyle(.plain)
            }
        }
    }

    private func setMode(_ new: AppMode) async {
        error = nil
        guard new != app.mode, app.modeLock == nil else { return }
        if new == .rider {
            if app.driveMode { app.stopDriving() }
            // You stay on Profile: only what's around it changes.
            app.riderTab = AppState.profileTab
            app.mode = .rider
            return
        }
        do {
            // You stay on Profile here too, a new driver as well. Set first, so the Driving tab doesn't flash by.
            app.driverTab = AppState.profileTab
            if app.user?.isDriver == true {
                app.mode = .driver
            } else {
                becomingDriver = true
                defer { becomingDriver = false }
                try await app.becomeDriver()
            }
        } catch { self.error = error.localizedDescription }
    }

    private func rename() async {
        do { try await app.rename(name.trimmingCharacters(in: .whitespacesAndNewlines)) } catch { self.error = error.localizedDescription }
    }

    private func delete() async {
        error = nil
        do {
            try await app.deleteAccount()
        } catch { self.error = error.localizedDescription }
    }
}

struct BlockedPeopleScreen: View {
    @State private var people: [BlockedPerson] = []
    @State private var loaded = false

    var body: some View {
        List {
            if people.isEmpty, loaded { Text("Nobody. You can block someone from their page or a ride.").foregroundStyle(Theme.muted) }
            ForEach(people) { person in
                LabeledContent(person.name ?? person.id) {
                    Button("Unblock") { Task { await unblock(person) } }
                        .foregroundStyle(Theme.accentInk)
                        .buttonStyle(.borderless)
                }
            }
        }
        .navigationTitle("Blocked people")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        if let r: BlocksResponse = try? await APIClient.shared.get("/api/blocks") { people = r.blocks ?? [] }
        loaded = true
    }

    private func unblock(_ person: BlockedPerson) async {
        try? await APIClient.shared.call("DELETE", "/api/blocks/\(person.id)")
        await load()
    }
}

struct StandingScreen: View {
    @Environment(AppState.self) private var app

    var body: some View {
        List {
            Section {
                LabeledContent("Strikes", value: String(localized: "\(app.standing?.strikes ?? 0) of \(app.standing?.maxStrikes ?? 3)"))
            } footer: {
                Text("Every strike is a one-week ban, also on this phone. \(app.standing?.maxStrikes ?? 3) strikes is a permanent ban.")
            }
            if let list = app.standing?.strikeList, !list.isEmpty {
                Section("Your strikes") {
                    ForEach(list) { s in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(s.reason ?? "").font(.subheadline)
                            if let at = s.at { Text(Fmt.dayTime(Date(ms: at))).font(.caption).foregroundStyle(Theme.faint) }
                        }
                    }
                }
            }
        }
        .navigationTitle("Account standing")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// Your wallet app shares its Solana address. Nothing can be typed or pasted here: no wallet, no address.
struct ConnectWalletSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    var network: String?
    @State var coins: [WalletCoin]
    @State private var error: String?
    @State private var missingApp: Wallets.App?
    @State private var notSaved: [String: String] = [:]
    private var wallets: Wallets { Wallets.shared }

    private var missing: [WalletCoin] { coins.filter { $0.address == nil } }
    private var connected: [WalletCoin] { coins.filter { $0.address != nil } }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Your wallet app opens to approve this. If it stays there afterwards, come back here yourself. Your keys stay in your wallet.")
                        .font(.subheadline)
                        .foregroundStyle(Theme.muted)
                }
                if wallets.waitingFor != nil {
                    WalletWaitingSections()
                } else {
                    Section("Wallets") {
                        ForEach(Wallets.apps) { wallet in
                            WalletAppRow(wallet: wallet) { Task { await connect(wallet) } }
                        }
                    }
                }
                if let error { Section { Text(error).font(.subheadline).foregroundStyle(Theme.danger) } }
                if let missingApp, let store = missingApp.store.flatMap(URL.init(string:)) {
                    Section { Button("Get \(missingApp.name) in the App Store") { openURL(store) } }
                }
                if !connected.isEmpty {
                    Section("Connected") {
                        ForEach(connected) { coin in
                            LabeledContent(coin.symbol ?? coin.id) {
                                Label(Fmt.shortAddress(coin.address), systemImage: "checkmark").labelStyle(.titleAndIcon).font(.footnote.monospaced()).foregroundStyle(Theme.ok)
                            }
                        }
                    }
                }
                if !missing.isEmpty {
                    Section {
                        ForEach(missing) { coin in missingRow(coin) }
                    } header: {
                        Text("Still missing")
                    } footer: {
                        Text("Addresses only come from your wallet, so they can’t be wrong. Connect a wallet that holds these coins to use them.")
                    }
                }
            }
            .navigationTitle("Connect a wallet")
            .navigationBarTitleDisplayMode(.inline)
            .foregroundStyle(Theme.ink)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { wallets.stopWaiting(); dismiss() } } }
        }
    }

    private func missingRow(_ coin: WalletCoin) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(coin.name ?? coin.id)
            if let problem = notSaved[coin.id] { Text(problem).font(.footnote).foregroundStyle(Theme.danger) }
        }
        .padding(.vertical, 2)
    }

    private func connect(_ wallet: Wallets.App) async {
        error = nil
        missingApp = nil
        do {
            let addresses = try await wallets.connect(wallet, network: network)
            if addresses.isEmpty { error = String(localized: "\(wallet.name) didn’t share an address for any of our coins."); return }
            for (coin, address) in addresses.sorted(by: { $0.key < $1.key }) {
                do {
                    let w: WalletView_ = try await APIClient.shared.post("/api/wallet/address", ["coin": coin, "address": address, "via": wallet.id == "other" ? "WalletConnect" : wallet.name])
                    coins = w.usedCoins
                } catch {
                    notSaved[coin] = error.localizedDescription
                }
            }
        } catch is CancellationError {
        } catch let failure as WalletFailure {
            error = failure.errorDescription
            if case .notInstalled = failure { missingApp = wallet }
        } catch let failure as WalletConnectClient.Failure {
            if failure.errorDescription != String(localized: "Stopped.") {
                error = failure.errorDescription
                if failure.errorDescription?.contains(String(localized: "isn’t on this phone")) == true { missingApp = wallet }
            }
        } catch { self.error = error.localizedDescription }
    }
}

// Waiting for a wallet app to answer: for connecting and for paying.
struct WalletWaitingSections: View {
    @Environment(\.openURL) private var openURL
    private var wallets: Wallets { Wallets.shared }

    var body: some View {
        if let waiting = wallets.waitingFor {
            Section {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Waiting for \(waiting). Approve it there, then come back.").font(.subheadline)
                }
                Button("Stop") { wallets.stopWaiting() }.foregroundStyle(Theme.danger)
            }
            if let link = wallets.manualLink {
                Section {
                    Text("Scan this with your wallet’s WalletConnect scanner, or copy the link and paste it there.").font(.footnote).foregroundStyle(Theme.muted)
                    QRCode(text: link, size: 190).frame(maxWidth: .infinity).padding(.vertical, 6)
                    Button { UIPasteboard.general.string = link } label: { Label("Copy the link", systemImage: "doc.on.doc") }
                    Button { if let url = URL(string: link) { openURL(url) } } label: { Label("Open a wallet app", systemImage: "arrow.up.forward.app") }
                } header: {
                    Text("Another wallet")
                } footer: {
                    Text("“Open a wallet app” lets your iPhone pick the app for WalletConnect links. For MetaMask, go back and pick it in the list: it only shares Solana that way.")
                }
            }
        }
    }
}

// A wallet app in its own colour, so the list reads at a glance.
struct WalletAppRow: View {
    var wallet: Wallets.App
    var action: () -> Void

    private var sharesOurCoins: Bool {
        switch wallet.kind {
        case .link, .metaMask: true
        case .walletConnect: false
        }
    }

    var body: some View {
        Button(action: action) {
            HStack {
                icon
                VStack(alignment: .leading, spacing: 1) {
                    Text(wallet.name)
                    if sharesOurCoins { Text("SOL and USDC").font(.caption).foregroundStyle(Theme.faint) }
                }
                Spacer()
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.faint)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var icon: some View {
        let look: (String, Color) = switch wallet.id {
        case "trust": ("shield.fill", Color(hex: 0x0500FF))
        case "phantom": ("", Color(hex: 0xAB9FF2))
        case "solflare": ("sun.max.fill", Color(hex: 0xFC7227))
        case "metamask": ("", Theme.soft)
        default: ("qrcode", Theme.ink)
        }
        return Group {
            if wallet.id == "phantom" {
                PhantomGhost().fill(.white, style: FillStyle(eoFill: true)).frame(width: 21, height: 19)
            } else if wallet.id == "metamask" {
                MetaMaskFox().frame(width: 27, height: 26)
            } else {
                Image(systemName: look.0).font(.system(size: 16, weight: .semibold)).foregroundStyle(.white)
            }
        }
            .frame(width: 36, height: 36)
            .background(look.1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .padding(.trailing, 4)
    }
}

// Phantom's ghost: a dome, three legs, two eyes cut out. SF Symbols has nothing like it.
struct PhantomGhost: Shape {
    func path(in r: CGRect) -> Path {
        let w = r.width, h = r.height, x = r.minX, y = r.minY
        var p = Path()
        p.move(to: CGPoint(x: x, y: y + h))
        p.addLine(to: CGPoint(x: x, y: y + h * 0.48))
        p.addCurve(to: CGPoint(x: x + w, y: y + h * 0.48), control1: CGPoint(x: x, y: y - h * 0.14), control2: CGPoint(x: x + w, y: y - h * 0.14))
        p.addLine(to: CGPoint(x: x + w, y: y + h))
        for i in stride(from: 2, through: 0, by: -1) {
            let left = x + w * CGFloat(i) / 3
            p.addQuadCurve(to: CGPoint(x: left, y: y + h), control: CGPoint(x: left + w / 6, y: y + h * 0.7))
        }
        p.closeSubpath()
        p.addEllipse(in: CGRect(x: x + w * 0.3, y: y + h * 0.3, width: w * 0.13, height: h * 0.24))
        p.addEllipse(in: CGRect(x: x + w * 0.57, y: y + h * 0.3, width: w * 0.13, height: h * 0.24))
        return p
    }
}

// MetaMask's fox, from its own brand page (metamask.com/assets): flat polygons, back to front, as x, y pairs. SF Symbols has nothing like it.
struct MetaMaskFox: View {
    private static let parts: [(UInt32, [CGFloat])] = [
        (0xFA4B00, [111.57, 134.75, 86.34, 149.85, 68.79, 149.85, 43.56, 134.75, 10.16, 144.72, 0, 110.36, 10.16, 72.22, 0, 39.97, 10.16, 0, 62.35, 31.24, 92.78, 31.24, 144.97, 0, 155.13, 39.97, 144.97, 72.22, 155.13, 110.36, 144.97, 144.72]),
        (0x5C1600, [68.79, 136.17, 86.34, 136.17, 88.61, 127.89, 84.07, 122.82, 71.06, 122.82, 66.52, 127.89]),
        (0xC0C4CD, [86.34, 136.17, 68.79, 136.17, 68.79, 149.85, 86.34, 149.85]),
        (0x5C1600, [92.9, 99.77, 112.05, 95.01, 106.66, 89.72, 96.76, 89.72]),
        (0xE34807, [84.07, 122.82, 92.9, 99.77, 96.76, 89.72, 106.66, 89.72, 112.05, 95.01, 123.04, 92.28, 111.58, 81.39, 90.44, 81.39]),
        (0xE1E3EA, [88.61, 127.89, 111.57, 134.76, 86.34, 149.85, 86.34, 136.17]),
        (0xFF5C16, [111.57, 134.75, 111.57, 110.35, 88.61, 127.89]),
        (0xFF8552, [88.61, 127.89, 111.57, 110.35, 155.13, 110.36, 144.97, 72.22, 123.12, 72.22, 123.04, 92.28, 92.9, 99.77, 84.07, 122.82]),
        (0xFF5C16, [111.58, 81.39, 90.44, 81.39, 94.86, 52.72, 123.12, 72.22, 123.04, 92.28]),
        (0x5C1600, [123.12, 72.22, 144.97, 72.22, 155.13, 39.97, 144.97, 0, 94.86, 52.72]),
        (0xFF5C16, [94.86, 52.72, 144.97, 0, 92.78, 31.24]),
        (0xE34807, [144.97, 144.72, 155.13, 110.36, 111.57, 110.35, 111.57, 134.75]),
        (0x5C1600, [62.23, 99.77, 43.08, 95.01, 48.47, 89.72, 58.37, 89.72]),
        (0xE34807, [71.06, 122.82, 62.23, 99.77, 58.37, 89.72, 48.47, 89.72, 43.08, 95.01, 32.09, 92.28, 43.55, 81.39, 64.69, 81.39]),
        (0xE1E3EA, [66.52, 127.89, 43.56, 134.76, 68.79, 149.85, 68.79, 136.17]),
        (0xFF5C16, [43.56, 134.75, 43.56, 110.35, 66.52, 127.89]),
        (0xFF8552, [66.52, 127.89, 43.56, 110.35, 0, 110.36, 10.16, 72.22, 32.01, 72.22, 32.09, 92.28, 62.23, 99.77, 71.06, 122.82]),
        (0xFF5C16, [43.55, 81.39, 64.69, 81.39, 60.27, 52.72, 32.01, 72.22, 32.09, 92.28]),
        (0x5C1600, [32.01, 72.22, 10.16, 72.22, 0, 39.97, 10.16, 0, 60.27, 52.72]),
        (0xFF5C16, [60.27, 52.72, 10.16, 0, 62.35, 31.24]),
        (0xE34807, [10.16, 144.72, 0, 110.36, 43.56, 110.35, 43.56, 134.75]),
        (0xFF8552, [84.07, 122.82, 94.86, 52.72, 92.78, 31.24, 62.35, 31.24, 60.27, 52.72, 71.06, 122.82]),
    ]

    var body: some View {
        Canvas { context, size in
            let scale = min(size.width / 155.13, size.height / 149.85)
            for (colour, points) in Self.parts {
                var path = Path()
                for i in stride(from: 0, to: points.count, by: 2) {
                    let point = CGPoint(x: points[i] * scale, y: points[i + 1] * scale)
                    if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
                }
                path.closeSubpath()
                context.fill(path, with: .color(Color(hex: colour)))
            }
        }
        .aspectRatio(155.13 / 149.85, contentMode: .fit)
        .accessibilityHidden(true)
    }
}
