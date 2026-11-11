import CryptoKit
import Foundation

// MetaMask's phone app gives other apps Solana only through its own protocol, MetaMask Connect: over WalletConnect it
// offers Ethereum and Tron, and a Solana request ends in a silent failure, with no answer and no way back. So this
// speaks that protocol itself, with CryptoKit and a web socket, as WalletConnect.swift does. What it follows is
// MetaMask/mobile-wallet-protocol and MetaMask/connect-monorepo. Tested against their own wallet client and encryption
// library on their real relay: `server/test/reference/mm-wallet.mjs`.
//
// A link hands MetaMask our public key and the first request. MetaMask answers on the relay, encrypted to that key, with
// its own key and a channel. Everything after goes over that channel, and waits there while either app is in the
// background. MetaMask doesn't come back by itself on this protocol: it says "Return to the app".

// secp256k1, as far as the encryption below needs it. CryptoKit has other curves, not this one. Not constant-time, which
// is fine here: the keys only live on this phone, are made per connection, and sign nothing.
enum Secp256k1 {
    struct NotAKey: Error {}

    // A number below the curve's prime, in four 64-bit limbs, lowest first.
    private struct F: Equatable {
        var a: UInt64, b: UInt64, c: UInt64, d: UInt64

        static let zero = F(a: 0, b: 0, c: 0, d: 0)
        static let one = F(a: 1, b: 0, c: 0, d: 0)
        static let p = F(a: 0xFFFF_FFFE_FFFF_FC2F, b: .max, c: .max, d: .max)
        private static let pMinus2 = F(a: 0xFFFF_FFFE_FFFF_FC2D, b: .max, c: .max, d: .max)
        private static let sqrtPower = F(a: 0xFFFF_FFFF_BFFF_FF0C, b: .max, c: .max, d: 0x3FFF_FFFF_FFFF_FFFF)     // (p + 1) / 4

        init(a: UInt64, b: UInt64, c: UInt64, d: UInt64) { self.a = a; self.b = b; self.c = c; self.d = d }

        init(_ bytes: some Collection<UInt8>) {
            var limbs: [UInt64] = [0, 0, 0, 0]
            for (i, byte) in bytes.reversed().enumerated() where i < 32 { limbs[i / 8] |= UInt64(byte) << UInt64(i % 8 * 8) }
            self.init(a: limbs[0], b: limbs[1], c: limbs[2], d: limbs[3])
        }

        var bytes: Data {
            var out = Data(capacity: 32)
            for limb in [d, c, b, a] { for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8(truncatingIfNeeded: limb >> UInt64(shift))) } }
            return out
        }

        var isOdd: Bool { a & 1 == 1 }
        var isBelowPrime: Bool { !(d == .max && c == .max && b == .max && a >= Self.p.a) }

        private static func add(_ x: F, _ y: F) -> (F, Bool) {
            var carry = false
            func step(_ m: UInt64, _ n: UInt64) -> UInt64 {
                let (s1, o1) = m.addingReportingOverflow(n)
                let (s2, o2) = s1.addingReportingOverflow(carry ? 1 : 0)
                carry = o1 || o2
                return s2
            }
            let a = step(x.a, y.a), b = step(x.b, y.b), c = step(x.c, y.c), d = step(x.d, y.d)
            return (F(a: a, b: b, c: c, d: d), carry)
        }

        private static func subtract(_ x: F, _ y: F) -> (F, Bool) {
            var borrow = false
            func step(_ m: UInt64, _ n: UInt64) -> UInt64 {
                let (s1, o1) = m.subtractingReportingOverflow(n)
                let (s2, o2) = s1.subtractingReportingOverflow(borrow ? 1 : 0)
                borrow = o1 || o2
                return s2
            }
            let a = step(x.a, y.a), b = step(x.b, y.b), c = step(x.c, y.c), d = step(x.d, y.d)
            return (F(a: a, b: b, c: c, d: d), borrow)
        }

        static func + (x: F, y: F) -> F {
            let (sum, carry) = add(x, y)
            return carry || !sum.isBelowPrime ? subtract(sum, p).0 : sum
        }

        static func - (x: F, y: F) -> F {
            let (difference, borrow) = subtract(x, y)
            return borrow ? add(difference, p).0 : difference
        }

        static func * (x: F, y: F) -> F {
            let xs = [x.a, x.b, x.c, x.d], ys = [y.a, y.b, y.c, y.d]
            var wide = [UInt64](repeating: 0, count: 8)
            for i in 0..<4 {
                var carry: UInt64 = 0
                for j in 0..<4 {
                    let (high, low) = xs[i].multipliedFullWidth(by: ys[j])
                    let (s1, o1) = wide[i + j].addingReportingOverflow(low)
                    let (s2, o2) = s1.addingReportingOverflow(carry)
                    wide[i + j] = s2
                    carry = high &+ (o1 ? 1 : 0) &+ (o2 ? 1 : 0)
                }
                wide[i + 4] = carry
            }
            // 2^256 is 2^32 + 977 here, so the top half comes back in multiplied by that.
            let k: UInt64 = 0x1_0000_03D1
            var limbs = Array(wide[0..<4])
            var carry: UInt64 = 0
            for i in 0..<4 {
                let (high, low) = wide[i + 4].multipliedFullWidth(by: k)
                let (s1, o1) = limbs[i].addingReportingOverflow(low)
                let (s2, o2) = s1.addingReportingOverflow(carry)
                limbs[i] = s2
                carry = high &+ (o1 ? 1 : 0) &+ (o2 ? 1 : 0)
            }
            var (result, overflow) = add(F(a: limbs[0], b: limbs[1], c: limbs[2], d: limbs[3]), F(a: carry &* k, b: carry.multipliedFullWidth(by: k).high, c: 0, d: 0))
            if overflow { (result, overflow) = add(result, F(a: k, b: 0, c: 0, d: 0)) }
            return result.isBelowPrime ? result : subtract(result, p).0
        }

        func power(_ exponent: F) -> F {
            var out = F.one
            for byte in exponent.bytes {
                for shift in (0..<8).reversed() {
                    out = out * out
                    if byte >> UInt8(shift) & 1 == 1 { out = out * self }
                }
            }
            return out
        }
        var inverse: F { power(Self.pMinus2) }
        var root: F { power(Self.sqrtPower) }
    }

    // A point with its own denominator, so adding needs no division until the end. `z` zero is the point at infinity.
    private struct Point {
        var x: F, y: F, z: F

        static let infinity = Point(x: .one, y: .one, z: .zero)
        var isInfinity: Bool { z == .zero }

        // Formulas for a curve with a = 0, from the Explicit-Formulas Database (dbl-2009-l, add-2007-bl).
        var doubled: Point {
            if isInfinity { return self }
            let a = x * x, b = y * y, c = b * b
            let e0 = (x + b) * (x + b) - a - c
            let d = e0 + e0
            let e = a + a + a
            let f = e * e
            let x3 = f - d - d
            let c8 = { (v: F) -> F in let v2 = v + v, v4 = v2 + v2; return v4 + v4 }(c)
            return Point(x: x3, y: e * (d - x3) - c8, z: (y * z) + (y * z))
        }

        static func + (p: Point, q: Point) -> Point {
            if p.isInfinity { return q }
            if q.isInfinity { return p }
            let z1z1 = p.z * p.z, z2z2 = q.z * q.z
            let u1 = p.x * z2z2, u2 = q.x * z1z1
            let s1 = p.y * q.z * z2z2, s2 = q.y * p.z * z1z1
            if u1 == u2 { return s1 == s2 ? p.doubled : .infinity }
            let h = u2 - u1
            let i = (h + h) * (h + h)
            let j = h * i
            let r = (s2 - s1) + (s2 - s1)
            let v = u1 * i
            let x3 = r * r - j - v - v
            let s1j = s1 * j
            let z = ((p.z + q.z) * (p.z + q.z) - z1z1 - z2z2) * h
            return Point(x: x3, y: r * (v - x3) - s1j - s1j, z: z)
        }

        func times(_ scalar: Data) -> Point {
            var out = Point.infinity
            for byte in scalar {
                for shift in (0..<8).reversed() {
                    out = out.doubled
                    if byte >> UInt8(shift) & 1 == 1 { out = out + self }
                }
            }
            return out
        }

        // Plain x and y, as bytes.
        func encoded(compressed: Bool) throws -> Data {
            guard !isInfinity else { throw NotAKey() }
            let inverse = z.inverse, inverse2 = inverse * inverse
            let plainX = x * inverse2, plainY = y * inverse2 * inverse
            return compressed ? Data([plainY.isOdd ? 3 : 2]) + plainX.bytes : Data([4]) + plainX.bytes + plainY.bytes
        }

        // A key from outside: 33 or 65 bytes, and it must be on the curve.
        init(key: Data) throws {
            let bytes = [UInt8](key)
            guard let first = bytes.first else { throw NotAKey() }
            let px = F(bytes.dropFirst().prefix(32))
            guard px.isBelowPrime else { throw NotAKey() }
            let right = px * px * px + F(a: 7, b: 0, c: 0, d: 0)
            if bytes.count == 33, first == 2 || first == 3 {
                var py = right.root
                guard py * py == right else { throw NotAKey() }
                if py.isOdd != (first == 3) { py = F.zero - py }
                self.init(x: px, y: py, z: .one)
            } else if bytes.count == 65, first == 4 {
                let py = F(bytes.dropFirst(33))
                guard py.isBelowPrime, py * py == right else { throw NotAKey() }
                self.init(x: px, y: py, z: .one)
            } else {
                throw NotAKey()
            }
        }

        init(x: F, y: F, z: F) { self.x = x; self.y = y; self.z = z }
    }

    private static let generator = Point(
        x: F([0x79, 0xBE, 0x66, 0x7E, 0xF9, 0xDC, 0xBB, 0xAC, 0x55, 0xA0, 0x62, 0x95, 0xCE, 0x87, 0x0B, 0x07, 0x02, 0x9B, 0xFC, 0xDB, 0x2D, 0xCE, 0x28, 0xD9, 0x59, 0xF2, 0x81, 0x5B, 0x16, 0xF8, 0x17, 0x98]),
        y: F([0x48, 0x3A, 0xDA, 0x77, 0x26, 0xA3, 0xC4, 0x65, 0x5D, 0xA4, 0xFB, 0xFC, 0x0E, 0x11, 0x08, 0xA8, 0xFD, 0x17, 0xB4, 0x48, 0xA6, 0x85, 0x54, 0x19, 0x9C, 0x47, 0xD0, 0x8F, 0xFB, 0x10, 0xD4, 0xB8]),
        z: .one)
    private static let order: [UInt8] = [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE, 0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B, 0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41]

    static func newSecret() -> Data {
        while true {
            let bytes = SymmetricKey(size: .bits256).withUnsafeBytes { Array($0) }
            if bytes.contains(where: { $0 != 0 }), bytes.lexicographicallyPrecedes(order) { return Data(bytes) }
        }
    }

    static func publicKey(of secret: Data, compressed: Bool) throws -> Data {
        try generator.times(secret).encoded(compressed: compressed)
    }

    // The shared point of a secret and someone's public key, uncompressed.
    static func shared(_ secret: Data, _ publicKey: Data) throws -> Data {
        try Point(key: publicKey).times(secret).encoded(compressed: false)
    }
}

// Encryption to a public key, byte for byte what the eciesjs library does by default, which is what MetaMask uses: a new key
// per message, HKDF-SHA256 over its public key and the shared point, AES-256-GCM with a 16-byte nonce. On the wire: that
// public key (65 bytes), the nonce, the tag, the ciphertext.
enum ECIES {
    struct Unreadable: Error {}

    private static func key(ephemeral: Data, shared: Data) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ephemeral + shared), outputByteCount: 32)
    }

    static func seal(_ plain: Data, to publicKey: Data) throws -> Data {
        let secret = Secp256k1.newSecret()
        let ephemeral = try Secp256k1.publicKey(of: secret, compressed: false)
        let shared = try Secp256k1.shared(secret, publicKey)
        let nonce = Data((0..<16).map { _ in UInt8.random(in: .min ... .max) })
        let box = try AES.GCM.seal(plain, using: key(ephemeral: ephemeral, shared: shared), nonce: AES.GCM.Nonce(data: nonce))
        return ephemeral + nonce + box.tag + box.ciphertext
    }

    static func open(_ sealed: Data, with secret: Data) throws -> Data {
        guard sealed.count >= 65 + 16 + 16 else { throw Unreadable() }
        let bytes = Data(sealed)
        let ephemeral = bytes.prefix(65)
        let shared = try Secp256k1.shared(secret, ephemeral)
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: bytes.subdata(in: 65..<81)), ciphertext: bytes.subdata(in: 97..<bytes.count), tag: bytes.subdata(in: 81..<97))
        return try AES.GCM.open(box, using: key(ephemeral: ephemeral, shared: shared))
    }
}

@MainActor
final class MetaMaskConnect {
    // Kept so a payment needs one approval, and no second connecting.
    struct Session: Codable {
        var id: String
        var secret: Data
        var theirKey: Data
        var channel: String
        var address: String
        var expiresAt: Double
    }

    static var relayURL = "wss://mm-sdk-relay.api.cx.metamask.io/connection/websocket"
    // MetaMask's phone app has Solana's real network only; a test network needs its developer version.
    static let solana = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
    private static let stream = "metamask-multichain-provider"
    private static let answerTimeout: TimeInterval = 300

    private var socket: URLSessionWebSocketTask?
    private var ready = false
    private var connecting: Task<Void, Error>?
    private var lastCommand = 0
    private var replies: [Int: CheckedContinuation<[String: Any], Error>] = [:]
    private let clientId = UUID().uuidString.lowercased()
    private var lastNonce = 0
    private var seen: [String: Int] = [:]
    private var channels: [String] = []
    private var secret: Data?
    private var theirKey: Data?
    private var theirChannel: String?
    private var waiting: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var creatingSession: String?

    // MARK: Connecting and signing

    // A new session: `open` gets the link for MetaMask. Comes back when the person approved and came back here.
    func connect(open: @escaping (URL) -> Void) async throws -> Session {
        start()
        defer { finish() }
        let id = UUID().uuidString.lowercased()
        let secret = Secp256k1.newSecret()
        self.secret = secret
        let requestId = newRequestId()
        creatingSession = requestId
        let handshake = "handshake:\(id)"
        let link = try Self.connectLink([
            "sessionRequest": [
                "id": id, "mode": "trusted", "channel": handshake,
                "publicKeyB64": try Secp256k1.publicKey(of: secret, compressed: true).base64EncodedString(),
                // Longer than their own app's 60 seconds: MetaMask may ask to be unlocked first, and the wallet only checks it hasn't passed.
                "expiresAt": Int(Date().timeIntervalSince1970 * 1000) + Int(Self.answerTimeout * 1000),
                "initialMessage": ["type": "message", "payload": Self.envelope([
                    "jsonrpc": "2.0", "id": requestId, "method": "wallet_createSession",
                    "params": [
                        "optionalScopes": [Self.solana: ["methods": [String](), "notifications": [String](), "accounts": [String]()]],
                        // Tells the wallet this is Solana's kind of app; their own Solana library sends it too.
                        "sessionProperties": ["solana_accountChanged_notifications": true],
                    ] as [String: Any],
                ])] as [String: Any],
            ] as [String: Any],
            "metadata": [
                "dapp": ["name": "Drivezzz", "url": "https://drivezzz.s3rver.nl", "icon": "https://drivezzz.s3rver.nl/logo.png"],
                "sdk": ["version": "1.0.0", "platform": "ios"],
            ],
        ])
        let answer = try await ask(requestId) { [self] in
            try await ensureSocket()
            try await listen(to: handshake)
            WalletLog.note("asked MetaMask for Solana")
            open(link)
        }
        let result = try Self.result(of: answer)
        let scopes = result["sessionScopes"] as? [String: Any] ?? [:]
        // Chains only: an account's last part is its address.
        WalletLog.note("MetaMask's session came, with: \(scopes.keys.sorted().joined(separator: ", "))")
        let accounts = (scopes[Self.solana] as? [String: Any])?["accounts"] as? [String] ?? []
        guard let address = accounts.first?.split(separator: ":").last, let theirKey, let theirChannel else { throw WalletFailure.noSolanaAccount("MetaMask") }
        return Session(id: id, secret: secret, theirKey: theirKey, channel: theirChannel, address: String(address), expiresAt: Date().timeIntervalSince1970 + 30 * 86400)
    }

    // MetaMask signs a transaction and hands it back, to send on from our server.
    func signTransaction(_ transaction: Data, session: Session, open: @escaping (URL) -> Void) async throws -> Data {
        start()
        defer { finish() }
        secret = session.secret
        theirKey = session.theirKey
        let requestId = newRequestId()
        let request = Self.envelope([
            "jsonrpc": "2.0", "id": requestId, "method": "wallet_invokeMethod",
            "params": [
                "scope": Self.solana,
                "request": [
                    "method": "signTransaction",
                    "params": ["account": ["address": session.address], "transaction": transaction.base64EncodedString(), "scope": Self.solana] as [String: Any],
                ] as [String: Any],
            ] as [String: Any],
        ])
        let answer = try await ask(requestId) { [self] in
            try await ensureSocket()
            try await listen(to: session.channel)
            try await publish(["type": "message", "payload": request], on: session.channel)
            WalletLog.note("asked MetaMask to sign")
            if let link = URL(string: "metamask://connect/mwp?id=\(session.id)") { open(link) }
        }
        guard let signed = (try Self.result(of: answer)["signedTransaction"] as? String).flatMap({ Data(base64Encoded: $0) }) else { throw WalletFailure.unreadable }
        return signed
    }

    // Back from MetaMask: iOS may have cut the socket while we were away, without saying so. A new one finds what came in the meantime.
    func resume() {
        guard !waiting.isEmpty else { return }
        dropSocket()
        Task { try? await ensureSocket() }
    }

    // `reason` is what the person waiting gets; nothing means they stopped it themselves.
    func cancelWaiting(reason: Error = CancellationError()) {
        for (_, c) in waiting { c.resume(throwing: reason) }
        waiting = [:]
    }

    // MARK: The conversation

    private func start() {
        cancelWaiting()
        finish()
    }

    private func finish() {
        dropSocket()
        channels = []
        seen = [:]
        secret = nil
        theirKey = nil
        theirChannel = nil
        creatingSession = nil
    }

    private func newRequestId() -> String {
        "\(Int(Date().timeIntervalSince1970 * 1000))\(Int.random(in: 100...999))"
    }

    private static func envelope(_ data: [String: Any]) -> [String: Any] { ["name": stream, "data": data] }

    // The way their own library builds it: JSON, zlib-compressed, base64.
    private static func connectLink(_ request: [String: Any]) throws -> URL {
        let json = try JSONSerialization.data(withJSONObject: request)
        let packed = try (json as NSData).compressed(using: .zlib) as Data
        var (a, b): (UInt32, UInt32) = (1, 0)
        for byte in json { a = (a + UInt32(byte)) % 65521; b = (b + a) % 65521 }
        let adler = (b << 16) | a
        let zlib = Data([0x78, 0x9C]) + packed + Data((0..<4).map { UInt8(truncatingIfNeeded: adler >> UInt32(24 - $0 * 8)) })
        let encoded = zlib.base64EncodedString().addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
        guard let url = URL(string: "metamask://connect/mwp?p=\(encoded)&c=1") else { throw WalletFailure.unreadable }
        return url
    }

    private static func result(of answer: [String: Any]) throws -> [String: Any] {
        if let error = answer["error"] as? [String: Any] {
            let code = (error["code"] as? NSNumber)?.intValue ?? 0
            let text = error["message"] as? String ?? ""
            WalletLog.note("MetaMask said no: \(code) \(text)")
            // 4001 and 5000 are saying no, and a Solana no can lose its code on the way.
            if code == 4001 || code == 5000 || text.lowercased().contains("rejected") { throw WalletFailure.declined }
            throw WalletFailure.refused(text.isEmpty ? nil : text)
        }
        return answer["result"] as? [String: Any] ?? [:]
    }

    // Asks, and waits for the answer with this id. Registered before `begin` runs, so an answer can't come too early.
    private func ask(_ id: String, begin: @escaping () async throws -> Void) async throws -> [String: Any] {
        try await withCheckedThrowingContinuation { continuation in
            waiting[id] = continuation
            Task {
                do { try await begin() } catch { waiting.removeValue(forKey: id)?.resume(throwing: error) }
            }
            Task {
                try? await Task.sleep(for: .seconds(Self.answerTimeout))
                waiting.removeValue(forKey: id)?.resume(throwing: WalletFailure.refused(String(localized: "MetaMask didn’t answer in time. Try again.")))
            }
        }
    }

    private func publish(_ message: [String: Any], on channel: String) async throws {
        guard let theirKey else { throw WalletFailure.unreadable }
        let sealed = try ECIES.seal(JSONSerialization.data(withJSONObject: message), to: theirKey)
        lastNonce = max(lastNonce + 1, Int(Date().timeIntervalSince1970 * 1000))
        let envelope = try JSONSerialization.data(withJSONObject: ["clientId": clientId, "nonce": lastNonce, "payload": sealed.base64EncodedString()] as [String: Any])
        _ = try await command(["publish": ["channel": channel, "data": String(decoding: envelope, as: UTF8.self)]])
    }

    private func listen(to channel: String) async throws {
        if !channels.contains(channel) { channels.append(channel) }
        try await subscribe(channel)
    }

    private func subscribe(_ channel: String) async throws {
        do {
            _ = try await command(["subscribe": ["channel": channel, "recoverable": true, "positioned": true] as [String: Any]])
        } catch let error as RelayError where error.code == 105 {
            // Already subscribed: a new socket and a new channel crossed each other.
        }
        // What came while we weren't there, MetaMask's answer most of all.
        let history = try await command(["history": ["channel": channel, "limit": 50] as [String: Any]])
        for publication in history["publications"] as? [[String: Any]] ?? [] {
            if let data = publication["data"] as? String { await incoming(data, on: channel) }
        }
    }

    private func incoming(_ raw: String, on channel: String) async {
        guard let outer = (try? JSONSerialization.jsonObject(with: Data(raw.utf8))) as? [String: Any],
              let sender = outer["clientId"] as? String, sender != clientId,
              let nonce = (outer["nonce"] as? NSNumber)?.intValue,
              let payload = (outer["payload"] as? String).flatMap({ Data(base64Encoded: $0) }) else { return }
        // A new connection reads the history again.
        let from = "\(channel)|\(sender)"
        guard nonce > (seen[from] ?? 0) else { return }
        seen[from] = nonce
        guard let secret, let plain = try? ECIES.open(payload, with: secret),
              let message = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any] else { return }
        switch message["type"] as? String {
        case "handshake-offer":
            guard let offer = message["payload"] as? [String: Any], let channelId = offer["channelId"] as? String,
                  let key = (offer["publicKeyB64"] as? String).flatMap({ Data(base64Encoded: $0) }),
                  (try? Secp256k1.shared(secret, key)) != nil else { return }
            WalletLog.note("MetaMask opened the connection")
            theirKey = key
            theirChannel = "session:\(channelId)"
            try? await listen(to: "session:\(channelId)")
        case "message":
            guard let body = message["payload"] as? [String: Any], let data = body["data"] as? [String: Any] else { return }
            answered(data)
        default:
            return
        }
    }

    private func answered(_ data: [String: Any]) {
        if let id = data["id"], let c = waiting.removeValue(forKey: "\(id)") {
            c.resume(returning: data)
            return
        }
        // Their library counts this as the answer to creating a session too, in case it's the first to arrive.
        if data["method"] as? String == "wallet_sessionChanged", let creatingSession,
           let params = data["params"] as? [String: Any], let scopes = params["sessionScopes"] as? [String: Any],
           let accounts = (scopes[Self.solana] as? [String: Any])?["accounts"] as? [String], !accounts.isEmpty,
           let c = waiting.removeValue(forKey: creatingSession) {
            c.resume(returning: ["result": params])
        }
    }

    // MARK: The relay, a Centrifugo server: JSON commands with an id, and messages it pushes.

    private struct RelayError: LocalizedError {
        var code: Int
        var message: String
        var errorDescription: String? { String(localized: "MetaMask’s connection said: \(message)") }
    }

    private func ensureSocket() async throws {
        // One that's under way may just have been cut, by coming back from MetaMask: then it's this one's turn.
        while let connecting { _ = try? await connecting.value }
        if ready, socket?.state == .running { return }
        let attempt = Task { [self] in
            defer { connecting = nil }
            guard let url = URL(string: Self.relayURL) else { throw WalletFailure.unreadable }
            let task = URLSession.shared.webSocketTask(with: url)
            socket = task
            task.resume()
            receive(on: task)
            _ = try await command(["connect": ["name": "drivezzz"]])
            ready = true
            for channel in channels { try await subscribe(channel) }
        }
        connecting = attempt
        try await attempt.value
    }

    private func dropSocket() {
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        ready = false
        let failure = RelayError(code: 0, message: String(localized: "The connection was cut."))
        for (_, c) in replies { c.resume(throwing: failure) }
        replies = [:]
    }

    private func command(_ body: [String: Any]) async throws -> [String: Any] {
        lastCommand += 1
        let id = lastCommand
        var frame = body
        frame["id"] = id
        let text = String(decoding: try JSONSerialization.data(withJSONObject: frame), as: UTF8.self)
        guard let socket else { throw RelayError(code: 0, message: String(localized: "The connection was cut.")) }
        return try await withCheckedThrowingContinuation { continuation in
            replies[id] = continuation
            socket.send(.string(text)) { [weak self] error in
                guard let error else { return }
                Task { @MainActor in self?.replies.removeValue(forKey: id)?.resume(throwing: error) }
            }
            Task {
                try? await Task.sleep(for: .seconds(20))
                replies.removeValue(forKey: id)?.resume(throwing: RelayError(code: 0, message: String(localized: "No answer.")))
            }
        }
    }

    private func receive(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.socket === task else { return }
                switch result {
                case .success(let message):
                    // Listen on first: handling this one can wait for an answer, and that only comes through here.
                    self.receive(on: task)
                    switch message {
                    case .string(let text): await self.handle(text, task)
                    case .data(let data): await self.handle(String(decoding: data, as: UTF8.self), task)
                    @unknown default: break
                    }
                case .failure:
                    WalletLog.note("the connection to MetaMask’s relay was cut")
                    self.dropSocket()
                    // Someone is waiting: try again now, and resume() does when the app is back in front.
                    if !self.waiting.isEmpty {
                        try? await Task.sleep(for: .seconds(1))
                        try? await self.ensureSocket()
                    }
                }
            }
        }
    }

    // One frame can hold several messages, a line each.
    private func handle(_ text: String, _ task: URLSessionWebSocketTask) async {
        for line in text.split(separator: "\n") {
            guard let json = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any] else { continue }
            // An empty message is the relay's ping.
            if json.isEmpty {
                task.send(.string("{}")) { _ in }
            } else if let id = (json["id"] as? NSNumber)?.intValue, id != 0 {
                guard let reply = replies.removeValue(forKey: id) else { continue }
                if let error = json["error"] as? [String: Any] {
                    reply.resume(throwing: RelayError(code: (error["code"] as? NSNumber)?.intValue ?? 0, message: error["message"] as? String ?? ""))
                } else {
                    // The one key that isn't the id holds the answer.
                    reply.resume(returning: json.first(where: { $0.key != "id" })?.value as? [String: Any] ?? [:])
                }
            } else if let push = json["push"] as? [String: Any], let channel = push["channel"] as? String,
                      let publication = push["pub"] as? [String: Any], let data = publication["data"] as? String {
                await incoming(data, on: channel)
            }
        }
    }
}
