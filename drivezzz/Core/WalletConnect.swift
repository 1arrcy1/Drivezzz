import Foundation
import CryptoKit

// A debug build notes what happens with wallets in a file, to read from the Mac: real wallet apps can only be tried on the
// phone, and this says what they actually answered. Never the wc: link or an address.
//   xcrun devicectl device copy from --device … --domain-type appDataContainer --domain-identifier eu.drivezzz.app --source Documents/wallet-log.txt --destination wallet-log.txt
enum WalletLog {
    static func note(_ line: String) {
        #if DEBUG
        guard let folder = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let file = folder.appendingPathComponent("wallet-log.txt")
        let text = Data("\(Date().formatted(date: .omitted, time: .standard))  \(line)\n".utf8)
        if let handle = try? FileHandle(forWritingTo: file) {
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: text)
            try? handle.close()
        } else {
            try? text.write(to: file)
        }
        #endif
    }
}

// WalletConnect v2's Sign protocol, for an app asking wallets to sign, with CryptoKit and a web socket and nothing
// else: pairing through a wc: link, the relay (irn_ messages, encrypted so only the two sides can read them), a
// session, and requests over it. See specs.walletconnect.com. Drivezzz asks wallets for their address and to sign a ride's payment.
@MainActor
final class WalletConnectClient {
    struct Session: Codable, Equatable {
        var topic: String
        var symKey: String
        var address: String
        var chain: String
        var expiry: Int
        // Every account the wallet shared (chain:address, CAIP-10), on every chain asked for.
        var accounts: [String]? = nil
    }
    struct Failure: LocalizedError {
        let errorDescription: String?
        var rejected = false
    }

    private static let relayHost = "relay.walletconnect.org"
    // The relay (another one only for testing).
    static var relayURL = "wss://relay.walletconnect.org"
    private var projectId = ""
    private var socket: URLSessionWebSocketTask?
    // The key per topic we listen on.
    private var keys: [String: Data] = [:]
    private var relayWaiting: [Int64: CheckedContinuation<Void, Error>] = [:]
    private var responses: [Int64: CheckedContinuation<[String: Any], Error>] = [:]
    private var settle: CheckedContinuation<[String: Any], Error>?
    private var settleTopic: String?
    private var lastId: Int64 = 0

    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
    private static func unhex(_ text: String) -> Data? {
        guard text.count % 2 == 0 else { return nil }
        var out = Data(capacity: text.count / 2)
        var i = text.startIndex
        while i < text.endIndex {
            let next = text.index(i, offsetBy: 2)
            guard let byte = UInt8(text[i..<next], radix: 16) else { return nil }
            out.append(byte)
            i = next
        }
        return out
    }
    private static func topic(of key: Data) -> String { hex(Data(SHA256.hash(data: key))) }

    // MARK: Pairing

    // What a wallet may do on each kind of chain, by WalletConnect's namespace.
    private static let methods = ["solana": ["solana_signTransaction", "solana_signMessage"]]

    // A new session: `open` gets the wc: link to hand to the wallet. Comes back when the wallet approved. `chain` is
    // the one that matters most; `also` are others the wallet may have instead.
    func connect(projectId: String, chain: String, also: [String] = [], open: @escaping (String) -> Void) async throws -> Session {
        self.projectId = projectId
        try await ensureSocket()
        let symKey = SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }
        let pairing = Self.topic(of: symKey)
        let me = Curve25519.KeyAgreement.PrivateKey()
        keys[pairing] = symKey
        try await subscribe(pairing)
        let id = nextId()
        let expiry = Int(Date().timeIntervalSince1970) + 300
        let proposal: [String: Any] = [
            "id": id, "jsonrpc": "2.0", "method": "wc_sessionPropose",
            "params": [
                "requiredNamespaces": [String: Any](),
                "optionalNamespaces": Self.namespaces([chain] + also),
                "relays": [["protocol": "irn"]],
                "proposer": [
                    "publicKey": Self.hex(me.publicKey.rawRepresentation),
                    "metadata": ["name": "Drivezzz", "description": "Rides, paid in crypto", "url": "https://drivezzz.s3rver.nl",
                                 "icons": ["https://drivezzz.s3rver.nl/logo.png"], "redirect": ["native": "drivezzz://wallet/wc", "universal": "https://drivezzz.s3rver.nl"]],
                ],
                "expiryTimestamp": expiry,
            ] as [String: Any],
        ]
        // Listen first: the answer can come as soon as the wallet sees the proposal.
        async let answer = waitForResponse(id, timeout: 300)
        do {
            try await publish(pairing, proposal, tag: 1100, ttl: 300, prompt: true)
        } catch {
            responses.removeValue(forKey: id)?.resume(throwing: error)
            throw error
        }
        WalletLog.note("asked for \(([chain] + also).joined(separator: ", "))")
        open("wc:\(pairing)@2?relay-protocol=irn&symKey=\(Self.hex(symKey))&expiryTimestamp=\(expiry)")
        let result = try await answer
        WalletLog.note("the wallet answered the proposal")
        guard let theirs = (result["responderPublicKey"] as? String).flatMap(Self.unhex) else { throw Failure(errorDescription: String(localized: "The wallet answered with something Drivezzz can’t read.")) }
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: theirs)
        let sessionKey = try me.sharedSecretFromKeyAgreement(with: peer)
            .hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(), sharedInfo: Data(), outputByteCount: 32)
            .withUnsafeBytes { Data($0) }
        let sessionTopic = Self.topic(of: sessionKey)
        keys[sessionTopic] = sessionKey
        keys[pairing] = nil
        let settled = try await waitForSettle(topic: sessionTopic)
        let all = ((settled["namespaces"] as? [String: Any]) ?? [:]).values.flatMap { (($0 as? [String: Any])?["accounts"] as? [String]) ?? [] }
        // Chains only: an account's last part is its address.
        WalletLog.note("the session came, with accounts on: \(Set(all.map { $0.split(separator: ":").prefix(2).joined(separator: ":") }).sorted().joined(separator: ", "))")
        let wanted = Set([chain] + also)
        let accounts = all.filter { account in wanted.contains(where: { account.hasPrefix("\($0):") }) }
        guard let account = accounts.first(where: { $0.hasPrefix("\(chain):") }) ?? accounts.first, let address = account.split(separator: ":").last else {
            throw Failure(errorDescription: String(localized: "This wallet didn’t share an address for any of our coins. Turn them on in the wallet, or pick another wallet."))
        }
        let first = account.split(separator: ":").prefix(2).joined(separator: ":")
        return Session(topic: sessionTopic, symKey: Self.hex(sessionKey), address: String(address), chain: first, expiry: (settled["expiry"] as? Int) ?? expiry, accounts: accounts)
    }

    // The proposal's namespaces: per kind of chain, its chains and what may be asked there.
    private static func namespaces(_ chains: [String]) -> [String: Any] {
        var out: [String: [String]] = [:]
        for chain in chains { out[String(chain.split(separator: ":").first ?? ""), default: []].append(chain) }
        return out.reduce(into: [String: Any]()) { result, item in
            result[item.key] = ["chains": item.value, "methods": methods[item.key] ?? [], "events": [String]()]
        }
    }

    // MARK: Requests

    // Asks the wallet; `open` brings it to the front once the request is on its way.
    func request(_ session: Session, projectId: String, method: String, params: [String: Any], open: @escaping () -> Void) async throws -> [String: Any] {
        self.projectId = projectId
        guard let key = Self.unhex(session.symKey) else { throw Failure(errorDescription: String(localized: "Connect your wallet again.")) }
        keys[session.topic] = key
        try await ensureSocket()
        try await subscribe(session.topic)
        let id = nextId()
        let payload: [String: Any] = ["id": id, "jsonrpc": "2.0", "method": "wc_sessionRequest",
                                      "params": ["request": ["method": method, "params": params], "chainId": session.chain] as [String: Any]]
        async let answer = waitForResponse(id, timeout: 300)
        do {
            try await publish(session.topic, payload, tag: 1108, ttl: 300, prompt: true)
        } catch {
            responses.removeValue(forKey: id)?.resume(throwing: error)
            throw error
        }
        open()
        return try await answer
    }

    // Back from the wallet: iOS may have cut the socket while we were away. Messages wait for us at the relay.
    func resume() {
        guard !keys.isEmpty else { return }
        Task { try? await ensureSocket() }
    }

    func cancelWaiting(reason: String = String(localized: "Stopped.")) {
        let failure = Failure(errorDescription: reason, rejected: true)
        for (_, c) in responses { c.resume(throwing: failure) }
        responses = [:]
        settle?.resume(throwing: failure)
        settle = nil
    }

    func forget(_ session: Session) { keys[session.topic] = nil }

    // MARK: The relay

    private func nextId() -> Int64 {
        let id = max(lastId + 1, Int64(Date().timeIntervalSince1970 * 1000) * 1000 + Int64.random(in: 0..<1000))
        lastId = id
        return id
    }

    private func waitForResponse(_ id: Int64, timeout: TimeInterval) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            responses[id] = continuation
            Task {
                try? await Task.sleep(for: .seconds(timeout))
                if let c = responses.removeValue(forKey: id) { c.resume(throwing: Failure(errorDescription: String(localized: "The wallet didn’t answer in time. Try again."))) }
            }
        }
    }

    private func waitForSettle(topic: String) async throws -> [String: Any] {
        settleTopic = topic
        return try await withCheckedThrowingContinuation { continuation in
            settle = continuation
            Task {
                try? await subscribe(topic)
                try? await Task.sleep(for: .seconds(60))
                if let c = settle, settleTopic == topic {
                    settle = nil
                    c.resume(throwing: Failure(errorDescription: String(localized: "The wallet didn’t finish connecting. Try again.")))
                }
            }
        }
    }

    private func ensureSocket() async throws {
        if let socket, socket.state == .running { return }
        guard !projectId.isEmpty else { throw Failure(errorDescription: String(localized: "WalletConnect isn’t set up yet. Use Phantom or Solflare for now.")) }
        var parts = URLComponents(string: Self.relayURL) ?? URLComponents()
        parts.queryItems = [URLQueryItem(name: "auth", value: try relayToken()), URLQueryItem(name: "projectId", value: projectId),
                            URLQueryItem(name: "ua", value: "wc-2/swift-Drivezzz-1/ios/Drivezzz")]
        guard let url = parts.url else { throw Failure(errorDescription: String(localized: "Can’t reach WalletConnect.")) }
        let task = URLSession.shared.webSocketTask(with: url)
        socket = task
        task.resume()
        receive(on: task)
        for topic in keys.keys { try? await subscribe(topic) }
    }

    // The relay wants a signed token from a key of this app's (not a wallet's, and worth nothing else).
    private func relayToken() throws -> String {
        let key: Curve25519.Signing.PrivateKey
        if let saved = Keychain.read("wc.clientKey").flatMap({ Data(base64Encoded: $0) }), let k = try? Curve25519.Signing.PrivateKey(rawRepresentation: saved) {
            key = k
        } else {
            key = Curve25519.Signing.PrivateKey()
            Keychain.write("wc.clientKey", key.rawRepresentation.base64EncodedString())
        }
        let did = "did:key:z" + Base58.encode(Data([0xed, 0x01]) + key.publicKey.rawRepresentation)
        func b64url(_ data: Data) -> String {
            data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        }
        let now = Int(Date().timeIntervalSince1970)
        let header = try JSONSerialization.data(withJSONObject: ["alg": "EdDSA", "typ": "JWT"], options: [.sortedKeys])
        let claims = try JSONSerialization.data(withJSONObject: [
            "iss": did, "sub": Self.hex(SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) }), "aud": "wss://\(Self.relayHost)", "iat": now, "exp": now + 86400,
        ] as [String: Any], options: [.sortedKeys, .withoutEscapingSlashes])
        let body = "\(b64url(header)).\(b64url(claims))"
        return "\(body).\(b64url(try key.signature(for: Data(body.utf8))))"
    }

    private func relay(_ method: String, _ params: [String: Any]) async throws {
        let id = nextId()
        let text = String(decoding: try JSONSerialization.data(withJSONObject: ["id": id, "jsonrpc": "2.0", "method": method, "params": params] as [String: Any]), as: UTF8.self)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            relayWaiting[id] = continuation
            socket?.send(.string(text)) { [weak self] error in
                guard let error else { return }
                Task { @MainActor in self?.relayWaiting.removeValue(forKey: id)?.resume(throwing: error) }
            }
            Task {
                try? await Task.sleep(for: .seconds(20))
                relayWaiting.removeValue(forKey: id)?.resume(throwing: Failure(errorDescription: String(localized: "WalletConnect doesn’t answer. Try again.")))
            }
        }
    }

    private func subscribe(_ topic: String) async throws { try await relay("irn_subscribe", ["topic": topic]) }

    private func publish(_ topic: String, _ payload: [String: Any], tag: Int, ttl: Int, prompt: Bool = false) async throws {
        guard let key = keys[topic] else { return }
        let plain = try JSONSerialization.data(withJSONObject: payload)
        let box = try ChaChaPoly.seal(plain, using: SymmetricKey(data: key), nonce: ChaChaPoly.Nonce(data: Data((0..<12).map { _ in UInt8.random(in: 0...255) })))
        let envelope = Data([0]) + box.combined
        try await relay("irn_publish", ["topic": topic, "message": envelope.base64EncodedString(), "ttl": ttl, "tag": tag, "prompt": prompt])
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .success(let message):
                    // Listen on first: handling this one can wait for the relay's answer, and that only comes through here.
                    // The other way round, a real wallet's session sat for the 20 seconds of that wait, and looked stuck.
                    self.receive(on: task)
                    if case .string(let text) = message { await self.handle(text, task) }
                    if case .data(let data) = message { await self.handle(String(decoding: data, as: UTF8.self), task) }
                case .failure:
                    guard self.socket === task else { return }
                    WalletLog.note("the connection to the relay was cut")
                    self.socket = nil
                    // Someone is waiting for an answer: reconnect when the app is in front (resume() does too).
                    if !self.responses.isEmpty || self.settle != nil {
                        try? await Task.sleep(for: .seconds(1))
                        try? await self.ensureSocket()
                    }
                }
            }
        }
    }

    private func handle(_ text: String, _ task: URLSessionWebSocketTask) async {
        guard let json = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else { return }
        if (json["method"] as? String) == "irn_subscription", let id = json["id"],
           let params = json["params"] as? [String: Any], let data = params["data"] as? [String: Any],
           let topic = data["topic"] as? String, let message = data["message"] as? String {
            let ack = try? JSONSerialization.data(withJSONObject: ["id": id, "jsonrpc": "2.0", "result": true])
            if let ack { task.send(.string(String(decoding: ack, as: UTF8.self))) { _ in } }
            await incoming(topic: topic, message: message, tag: data["tag"] as? Int ?? 0)
            return
        }
        // An answer from the relay itself.
        guard let id = (json["id"] as? NSNumber)?.int64Value, let waiting = relayWaiting.removeValue(forKey: id) else { return }
        if let error = json["error"] as? [String: Any] {
            waiting.resume(throwing: Failure(errorDescription: error["message"] as? String ?? String(localized: "WalletConnect refused that.")))
        } else {
            waiting.resume()
        }
    }

    private func incoming(topic: String, message: String, tag: Int) async {
        guard let key = keys[topic], let envelope = Data(base64Encoded: message), envelope.first == 0, envelope.count > 29,
              let box = try? ChaChaPoly.SealedBox(combined: envelope.dropFirst()),
              let plain = try? ChaChaPoly.open(box, using: SymmetricKey(data: key)),
              let json = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any] else { return }
        if let method = json["method"] as? String {
            let id = json["id"] ?? 0
            let reply: [String: Any] = ["id": id, "jsonrpc": "2.0", "result": true]
            if method == "wc_sessionSettle", let params = json["params"] as? [String: Any] {
                try? await publish(topic, reply, tag: 1103, ttl: 300)
                if settleTopic == topic, let c = settle {
                    settle = nil
                    c.resume(returning: params)
                }
            } else {
                // A ping, an event, an extension: yes, with the tag after theirs.
                try? await publish(topic, reply, tag: tag + 1, ttl: 300)
            }
            return
        }
        guard let id = (json["id"] as? NSNumber)?.int64Value, let waiting = responses.removeValue(forKey: id) else { return }
        if let error = json["error"] as? [String: Any] {
            WalletLog.note("the wallet said no: \(error["code"] ?? "") \(error["message"] ?? "")")
            waiting.resume(throwing: Failure(errorDescription: String(localized: "The wallet said no:\(error["message"] as? String ?? String(localized: "rejected"))."), rejected: true))
        } else if let result = json["result"] as? [String: Any] {
            waiting.resume(returning: result)
        } else {
            waiting.resume(returning: [:])
        }
    }
}
