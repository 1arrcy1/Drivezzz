import CryptoKit
import Foundation
import Security

// End-to-end encryption of messages, the same as the server's src/e2e.js: keep the two byte-compatible.
//   - every account has an X25519 key pair on its phone: the private key stays there (iCloud Keychain, so a new iPhone on
//     the same Apple ID can read old messages), the public key goes to the server
//   - two people share a key: HKDF-SHA256(X25519(mine, theirs), salt "drivezzz-e2e-v1", info "chat|<lower key>|<higher key>")
//   - a message is sealed under it with AES-256-GCM: nonce | ciphertext | tag, base64
// The server only stores that. Reporting someone hands over the keys to that one chat, so the report can be read.
final class E2E {
    static let shared = E2E()

    enum Failure: LocalizedError {
        case notReady

        var errorDescription: String? { String(localized: "Encryption isn’t set up on this phone yet. Try again in a moment.") }
    }

    private struct Stored: Codable {
        var current: String
        var keys: [String: String]
    }

    private var accountId: String?
    private var keys: [String: Curve25519.KeyAgreement.PrivateKey] = [:]
    private var current: String?
    private var registered = false
    private static let salt = Data("drivezzz-e2e-v1".utf8)

    // Loads this account's key on this phone, makes one the first time, and tells the server.
    func prepare(accountId: String) async {
        if self.accountId != accountId { reset() }
        self.accountId = accountId
        if keys.isEmpty { load() }
        if current == nil {
            let key = Curve25519.KeyAgreement.PrivateKey()
            let id = key.publicKey.rawRepresentation.base64EncodedString()
            keys[id] = key
            current = id
            save()
        }
        guard !registered, let current else { return }
        if (try? await APIClient.shared.call("POST", "/api/me/key", ["publicKey": current])) != nil { registered = true }
    }

    func reset() {
        accountId = nil
        keys = [:]
        current = nil
        registered = false
    }

    func seal(_ text: String, to theirs: String) throws -> (body: String, senderKey: String) {
        guard let current, let key = chatKey(mine: current, theirs: theirs),
              let sealed = try AES.GCM.seal(Data(text.utf8), using: key).combined else { throw Failure.notReady }
        return (sealed.base64EncodedString(), current)
    }

    // The words of a message, or nil if this phone doesn't have the key to them.
    func open(_ message: ChatMessage) -> String? {
        guard let key = key(for: message), let raw = Data(base64Encoded: message.body),
              let box = try? AES.GCM.SealedBox(combined: raw), let plain = try? AES.GCM.open(box, using: key) else { return nil }
        return String(decoding: plain, as: UTF8.self)
    }

    // What a report hands over, so that this one chat can be read.
    func reportKeys(_ messages: [ChatMessage]) -> [String] {
        var out = Set<String>()
        for message in messages {
            if let key = key(for: message) { out.insert(key.withUnsafeBytes { Data($0) }.base64EncodedString()) }
        }
        return Array(out)
    }

    private func key(for message: ChatMessage) -> SymmetricKey? {
        if keys[message.senderKey] != nil { return chatKey(mine: message.senderKey, theirs: message.toKey) }
        if keys[message.toKey] != nil { return chatKey(mine: message.toKey, theirs: message.senderKey) }
        return nil
    }

    private func chatKey(mine: String, theirs: String) -> SymmetricKey? {
        guard let privateKey = keys[mine], let raw = Data(base64Encoded: theirs),
              let publicKey = try? Curve25519.KeyAgreement.PublicKey(rawRepresentation: raw),
              let secret = try? privateKey.sharedSecretFromKeyAgreement(with: publicKey) else { return nil }
        let info = "chat|" + [mine, theirs].sorted().joined(separator: "|")
        return secret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Self.salt, sharedInfo: Data(info.utf8), outputByteCount: 32)
    }

    private var keychainAccount: String { "account-\(accountId ?? "")" }

    private func load() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "eu.drivezzz.e2e",
            kSecAttrAccount as String: keychainAccount,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
              let stored = try? JSONDecoder().decode(Stored.self, from: data) else { return }
        for (id, raw) in stored.keys {
            if let bytes = Data(base64Encoded: raw), let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: bytes) { keys[id] = key }
        }
        current = keys[stored.current] != nil ? stored.current : nil
    }

    private func save() {
        guard let current else { return }
        let stored = Stored(current: current, keys: keys.mapValues { $0.rawRepresentation.base64EncodedString() })
        guard let data = try? JSONEncoder().encode(stored) else { return }
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "eu.drivezzz.e2e",
            kSecAttrAccount as String: keychainAccount,
            kSecAttrSynchronizable as String: kSecAttrSynchronizableAny,
        ]
        SecItemDelete(base as CFDictionary)
        // iCloud Keychain first, so a new iPhone on the same Apple ID reads old messages straight away.
        for sync in [true, false] {
            var add = base
            add[kSecAttrSynchronizable as String] = sync
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
            if SecItemAdd(add as CFDictionary, nil) == errSecSuccess { return }
        }
    }
}
