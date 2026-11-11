import Foundation
import CryptoKit

// Base58 (Solana's addresses and signatures) and NaCl's box: what Phantom-style wallet links encrypt with
// (X25519, then XSalsa20 and Poly1305). CryptoKit has X25519 but not the other two.
enum Base58 {
    private static let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".utf8)

    static func encode(_ data: Data) -> String {
        var digits = [UInt8]()
        for byte in data {
            var carry = Int(byte)
            for i in digits.indices {
                carry += Int(digits[i]) << 8
                digits[i] = UInt8(carry % 58)
                carry /= 58
            }
            while carry > 0 {
                digits.append(UInt8(carry % 58))
                carry /= 58
            }
        }
        let zeros = data.prefix { $0 == 0 }.count
        return String(repeating: "1", count: zeros) + String(decoding: digits.reversed().map { alphabet[Int($0)] }, as: UTF8.self)
    }

    static func decode(_ text: String) -> Data? {
        var bytes = [UInt8]()
        for char in text.utf8 {
            guard let value = alphabet.firstIndex(of: char) else { return nil }
            var carry = value
            for i in bytes.indices {
                carry += Int(bytes[i]) * 58
                bytes[i] = UInt8(carry & 0xff)
                carry >>= 8
            }
            while carry > 0 {
                bytes.append(UInt8(carry & 0xff))
                carry >>= 8
            }
        }
        let zeros = text.utf8.prefix { $0 == alphabet[0] }.count
        return Data(repeating: 0, count: zeros) + Data(bytes.reversed())
    }
}

enum NaCl {
    // crypto_box_beforenm: the key two sides share, from one's secret key and the other's public key.
    static func sharedKey(secret: Curve25519.KeyAgreement.PrivateKey, publicKey: Data) throws -> Data {
        let peer = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: publicKey)
        let shared = try secret.sharedSecretFromKeyAgreement(with: peer).withUnsafeBytes { Data($0) }
        return hsalsa20(key: shared, input: Data(repeating: 0, count: 16))
    }

    // crypto_box_afternm: tag, then ciphertext.
    static func seal(_ message: Data, nonce: Data, key: Data) -> Data {
        let (polyKey, cipher) = xsalsa(message, nonce: nonce, key: key)
        return poly1305(cipher, key: polyKey) + cipher
    }

    static func open(_ box: Data, nonce: Data, key: Data) -> Data? {
        guard box.count >= 16, nonce.count == 24 else { return nil }
        let bytes = Data(box)
        let tag = bytes.prefix(16)
        let cipher = Data(bytes.dropFirst(16))
        let (polyKey, plain) = xsalsa(cipher, nonce: nonce, key: key)
        // Constant time, as for any tag.
        let expected = poly1305(cipher, key: polyKey)
        guard zip(expected, tag).reduce(UInt8(0), { $0 | ($1.0 ^ $1.1) }) == 0 else { return nil }
        return plain
    }

    private static func xsalsa(_ input: Data, nonce: Data, key: Data) -> (polyKey: Data, output: Data) {
        let subkey = hsalsa20(key: key, input: nonce.prefix(16))
        let nonce8 = Data(nonce.dropFirst(16))
        var stream = Data()
        var counter: UInt64 = 0
        while stream.count < input.count + 32 {
            stream += salsa20Block(key: subkey, nonce: nonce8, counter: counter)
            counter += 1
        }
        let bytes = [UInt8](stream)
        var out = [UInt8](input)
        for i in out.indices { out[i] ^= bytes[i + 32] }
        return (Data(bytes.prefix(32)), Data(out))
    }

    private static func load32(_ b: [UInt8], _ i: Int) -> UInt32 {
        UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
    }
    private static let sigma: [UInt8] = Array("expand 32-byte k".utf8)

    private static func rounds(_ x: inout [UInt32]) {
        func r(_ a: Int, _ b: Int, _ c: Int, _ s: UInt32) {
            let v = x[b] &+ x[c]
            x[a] ^= (v << s) | (v >> (32 - s))
        }
        for _ in 0..<10 {
            r(4, 0, 12, 7); r(8, 4, 0, 9); r(12, 8, 4, 13); r(0, 12, 8, 18)
            r(9, 5, 1, 7); r(13, 9, 5, 9); r(1, 13, 9, 13); r(5, 1, 13, 18)
            r(14, 10, 6, 7); r(2, 14, 10, 9); r(6, 2, 14, 13); r(10, 6, 2, 18)
            r(3, 15, 11, 7); r(7, 3, 15, 9); r(11, 7, 3, 13); r(15, 11, 7, 18)
            r(1, 0, 3, 7); r(2, 1, 0, 9); r(3, 2, 1, 13); r(0, 3, 2, 18)
            r(6, 5, 4, 7); r(7, 6, 5, 9); r(4, 7, 6, 13); r(5, 4, 7, 18)
            r(11, 10, 9, 7); r(8, 11, 10, 9); r(9, 8, 11, 13); r(10, 9, 8, 18)
            r(12, 15, 14, 7); r(13, 12, 15, 9); r(14, 13, 12, 13); r(15, 14, 13, 18)
        }
    }

    private static func state(key: [UInt8], input: [UInt8]) -> [UInt32] {
        [load32(sigma, 0), load32(key, 0), load32(key, 4), load32(key, 8), load32(key, 12), load32(sigma, 4),
         load32(input, 0), load32(input, 4), load32(input, 8), load32(input, 12), load32(sigma, 8),
         load32(key, 16), load32(key, 20), load32(key, 24), load32(key, 28), load32(sigma, 12)]
    }

    private static func store(_ words: [UInt32]) -> Data {
        var out = Data(capacity: words.count * 4)
        for w in words { withUnsafeBytes(of: w.littleEndian) { out.append(contentsOf: $0) } }
        return out
    }

    private static func hsalsa20(key: Data, input: Data) -> Data {
        var x = state(key: [UInt8](key), input: [UInt8](input))
        rounds(&x)
        return store([x[0], x[5], x[10], x[15], x[6], x[7], x[8], x[9]])
    }

    private static func salsa20Block(key: Data, nonce: Data, counter: UInt64) -> Data {
        var input = [UInt8](nonce)
        withUnsafeBytes(of: counter.littleEndian) { input.append(contentsOf: $0) }
        let start = state(key: [UInt8](key), input: input)
        var x = start
        rounds(&x)
        return store(zip(x, start).map { $0 &+ $1 })
    }

    // poly1305-donna-32.
    private static func poly1305(_ message: Data, key: Data) -> Data {
        let k = [UInt8](key)
        let r0 = UInt64(load32(k, 0) & 0x3ffffff)
        let r1 = UInt64((load32(k, 3) >> 2) & 0x3ffff03)
        let r2 = UInt64((load32(k, 6) >> 4) & 0x3ffc0ff)
        let r3 = UInt64((load32(k, 9) >> 6) & 0x3f03fff)
        let r4 = UInt64((load32(k, 12) >> 8) & 0x00fffff)
        let s1 = r1 * 5, s2 = r2 * 5, s3 = r3 * 5, s4 = r4 * 5
        var h0: UInt64 = 0, h1: UInt64 = 0, h2: UInt64 = 0, h3: UInt64 = 0, h4: UInt64 = 0
        let bytes = [UInt8](message)
        var offset = 0
        while offset < bytes.count {
            var block = [UInt8](bytes[offset..<min(offset + 16, bytes.count)])
            let full = block.count == 16
            if !full { block.append(1) }
            while block.count < 16 { block.append(0) }
            offset += 16
            h0 += UInt64(load32(block, 0) & 0x3ffffff)
            h1 += UInt64((load32(block, 3) >> 2) & 0x3ffffff)
            h2 += UInt64((load32(block, 6) >> 4) & 0x3ffffff)
            h3 += UInt64((load32(block, 9) >> 6) & 0x3ffffff)
            h4 += UInt64(load32(block, 12) >> 8) + (full ? 1 << 24 : 0)
            let d0 = h0 * r0 + h1 * s4 + h2 * s3 + h3 * s2 + h4 * s1
            var d1 = h0 * r1 + h1 * r0 + h2 * s4 + h3 * s3 + h4 * s2
            var d2 = h0 * r2 + h1 * r1 + h2 * r0 + h3 * s4 + h4 * s3
            var d3 = h0 * r3 + h1 * r2 + h2 * r1 + h3 * r0 + h4 * s4
            var d4 = h0 * r4 + h1 * r3 + h2 * r2 + h3 * r1 + h4 * r0
            var c = d0 >> 26; h0 = d0 & 0x3ffffff
            d1 += c; c = d1 >> 26; h1 = d1 & 0x3ffffff
            d2 += c; c = d2 >> 26; h2 = d2 & 0x3ffffff
            d3 += c; c = d3 >> 26; h3 = d3 & 0x3ffffff
            d4 += c; c = d4 >> 26; h4 = d4 & 0x3ffffff
            h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff
            h1 += c
        }
        var c = h1 >> 26; h1 &= 0x3ffffff
        h2 += c; c = h2 >> 26; h2 &= 0x3ffffff
        h3 += c; c = h3 >> 26; h3 &= 0x3ffffff
        h4 += c; c = h4 >> 26; h4 &= 0x3ffffff
        h0 += c * 5; c = h0 >> 26; h0 &= 0x3ffffff
        h1 += c
        // Which is smaller, h or h − (2^130 − 5).
        var g0 = h0 &+ 5; c = g0 >> 26; g0 &= 0x3ffffff
        var g1 = h1 &+ c; c = g1 >> 26; g1 &= 0x3ffffff
        var g2 = h2 &+ c; c = g2 >> 26; g2 &= 0x3ffffff
        var g3 = h3 &+ c; c = g3 >> 26; g3 &= 0x3ffffff
        let g4 = h4 &+ c &- (1 << 26)
        let mask: UInt64 = (g4 >> 63) &- 1   // all ones when g4 didn't go below zero
        h0 = (h0 & ~mask) | (g0 & mask)
        h1 = (h1 & ~mask) | (g1 & mask)
        h2 = (h2 & ~mask) | (g2 & mask)
        h3 = (h3 & ~mask) | (g3 & mask)
        h4 = (h4 & ~mask) | (g4 & mask)
        let w0 = UInt32(truncatingIfNeeded: h0 | (h1 << 26))
        let w1 = UInt32(truncatingIfNeeded: (h1 >> 6) | (h2 << 20))
        let w2 = UInt32(truncatingIfNeeded: (h2 >> 12) | (h3 << 14))
        let w3 = UInt32(truncatingIfNeeded: (h3 >> 18) | (h4 << 8))
        var f = UInt64(w0) + UInt64(load32(k, 16))
        let t0 = UInt32(truncatingIfNeeded: f)
        f = UInt64(w1) + UInt64(load32(k, 20)) + (f >> 32)
        let t1 = UInt32(truncatingIfNeeded: f)
        f = UInt64(w2) + UInt64(load32(k, 24)) + (f >> 32)
        let t2 = UInt32(truncatingIfNeeded: f)
        f = UInt64(w3) + UInt64(load32(k, 28)) + (f >> 32)
        let t3 = UInt32(truncatingIfNeeded: f)
        return store([t0, t1, t2, t3])
    }
}
