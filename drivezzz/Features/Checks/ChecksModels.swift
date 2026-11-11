import Foundation

// What the server knows about a driver's checks for driving a taxi in the Netherlands (server/src/checks.js).
// Every field optional, as everywhere: the app keeps working while the server changes.
struct DriverChecks: Codable, Equatable {
    var status: String?             // none, started, review, approved, declined
    var verified: Bool?
    var items: [String: String]?    // consent, id, face, chauffeurskaart, permit, kvk: missing, waiting, expired or done
    var consentVersion: Int?
    var id: CheckedID?
    var chauffeurskaart: CheckedDocument?
    var permit: CheckedDocument?
    var kvk: CheckedKvk?
    var note: String?
    var vehicles: [CheckedVehicle]?
    var fake: Bool?
    var open: [String]?             // until approved: what's still open, in the driver's words (publicChecks in checks.js)
    var again: String?              // what a person asked to have sent again (id, face, chauffeurskaart, permit, kvk), with `note`
    var renew: [String]?            // done rows that may be sent again all the same, as they run out within 30 days
    var retake: [String]?           // to send again by itself: a photo that couldn't be read, or a KvK number KvK doesn't know

    func item(_ key: String) -> String { items?[key] ?? "missing" }

    // "your taxi permit", for "A person asked you to send … again".
    var againWhat: String? { ChecksSummary.what(again) }
    var waitingForPerson: Bool { status == "review" }
}

// Driving in the Netherlands in short, in the driver's own data and in every sync (checksSummary in checks.js): for saying what
// still needs attention outside the checks (Pieter, 8 November 2026).
struct ChecksSummary: Codable, Equatable {
    var status: String?
    var open: Int?
    var again: String?

    // Nil when there's nothing to say.
    var attention: String? {
        if let what = Self.what(again) { return String(localized: "A person asked you to send \(what) again.") }
        let n = open ?? 0
        let things = n == 1 ? String(localized: "1 thing needs") : String(localized: "\(n) things need")
        switch status {
        case "declined": return String(localized: "Not approved. Open it to see why.")
        case "review": return n > 0 ? String(localized: "A person checks your documents. \(things) attention.") : String(localized: "A person checks your documents.")
        case "started" where n > 0: return String(localized: "\(things) attention.")
        default: return nil
        }
    }

    static func what(_ again: String?) -> String? {
        switch again {
        case nil: return nil
        case "id": return String(localized: "your ID and a selfie")
        case "face": return String(localized: "your selfie")
        case "chauffeurskaart": return String(localized: "your chauffeurskaart")
        case "permit": return String(localized: "your taxi permit")
        case "kvk": return String(localized: "your KvK number")
        default: return "something"
        }
    }
}

struct CheckedID: Codable, Equatable {
    var surname: String?
    var givenNames: String?
    var birthDate: String?
    var expires: String?
    var docType: String?
    var country: String?
    var numberEnd: String?
}

struct CheckedDocument: Codable, Equatable {
    var number: String?
    var expires: String?
}

struct CheckedKvk: Codable, Equatable {
    var number: String?
    var name: String?
    var found: Bool?
}

struct CheckedVehicle: Codable, Equatable, Identifiable {
    var id: String
    var plate: String?
    var checkedAt: Double?
    var found: Bool?
    var taxi: Bool?
    var insured: Bool?
    var apkUntil: String?
    var exported: Bool?
    var plateSeen: Bool?            // its plate was read from its back photo, or a person looked instead

    var ok: Bool { found == true && taxi == true && insured == true && exported != true && plateSeen != false && (apkUntil ?? "") >= ChecksDate.today }
}

struct ChecksResponse: Codable {
    var checks: DriverChecks?
    var chip: ChipResult?
    var face: FaceResult?
}
struct ChipResult: Codable { var signed: Bool?; var live: Bool?; var country: String? }
struct FaceResult: Codable { var passed: Bool? }

struct CheckChallenge: Codable {
    var id: String
    var nonce: String
    var steps: [String]
}

enum ChecksDate {
    static var today: String { iso.string(from: Date()) }
    static let iso: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Europe/Amsterdam")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    static let shown: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "Europe/Amsterdam")   // the same as iso, or a date shows a day off elsewhere
        f.dateStyle = .medium
        return f
    }()
    static func show(_ iso: String?) -> String {
        guard let iso, let d = Self.iso.date(from: iso) else { return "–" }
        return shown.string(from: d)
    }
    // Day and month only, for a pill next to a title: "18 Nov".
    static let shownShort: DateFormatter = {
        let f = DateFormatter()
        f.timeZone = TimeZone(identifier: "Europe/Amsterdam")
        f.setLocalizedDateFormatFromTemplate("d MMM")
        return f
    }()
    static func showShort(_ iso: String?) -> String {
        guard let iso, let d = Self.iso.date(from: iso) else { return "–" }
        return shownShort.string(from: d)
    }
}
