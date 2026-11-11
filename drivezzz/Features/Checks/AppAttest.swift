import CryptoKit
import DeviceCheck
import Foundation

// Apple's App Attest: lets the server know the face match and what was read from a photo came from this app, unchanged, on a real
// iPhone (server/src/attest.js).
// A key in the Secure Enclave, certified by Apple once per account and server, then used to sign what's sent.
// Not on the simulator: there the server sends the result to a person instead.
enum AppAttest {
    static var supported: Bool { DCAppAttestService.shared.isSupported }

    private struct Challenge: Decodable { var id: String; var challenge: String }

    static func keyId(userId: String) async -> String? {
        guard supported else { return nil }
        let account = "attestKey.\(userId)"
        if let id = Keychain.read(account) { return id }
        do {
            let id = try await DCAppAttestService.shared.generateKey()
            let c: Challenge = try await APIClient.shared.post("/api/attest/challenge")
            let attestation = try await DCAppAttestService.shared.attestKey(id, clientDataHash: Data(SHA256.hash(data: Data(c.challenge.utf8))))
            let _: Empty = try await APIClient.shared.post("/api/attest/key", ["keyId": id, "attestation": attestation.base64EncodedString(), "challengeId": c.id])
            Keychain.write(account, id)
            return id
        } catch {
            return nil
        }
    }

    // For sending a photo with what was read from it. The lines are signed with the photo's hash after them, as signedByApp in
    // server/src/checks.js does. Empty where the phone can't: the server then asks a person.
    static func headers(signing lines: [String], photo: Data, userId: String?) async -> [String: String] {
        guard let userId, let keyId = await keyId(userId: userId) else { return [:] }
        let text = (lines + [hash(photo)]).joined(separator: "\n")
        guard let assertion = await sign(Data(text.utf8), keyId: keyId, userId: userId) else { return [:] }
        return ["X-Attest-Key": keyId, "X-Attest-Assertion": assertion]
    }

    static func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

    // Signs exactly these bytes; nil when it can't (the server then asks a person).
    static func sign(_ payload: Data, keyId: String, userId: String) async -> String? {
        do {
            return try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: Data(SHA256.hash(data: payload))).base64EncodedString()
        } catch {
            // A key Apple no longer knows (a restore to another phone): start again next time.
            Keychain.write("attestKey.\(userId)", nil)
            return nil
        }
    }
}
