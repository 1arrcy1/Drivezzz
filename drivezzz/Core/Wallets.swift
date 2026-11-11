import CryptoKit
import Foundation
import UIKit

// Connecting and paying with a wallet app. The wallet opens, you approve there, and it comes back: nobody types or pastes
// an address, so it can't be the wrong one, and Drivezzz never sees your keys. Three ways in: wallets with their own link
// (Phantom, Solflare), MetaMask's own protocol (MetaMaskConnect.swift) and WalletConnect (Trust Wallet and the others).
// Solana only: that's where the ride escrow is.
@Observable
final class Wallets {
    static let shared = Wallets()
    // Not a secret: it says which app is talking to the WalletConnect relay. From cloud.reown.com.
    static let projectId = "31ae35073ce5a54aa9051157dfb9c1a3"

    struct App: Identifiable, Hashable {
        enum Kind: Hashable {
            case link(base: String, scheme: String)
            case walletConnect(deep: String)
            case metaMask
        }
        let id: String
        let name: String
        let kind: Kind
        var store: String?
    }
    static let trust = App(id: "trust", name: "Trust Wallet", kind: .walletConnect(deep: "trust://"), store: "https://apps.apple.com/app/id1288339409")
    static let apps = [
        trust,
        App(id: "phantom", name: "Phantom", kind: .link(base: "https://phantom.app/ul/v1/", scheme: "phantom://"), store: "https://apps.apple.com/app/id1598432977"),
        App(id: "solflare", name: "Solflare", kind: .link(base: "https://solflare.com/ul/v1/", scheme: "solflare://"), store: "https://apps.apple.com/app/id1580902717"),
        App(id: "metamask", name: "MetaMask", kind: .metaMask, store: "https://apps.apple.com/app/id1438144202"),
        App(id: "other", name: String(localized: "Another wallet"), kind: .walletConnect(deep: "wc://")),
    ]

    // Solana on WalletConnect. USDC lives at the same address.
    private static let mainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    private static let devnet = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"

    // A wallet with its own link, connected: what asking it to sign takes, kept so a payment needs one approval.
    private struct LinkSession: Codable {
        var address: String
        var token: String
        var shared: Data
        var publicKey: Data
        var cluster: String
    }

    private(set) var waitingFor: String?
    private(set) var manualLink: String?
    private let wc = WalletConnectClient()
    private let metaMask = MetaMaskConnect()
    private var linkWaiting: CheckedContinuation<[String: String], Error>?

    // drivezzz://…: a wallet with its own link coming back with its answer.
    func handle(_ url: URL) {
        guard url.scheme == "drivezzz" else { return }
        WalletLog.note("came back through \(url.host ?? "")\(url.path)")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let values = Dictionary(items.compactMap { item in item.value.map { (item.name, $0) } }, uniquingKeysWith: { a, _ in a })
        guard url.path.hasSuffix("link") || url.path.hasSuffix("signed"), let waiting = linkWaiting else { return }
        linkWaiting = nil
        if let code = values["errorCode"] {
            // 4001 is the person saying no; anything else is the wallet itself.
            waiting.resume(throwing: code == "4001" ? WalletFailure.declined : WalletFailure.refused(values["errorMessage"]))
        } else {
            waiting.resume(returning: values)
        }
    }

    // Back in the app: a socket that was cut comes back.
    func resume() {
        if waitingFor != nil { WalletLog.note("back in Drivezzz, still waiting for \(waitingFor ?? "")") }
        wc.resume()
        metaMask.resume()
    }

    func stopWaiting() {
        if waitingFor != nil { WalletLog.note("stopped waiting for \(waitingFor ?? "")") }
        wc.cancelWaiting()
        metaMask.cancelWaiting()
        linkWaiting?.resume(throwing: CancellationError())
        linkWaiting = nil
        waitingFor = nil
        manualLink = nil
    }

    // What the wallet shared: its Solana address, for both our coins.
    func connect(_ app: App, network: String?) async throws -> [String: String] {
        waitingFor = app.name
        defer { waitingFor = nil; manualLink = nil }
        WalletLog.note("connect \(app.name)")
        do {
            let address: String
            switch app.kind {
            case .link(let base, _):
                address = try await connectLink(app, base: base, network: network).address
            case .walletConnect(let deep):
                address = try await walletConnect(app, deep: deep, chain: Self.mainnet).address
            case .metaMask:
                address = try await connectMetaMask(app).address
            }
            WalletLog.note("connected \(app.name)")
            return ["sol": address, "usdc-sol": address]
        } catch {
            WalletLog.note("connect \(app.name) failed: \(error.localizedDescription)")
            throw error
        }
    }

    // Paying a ride: the server builds the payment for this wallet's address, the wallet signs it, the server sends it on.
    // Asking per wallet, because on iOS a solana: link opens whichever wallet the phone picks, not the one with the money.
    func pay(rideId: String, with app: App, network: String?) async throws {
        waitingFor = app.name
        defer { waitingFor = nil; manualLink = nil }
        let signed: Data
        switch app.kind {
        case .link(let base, _):
            let cluster = Self.cluster(network)
            let saved = Keychain.read(Self.linkKey(app)).flatMap { try? JSONDecoder().decode(LinkSession.self, from: Data($0.utf8)) }
            let session = saved?.cluster == cluster ? saved! : try await connectLink(app, base: base, network: network)
            do {
                signed = try await signLink(app, base: base, session: session, transaction: payment(rideId, account: session.address))
            } catch WalletFailure.refused {
                // Most likely a session it no longer knows: connect again and ask once more.
                let fresh = try await connectLink(app, base: base, network: network)
                signed = try await signLink(app, base: base, session: fresh, transaction: payment(rideId, account: fresh.address))
            }
        case .walletConnect(let deep):
            // On a test network, a wallet that only has the real one still signs: the server sends it, not the wallet.
            let chain = network == "mainnet" ? Self.mainnet : Self.devnet
            let session = try await walletConnect(app, deep: deep, chain: chain, also: network == "mainnet" ? [] : [Self.mainnet])
            var transaction = try await payment(rideId, account: session.address)
            let answer = try await wc.request(session, projectId: Self.projectId, method: "solana_signTransaction", params: ["transaction": transaction.base64EncodedString()]) {
                if let url = URL(string: "\(deep)wc?sessionTopic=\(session.topic)") { UIApplication.shared.open(url) }
            }
            // The whole transaction, or only its signature: the first one in it, ours being the only signer.
            if let whole = (answer["transaction"] as? String).flatMap({ Data(base64Encoded: $0) }) {
                signed = whole
            } else if let signature = (answer["signature"] as? String).flatMap(Base58.decode), signature.count == 64 {
                transaction.replaceSubrange(1..<65, with: signature)
                signed = transaction
            } else {
                throw WalletFailure.unreadable
            }
        case .metaMask:
            signed = try await payWithMetaMask(app, rideId: rideId)
        }
        try await APIClient.shared.call("POST", "/api/rides/\(rideId)/pay/send", ["transaction": signed.base64EncodedString()])
    }

    private func payment(_ rideId: String, account: String) async throws -> Data {
        let r: PayResponse = try await APIClient.shared.post("/api/rides/\(rideId)/pay", ["account": account])
        guard let transaction = r.transaction.flatMap({ Data(base64Encoded: $0) }) else { throw WalletFailure.unreadable }
        return transaction
    }

    private func walletConnect(_ app: App, deep: String, chain: String, also: [String] = []) async throws -> WalletConnectClient.Session {
        try await wc.connect(projectId: Self.projectId, chain: chain, also: also) { [weak self] uri in
            // Another wallet: a plain wc: link opens whichever app the phone gives those links to (often MetaMask),
            // so it isn't opened by itself. The sheet shows it to scan, copy, or open on purpose.
            if app.id == "other" {
                self?.manualLink = uri
                return
            }
            let encoded = uri.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? uri
            guard let url = URL(string: "\(deep)wc?uri=\(encoded)") else { return }
            UIApplication.shared.open(url) { opened in
                WalletLog.note("opening \(app.name): \(opened ? "opened" : "didn't open")")
                guard !opened else { return }
                self?.wc.cancelWaiting(reason: WalletFailure.notInstalled(app.name).errorDescription ?? "")
            }
        }
    }

    private static let metaMaskKey = "wallet.metamask"

    private func connectMetaMask(_ app: App) async throws -> MetaMaskConnect.Session {
        let session = try await metaMask.connect { [weak self] link in self?.openMetaMask(app, link) }
        if let saved = try? JSONEncoder().encode(session) { Keychain.write(Self.metaMaskKey, String(decoding: saved, as: UTF8.self)) }
        return session
    }

    private func openMetaMask(_ app: App, _ link: URL) {
        UIApplication.shared.open(link) { [weak self] opened in
            WalletLog.note("opening \(app.name): \(opened ? "opened" : "didn't open")")
            guard !opened else { return }
            self?.metaMask.cancelWaiting(reason: WalletFailure.notInstalled(app.name))
        }
    }

    // With the connection from last time if there is one, so it's one approval. MetaMask can't sign for Solana's test
    // networks on a phone, so a test server can only get as far as that wallet saying so.
    private func payWithMetaMask(_ app: App, rideId: String) async throws -> Data {
        let saved = Keychain.read(Self.metaMaskKey).flatMap { try? JSONDecoder().decode(MetaMaskConnect.Session.self, from: Data($0.utf8)) }
        let known = saved.flatMap { $0.expiresAt > Date().timeIntervalSince1970 ? $0 : nil }
        func sign(_ session: MetaMaskConnect.Session) async throws -> Data {
            let transaction = try await payment(rideId, account: session.address)
            return try await metaMask.signTransaction(transaction, session: session) { [weak self] link in self?.openMetaMask(app, link) }
        }
        guard let known else { return try await sign(connectMetaMask(app)) }
        do {
            return try await sign(known)
        } catch WalletFailure.refused {
            // Most likely a connection it no longer has: connect again and ask once more.
            return try await sign(connectMetaMask(app))
        } catch is CancellationError {
            // If it no longer has the connection it only says so on its own screen, and this is how that ends: next time, a new one.
            Keychain.write(Self.metaMaskKey, nil)
            throw CancellationError()
        }
    }

    private static func cluster(_ network: String?) -> String { network == "mainnet" ? "mainnet-beta" : "devnet" }
    private static func linkKey(_ app: App) -> String { "wallet.link.\(app.id)" }

    // Opens a wallet's link and waits for it to come back. The link is a web address that the wallet's app claims: asked for
    // as a universal link it reaches the app or says it can't, so nothing has to guess whether the app is there. Without
    // that it would open the website and never come back. iOS can be told to keep a site in Safari, so if the app's own
    // scheme answers, it gets a plain try too.
    private func askLink(_ app: App, _ url: URL) async throws -> [String: String] {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<[String: String], Error>) in
            linkWaiting = continuation
            UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { [weak self] opened in
                WalletLog.note("opening \(app.name): \(opened ? "opened" : "not as a universal link")")
                guard !opened else { return }
                if case .link(_, let scheme) = app.kind, let own = URL(string: scheme), UIApplication.shared.canOpenURL(own) {
                    UIApplication.shared.open(url)
                    return
                }
                guard let waiting = self?.linkWaiting else { return }
                self?.linkWaiting = nil
                waiting.resume(throwing: WalletFailure.notInstalled(app.name))
            }
        }
    }

    private func signLink(_ app: App, base: String, session: LinkSession, transaction: Data) async throws -> Data {
        let nonce = Data((0..<24).map { _ in UInt8.random(in: .min ... .max) })
        let payload = try JSONSerialization.data(withJSONObject: ["transaction": Base58.encode(transaction), "session": session.token])
        var parts = URLComponents(string: "\(base)signTransaction")!
        parts.queryItems = [
            URLQueryItem(name: "dapp_encryption_public_key", value: Base58.encode(session.publicKey)),
            URLQueryItem(name: "nonce", value: Base58.encode(nonce)),
            URLQueryItem(name: "redirect_link", value: "drivezzz://wallet/signed"),
            URLQueryItem(name: "payload", value: Base58.encode(NaCl.seal(payload, nonce: nonce, key: session.shared))),
        ]
        let values = try await askLink(app, parts.url!)
        guard let nonce = values["nonce"].flatMap(Base58.decode), let box = values["data"].flatMap(Base58.decode),
              let plain = NaCl.open(box, nonce: nonce, key: session.shared),
              let json = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any],
              let signed = (json["transaction"] as? String).flatMap(Base58.decode) else {
            throw WalletFailure.unreadable
        }
        return signed
    }

    private func connectLink(_ app: App, base: String, network: String?) async throws -> LinkSession {
        let secret = Curve25519.KeyAgreement.PrivateKey()
        var parts = URLComponents(string: "\(base)connect")!
        parts.queryItems = [
            URLQueryItem(name: "app_url", value: "https://drivezzz.s3rver.nl"),
            URLQueryItem(name: "dapp_encryption_public_key", value: Base58.encode(secret.publicKey.rawRepresentation)),
            URLQueryItem(name: "redirect_link", value: "drivezzz://wallet/link"),
            URLQueryItem(name: "cluster", value: Self.cluster(network)),
        ]
        let values = try await askLink(app, parts.url!)
        guard let theirs = values.first(where: { $0.key.hasSuffix("_encryption_public_key") }).flatMap({ Base58.decode($0.value) }),
              let nonce = values["nonce"].flatMap(Base58.decode), let box = values["data"].flatMap(Base58.decode),
              let shared = try? NaCl.sharedKey(secret: secret, publicKey: theirs),
              let plain = NaCl.open(box, nonce: nonce, key: shared),
              let json = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any],
              let address = json["public_key"] as? String else {
            throw WalletFailure.unreadable
        }
        let session = LinkSession(address: address, token: json["session"] as? String ?? "", shared: shared, publicKey: secret.publicKey.rawRepresentation, cluster: Self.cluster(network))
        if let saved = try? JSONEncoder().encode(session) { Keychain.write(Self.linkKey(app), String(decoding: saved, as: UTF8.self)) }
        return session
    }

}

enum WalletFailure: LocalizedError {
    case declined, unreadable
    case notInstalled(String)
    case refused(String?)
    case noSolanaAccount(String)

    var errorDescription: String? {
        switch self {
        case .declined: String(localized: "You declined in your wallet.")
        case .unreadable: String(localized: "The wallet answered with something Drivezzz can’t read.")
        case .notInstalled(let name): String(localized: "\(name) isn’t on this phone.")
        case .refused(let why): String(localized: "The wallet refused\(why.map { ": \($0)" } ?? ".")")
        case .noSolanaAccount(let name): String(localized: "\(name) didn’t share a Solana account. Choose one when it asks, add one there if you have none, or pick another wallet.")
        }
    }
}
