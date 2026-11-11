import CoreNFC
import Foundation
import NFCPassportReader
import UIKit

// What the chip gave: the state's signed list (SOD), DG1 (who), DG15 (the chip's own key, when it has one) with its signature over
// our challenge, and the photo (DG2), which never leaves the phone: it's only for the face match.
struct ChipRead {
    var sod: Data
    var dg1: Data
    var dg15: Data?
    var aaSignature: Data?
    var photo: UIImage?
}

enum ChipError: LocalizedError {
    case notHere, wrongKey, lost, unreadable, cancelled

    var errorDescription: String? {
        switch self {
        case .notHere: String(localized: "This iPhone can’t read chips.")
        case .wrongKey: String(localized: "These details don’t open the chip. Check the document number and both dates.")
        case .lost: String(localized: "The chip was lost before it was read. Hold the phone still against it and try again.")
        case .unreadable: String(localized: "This chip couldn’t be read. Try again, or try your other document.")
        case .cancelled: nil
        }
    }
}

@MainActor
enum ChipReader {
    static var available: Bool { NFCTagReaderSession.readingAvailable }

    static func read(_ key: MRZKey, challenge: Data) async throws -> ChipRead {
        guard available else { throw ChipError.notHere }
        let reader = PassportReader()
        let model: NFCPassportModel
        do {
            // Only what's needed: not DG11 or DG12, which can hold the BSN or an address.
            model = try await reader.readPassport(mrzKey: key.key, tags: [.COM, .DG1, .DG2, .DG14, .DG15, .SOD], aaChallenge: [UInt8](challenge), customDisplayMessage: message)
        } catch let error as NFCPassportReaderError {
            switch error {
            case .UserCanceled: throw ChipError.cancelled
            case .InvalidMRZKey: throw ChipError.wrongKey
            case .ConnectionError, .TimeOutError, .NoConnectedTag, .TagNotValid: throw ChipError.lost
            case .NFCNotSupported: throw ChipError.notHere
            default: throw ChipError.unreadable
            }
        }
        guard let sod = model.getDataGroup(.SOD)?.data, let dg1 = model.getDataGroup(.DG1)?.data else { throw ChipError.unreadable }
        let signature = model.activeAuthenticationSignature
        return ChipRead(
            sod: Data(sod),
            dg1: Data(dg1),
            dg15: model.getDataGroup(.DG15).map { Data($0.data) },
            aaSignature: signature.isEmpty ? nil : Data(signature),
            photo: model.passportImage
        )
    }

    private static func message(_ m: NFCViewDisplayMessage) -> String? {
        switch m {
        case .requestPresentPassport: return String(localized: "Hold the top of your iPhone flat on your ID: a passport on its photo page, an ID card anywhere. Keep still.")
        case .authenticatingWithPassport(let p): return String(localized: "Opening the chip… \(p)%")
        case .readingDataGroupProgress(_, let p): return String(localized: "Reading… \(p)%")
        case .activeAuthentication: return String(localized: "Checking the chip…")
        case .successfulRead: return String(localized: "Done.")
        case .error: return String(localized: "That didn’t work.")
        @unknown default: return nil
        }
    }
}
