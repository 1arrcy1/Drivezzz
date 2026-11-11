import SwiftUI

// Your wallet. Drivezzz holds no money: a ride's payment waits in its own escrow on Solana until the ride is done.
// What shows here: money on hold going out and coming to you, per wallet with why and when, in red, green and orange (going
// out, coming in, still pending), then the wallet your addresses came from and what has already moved.
struct WalletScreen: View {
    @Environment(AppState.self) private var app
    @State private var wallet: WalletView_?
    @State private var addressFor: WalletCoin?
    @State private var showConnect = false
    @State private var requestingChange = false
    @State private var error: String?

    // Which side you're on now: someone who also drives can be riding, with money on hold.
    private var isDriver: Bool { app.mode == .driver && app.user?.isDriver == true }
    private var coins: [WalletCoin] { wallet?.usedCoins ?? [] }
    private var connected: [WalletCoin] { coins.filter { $0.address != nil } }
    // Gray until support says yes, and gray again once it's changed. The server decides this, and checks it again on saving.
    private var locked: Bool { wallet?.change?.locked == true }
    private var moves: [WalletMove] { wallet?.moves ?? [] }
    private var goingOut: [WalletMove] { moves.filter { $0.pending == true && $0.direction == "out" } }
    private var comingIn: [WalletMove] { moves.filter { $0.pending == true && $0.direction == "in" } }
    private var history: [WalletMove] { moves.filter { $0.pending != true } }
    // What's coming in, per wallet it lands in, soonest first.
    private var perWallet: [(wallet: String, moves: [WalletMove])] {
        Dictionary(grouping: comingIn) { $0.wallet ?? "" }
            .map { (wallet: $0.key, moves: $0.value.sorted { ($0.when ?? .infinity) < ($1.when ?? .infinity) }) }
            .sorted { ($0.moves.first?.when ?? .infinity) < ($1.moves.first?.when ?? .infinity) }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                hero
                if !perWallet.isEmpty { comingToWallets }
                if !goingOut.isEmpty { goingOutSection }
                connectedWallet
                if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
                historySection
            }
            .padding(16)
        }
        .background(Theme.page)
        .navigationTitle("Wallet")
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
        .sheet(item: $addressFor, onDismiss: { Task { await load() } }) { coin in AddressSheet(coin: coin, locked: locked).presentationDetents([.medium]) }
        .sheet(isPresented: $requestingChange) { WalletChangeSheet { wallet = $0 }.presentationDetents([.medium, .large]) }
        .sheet(isPresented: $showConnect, onDismiss: { Task { await load() } }) { ConnectWalletSheet(network: wallet?.network, coins: coins) }
        .task(id: app.rev) { await load() }
        .refreshable { await load() }
    }

    private var hero: some View {
        HeroCard {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    // Not a Label: its icon takes the tint, which is this card's own colour.
                    HStack(spacing: 8) {
                        Image(systemName: "wallet.bifold.fill")
                        Text("Drivezzz wallet")
                    }
                    .font(.subheadline.weight(.semibold))
                    .opacity(0.9)
                    Spacer()
                    if wallet?.demo == true {
                        pill(String(localized: "Demo"))
                    } else if wallet?.network == "testnet" {
                        pill(String(localized: "Test network"))
                    }
                }
                HStack(spacing: 10) {
                    total(String(localized: "On hold, going out"), cents: sum(goingOut), sign: "−", colour: Theme.danger, symbol: "arrow.up.right")
                    total(String(localized: "On hold, coming to you"), cents: sum(comingIn), sign: "+", colour: Theme.ok, symbol: "arrow.down.left")
                }
                HStack(spacing: 8) {
                    Image(systemName: "lock.shield.fill")
                    Text("Drivezzz holds no money. Each ride’s payment waits in its own escrow on Solana until the ride is done.")
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(.caption.weight(.medium))
                .opacity(0.9)
            }
        }
    }

    private func sum(_ list: [WalletMove]) -> Int { list.compactMap(\.eurCents).reduce(0, +) }

    private func total(_ title: String, cents: Int, sign: String, colour: Color, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Text(cents == 0 ? Fmt.eur(0) : "\(sign)\(Fmt.eur(cents))")
                .font(.system(size: 24, weight: .bold)).kerning(-0.5).monospacedDigit()
                .minimumScaleFactor(0.7)
                .lineLimit(1)
                .foregroundStyle(cents == 0 ? Theme.muted : colour)
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func pill(_ text: String) -> some View {
        Text(text).font(.caption.weight(.bold)).padding(.horizontal, 9).padding(.vertical, 4).background(Theme.onAccent.opacity(0.18), in: Capsule())
    }

    // What's on its way to you, per wallet it lands in, each with why and a timer.
    private var comingToWallets: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Array(perWallet.enumerated()), id: \.element.wallet) { i, group in
                CardGroup(title: i == 0 ? String(localized: "Coming to your wallets") : nil, footer: i == perWallet.count - 1 ? String(localized: "Refunds go back to the wallet you paid with. Pay for driving goes to the wallet you connected.") : nil) {
                    HStack(spacing: 12) {
                        Image(systemName: "wallet.bifold.fill").font(.subheadline).foregroundStyle(Theme.accentInk).frame(width: 34, height: 34).background(Theme.accentSoft, in: Circle())
                        VStack(alignment: .leading, spacing: 3) {
                            Text(Fmt.shortAddress(group.wallet)).font(.subheadline.weight(.semibold).monospaced())
                            if let via = coins.first(where: { $0.address == group.wallet })?.via { ViaPill(via: via) } else { Text("The wallet you paid with").font(.caption).foregroundStyle(Theme.faint) }
                        }
                        Spacer()
                        Text("+\(Fmt.eur(sum(group.moves)))").font(.headline.weight(.bold).monospacedDigit()).foregroundStyle(Theme.ok)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    ForEach(group.moves) { move in
                        CardDivider()
                        WalletMoveRow(move: move)
                    }
                }
            }
        }
    }

    private var goingOutSection: some View {
        CardGroup(title: String(localized: "Going out"), footer: String(localized: "Held in escrow until the ride is done, then paid to your driver.")) {
            ForEach(Array(goingOut.enumerated()), id: \.element.id) { i, move in
                if i > 0 { CardDivider() }
                WalletMoveRow(move: move)
            }
        }
    }

    @ViewBuilder
    private var historySection: some View {
        if !history.isEmpty {
            CardGroup(title: String(localized: "History")) {
                ForEach(Array(history.prefix(30).enumerated()), id: \.element.id) { i, move in
                    if i > 0 { CardDivider() }
                    WalletMoveRow(move: move)
                }
            }
        }
    }

    // Each address with the wallet app it came from, and whether you use that coin.
    private var connectedWallet: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your wallet").font(.headline).padding(.horizontal, 4)
            VStack(spacing: 0) {
                ForEach(Array(coins.enumerated()), id: \.element.id) { i, coin in
                    if i > 0 { CardDivider() }
                    HStack(spacing: 12) {
                        CoinBadge(coin: coin.id, size: 34)
                        Button { if coin.address == nil { showConnect = true } else { addressFor = coin } } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(coin.symbol ?? coin.id).font(.subheadline.weight(.semibold))
                                if let address = coin.address {
                                    Text(Fmt.shortAddress(address)).font(.caption.monospaced()).foregroundStyle(Theme.muted)
                                    if let via = coin.via { ViaPill(via: via) }
                                    if coin.needsTokenAccount == true {
                                        Text("No USDC account yet, so USDC can’t reach this wallet. Swap a little SOL to USDC in your wallet once, then turn this on.")
                                            .font(.caption)
                                            .foregroundStyle(Theme.warn)
                                            .multilineTextAlignment(.leading)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                } else {
                                    Text("Not connected").font(.caption.weight(.semibold)).foregroundStyle(Theme.accentInk)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if coin.address != nil {
                            Toggle(isDriver ? String(localized: "Get paid in \(coin.symbol ?? "")") : String(localized: "Use \(coin.symbol ?? "")"), isOn: Binding(get: { coin.enabled == true }, set: { on in Task { await enable(coin, on) } }))
                                .labelsHidden()
                                .tint(Theme.accent)
                        }
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }
                if isDriver {
                    if !coins.isEmpty { CardDivider() }
                    HStack(spacing: 12) {
                        CoinBadge(coin: Coins.cash, size: 34)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("Cash").font(.subheadline.weight(.semibold))
                            Text("Your rider pays you in the car").font(.caption).foregroundStyle(Theme.muted)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Toggle("Take cash", isOn: Binding(get: { wallet?.takesCash == true }, set: { on in Task { await takeCash(on) } }))
                            .labelsHidden()
                            .tint(Theme.accent)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                }
            }
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .lifted(0.45, radius: 22)
            Text(isDriver ? String(localized: "You’re paid to this wallet, in the coin your rider paid with. Turn on the coins you take.") : String(localized: "You don’t need a wallet here to ride: you pick one when you pay. Only drivers connect one, to get paid."))
                .font(.footnote)
                .foregroundStyle(Theme.faint)
                .padding(.horizontal, 4)
            Button { showConnect = true } label: {
                Label(connected.isEmpty ? String(localized: "Connect a wallet") : String(localized: "Change wallet"), systemImage: connected.isEmpty ? "link" : "arrow.triangle.2.circlepath")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(PrimaryButtonStyle())
            .disabled(locked)
            .padding(.top, 6)
            if !connected.isEmpty { changeStatus }
            if !connected.isEmpty {
                HStack(spacing: 4) {
                    Text("Want an address removed?").foregroundStyle(Theme.faint)
                    Link("Ask support", destination: URL(string: "https://drivezzz.s3rver.nl/support")!).foregroundStyle(Theme.accentInk)
                }
                .font(.footnote)
                .frame(maxWidth: .infinity)
            }
        }
    }

    // Under the button: what it takes to change your wallet, and how far that is.
    @ViewBuilder private var changeStatus: some View {
        let request = wallet?.change?.request
        if !locked {
            // A server from before the lock says nothing at all, and has nothing to say here either.
            if request?.status == "allowed" {
                Label("Support said yes: you can change your wallet once.", systemImage: "checkmark.circle.fill")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(Theme.ok)
                    .frame(maxWidth: .infinity)
            }
        } else if request?.status == "open" {
            VStack(alignment: .leading, spacing: 4) {
                Label("Your request is with support", systemImage: "clock.fill").font(.subheadline.weight(.semibold))
                Text("You’ll get a notification when it’s decided.").font(.footnote).foregroundStyle(Theme.muted)
                if let message = request?.message { Text("“\(message)”").font(.footnote).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .fieldStyle()
        } else {
            Button { requestingChange = true } label: { Label("Request wallet change", systemImage: "paperplane.fill").frame(maxWidth: .infinity) }
                .buttonStyle(GhostButtonStyle(height: 46))
            Text(request?.status == "declined"
                 ? String(localized: "Support didn’t allow your last request. You can ask again and explain more.")
                 : String(localized: "Your wallet is locked, so someone who gets into your account can’t send your money elsewhere. Support can unlock it for one change."))
                .font(.footnote)
                .foregroundStyle(Theme.faint)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
        }
    }

    private func load() async {
        do { wallet = try await APIClient.shared.get("/api/wallet"); error = nil } catch { self.error = error.localizedDescription }
    }

    private func enable(_ coin: WalletCoin, _ on: Bool) async {
        do { wallet = try await APIClient.shared.post("/api/wallet/enable", ["coin": coin.id, "enabled": on]) } catch { self.error = error.localizedDescription }
    }

    private func takeCash(_ on: Bool) async {
        do { wallet = try await APIClient.shared.post("/api/wallet/cash", ["enabled": on]) } catch { self.error = error.localizedDescription }
    }
}

// One line of money: why, how much, which way, and when it clears.
private struct WalletMoveRow: View {
    var move: WalletMove

    private var isOut: Bool { move.direction == "out" }
    private var title: String {
        switch (move.direction, move.reason) {
        case ("in", "refund"): String(localized: "Refund")
        case ("in", "half"): String(localized: "Half back: ride cancelled")
        case ("in", "drive"): String(localized: "Pay for driving")
        case ("in", "driveHalf"): String(localized: "Half for a cancelled drive")
        case ("out", "half"): String(localized: "Half to your driver: ride cancelled")
        default: move.pending == true ? String(localized: "Paying for your ride") : String(localized: "Paid for your ride")
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            CoinBadge(coin: move.coin, size: 34)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(title).font(.subheadline.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if let cents = move.eurCents {
                        Text("\(isOut ? "−" : "+")\(Fmt.eur(cents))").font(.subheadline.weight(.bold).monospacedDigit()).foregroundStyle(isOut ? Theme.danger : Theme.ok)
                    }
                }
                Text(move.to.map { String(localized: "Ride to \($0)") } ?? String(localized: "A ride")).font(.caption).foregroundStyle(Theme.faint).lineLimit(1)
                HStack(spacing: 8) {
                    Text(Fmt.amount(move.amount, Fmt.coinSymbol(move.coin))).font(.caption.monospacedDigit()).foregroundStyle(Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                    Spacer(minLength: 4)
                    state
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var state: some View {
        if move.pending == true {
            if move.needsUsdcAccount == true {
                PendingPill(text: String(localized: "Needs a USDC account"))
            } else if move.onHold == true {
                PendingPill(text: String(localized: "Being checked"))
            } else if move.settling == true {
                PendingPill(text: String(localized: "On its way"))
            } else if let when = move.when {
                ClearTimer(until: when)
            } else {
                PendingPill(text: move.rideStatus == "scheduled" ? String(localized: "Until your ride") : String(localized: "Until the ride is done"))
            }
        } else if move.demo == true {
            Text("Demo").font(.caption2.weight(.semibold)).foregroundStyle(Theme.faint)
        } else if let raw = move.explorer, let url = URL(string: raw) {
            Link(move.at.map { Fmt.dayTime(Date(ms: $0)) } ?? String(localized: "On the chain"), destination: url).font(.caption2.weight(.semibold)).foregroundStyle(Theme.accentInk)
        } else if let at = move.at {
            Text(Fmt.dayTime(Date(ms: at))).font(.caption2).foregroundStyle(Theme.faint)
        }
    }
}

// Orange: it hasn't happened yet.
private struct PendingPill: View {
    var text: String
    var symbol: String?

    var body: some View {
        HStack(spacing: 3) {
            if let symbol { Image(systemName: symbol).font(.caption2.weight(.bold)) }
            Text(text).font(.caption2.weight(.bold).monospacedDigit()).lineLimit(1)
        }
        .foregroundStyle(Theme.warn)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Theme.warnSoft, in: Capsule())
    }
}

// How long until money clears: hours, minutes and seconds, or days once it's that far off.
private struct ClearTimer: View {
    var until: Double

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let left = Int(ServerClock.date(until).timeIntervalSince(ctx.date))
            PendingPill(text: left <= 0 ? String(localized: "Any moment now") : Self.text(left), symbol: left <= 0 ? nil : "timer")
        }
    }

    private static func text(_ left: Int) -> String {
        if left >= 86_400 { return String(localized: "\(left / 86_400)d \(left % 86_400 / 3600)h") }
        return String(format: "%d:%02d:%02d", left / 3600, left % 3600 / 60, left % 60)
    }
}

// Which wallet app an address came from.
struct ViaPill: View {
    var via: String

    var body: some View {
        Label("via \(via)", systemImage: "link")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(Theme.accentInk)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Theme.accentSoft, in: Capsule())
    }
}

// An address only ever comes from a wallet, so it can't be mistyped. Changing it is connecting another wallet;
// removing it goes through support.
struct AddressSheet: View {
    @Environment(\.dismiss) private var dismiss
    var coin: WalletCoin
    var locked = false
    @State private var showConnect = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                CoinBadge(coin: coin.id, size: 44)
                VStack(alignment: .leading, spacing: 3) {
                    Text("\(coin.symbol ?? "") address").font(.title3.weight(.bold))
                    if let via = coin.via { ViaPill(via: via) }
                }
            }
            Text(coin.address ?? "").font(.footnote.monospaced()).foregroundStyle(Theme.ink).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).fieldStyle()
            Text("Where your \(coin.symbol ?? String(localized: "coins")) go. It came from your wallet, so it can’t be wrong.").font(.footnote).foregroundStyle(Theme.muted)
            Button { showConnect = true } label: { Label("Change wallet", systemImage: "arrow.triangle.2.circlepath").frame(maxWidth: .infinity) }
                .buttonStyle(GhostButtonStyle(height: 46))
                .disabled(locked)
            if locked { Text("Locked: request a change on the Wallet screen.").font(.footnote).foregroundStyle(Theme.faint).frame(maxWidth: .infinity) }
            HStack(spacing: 4) {
                Text("To remove it,").foregroundStyle(Theme.faint)
                Link("ask support", destination: URL(string: "https://drivezzz.s3rver.nl/support")!).foregroundStyle(Theme.accentInk)
            }
            .font(.footnote)
            .frame(maxWidth: .infinity)
            Spacer()
        }
        .padding(24)
        .sheet(isPresented: $showConnect, onDismiss: { dismiss() }) { ConnectWalletSheet(network: nil, coins: [coin]) }
    }
}

// Asking support to unlock your wallet for one change, with a message for whoever decides.
struct WalletChangeSheet: View {
    @Environment(\.dismiss) private var dismiss
    var onSent: (WalletView_) -> Void
    @State private var message = ""
    @State private var sending = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Request wallet change").font(.title3.weight(.bold))
            Text("Tell support why you need another wallet. Once they say yes you can change it once, and then it locks again.")
                .font(.footnote)
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            TextField("Why do you want to change it?", text: $message, axis: .vertical).lineLimit(4...8).fieldStyle()
            if let error { Text(error).font(.footnote).foregroundStyle(Theme.danger) }
            Button { Task { await send() } } label: { Text(sending ? String(localized: "Sending…") : String(localized: "Send request")) }
                .buttonStyle(PrimaryButtonStyle())
                .disabled(sending)
            Spacer()
        }
        .padding(24)
    }

    private func send() async {
        sending = true
        defer { sending = false }
        do {
            let view: WalletView_ = try await APIClient.shared.post("/api/wallet/change-request", ["message": message])
            onSent(view)
            dismiss()
        } catch { self.error = error.localizedDescription }
    }
}
