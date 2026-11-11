import Foundation
import StoreKit

// The app's language, chosen at every launch before anything is shown (main.swift), with no switch in the app (Pieter, 10 November
// 2026): English, unless it came from the App Store in the Netherlands. With no App Store to ask (a simulator), the phone's region
// decides. Texts are in Localizable.xcstrings, and the server answers in the same language (Accept-Language, API.swift).
enum Lang {
    static let dutch: Bool = {
        #if DEBUG
        if let forced = UserDefaults.standard.string(forKey: "languageOverride") { return forced == "nl" }
        #endif
        if let country = SKPaymentQueue.default().storefront?.countryCode { return country == "NLD" }
        return Locale.current.region?.identifier == "NL"
    }()
    static var code: String { dutch ? "nl" : "en" }
    // For dates and the like: Dutch ones in Dutch, otherwise what the phone is set to.
    static let locale: Locale = dutch ? Locale(identifier: "nl_NL") : .current

    // iOS picks the texts from AppleLanguages when the app starts, so it's set before that.
    static func apply() { UserDefaults.standard.set([code], forKey: "AppleLanguages") }

    // 1.5 as people write it: 1,5 in Dutch.
    static func number(_ text: String) -> String { dutch ? text.replacingOccurrences(of: ".", with: ",") : text }
}

enum Fmt {
    static func eur(_ cents: Int?) -> String {
        guard let cents else { return "–" }
        return Lang.number(String(format: "€%.2f", Double(cents) / 100))
    }

    static func rate(_ cents: Int?) -> String {
        guard let cents else { return "–" }
        return Lang.number(String(format: "€%.2f", Double(cents) / 100))
    }

    static func km(_ metres: Int?) -> String {
        guard let metres else { return "–" }
        if metres < 1000 { return "\(metres) m" }
        return Lang.number(String(format: "%.1f km", Double(metres) / 1000))
    }

    static func minutes(_ seconds: Int?) -> String {
        guard let seconds else { return "–" }
        let m = max(1, Int((Double(seconds) / 60).rounded()))
        if m < 60 { return "\(m) min" }
        return String(localized: "\(m / 60) h \(m % 60) min")
    }

    static func time(_ date: Date) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(Lang.locale))
    }

    static func dayTime(_ date: Date) -> String {
        if Calendar.current.isDateInToday(date) { return String(localized: "Today \(time(date))") }
        if Calendar.current.isDateInTomorrow(date) { return String(localized: "Tomorrow \(time(date))") }
        return date.formatted(.dateTime.weekday(.abbreviated).day().month(.abbreviated).hour().minute().locale(Lang.locale))
    }

    static func stopwatch(_ seconds: Int) -> String {
        String(format: "%02d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
    }

    static func rating(_ rating: Double?, _ count: Int?) -> String {
        guard let rating, let count, count > 0 else { return String(localized: "New") }
        return Lang.number(String(format: "%.1f (%d)", rating, count))
    }

    static func shortAddress(_ address: String?) -> String {
        guard let address, address.count > 14 else { return address ?? "" }
        return "\(address.prefix(6))…\(address.suffix(6))"
    }

    static func amount(_ text: String?, _ symbol: String?) -> String {
        "\(text ?? "0") \(symbol ?? "")"
    }

    // What a ride comes to in its coin, to read at a glance: SOL to 5 decimals and USDC to cents, rounded up, so it's never less
    // than what the wallet asks. The server's amount is exact; the wallet shows all of it.
    static func coinAmount(_ text: String?, _ coin: String?) -> String {
        guard let text, let value = Decimal(string: text, locale: Locale(identifier: "en_US_POSIX")) else { return amount(text, coinSymbol(coin)) }
        let places = coin == "sol" ? 5 : 2
        var exact = value, rounded = Decimal()
        NSDecimalRound(&rounded, &exact, places, .up)
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = places
        f.minimumIntegerDigits = 1
        return "\(Lang.number(f.string(from: rounded as NSDecimalNumber) ?? text)) \(coinSymbol(coin))"
    }

    // A coin's price in euros, like €174.12.
    static func eurPrice(_ eur: Double?) -> String {
        guard let eur else { return "–" }
        return Lang.number(String(format: "€%.2f", eur))
    }

    static func people(_ n: Int?) -> String { (n ?? 1) == 1 ? String(localized: "1 person") : String(localized: "\(n ?? 1) people") }

    static func coinSymbol(_ id: String?) -> String {
        switch id {
        case "usdc-sol": "USDC"
        case "sol": "SOL"
        case "cash": String(localized: "Cash")
        case "xrp": "XRP"
        case "ltc": "LTC"
        case "xlm": "XLM"
        default: id?.uppercased() ?? ""
        }
    }

    // Words the server keeps in English, as its rules and the admin panel go by them (a reason to cancel or report, a car's colour and
    // body): shown in the app's language, sent as they are.
    static func reason(_ reason: String) -> String {
        switch reason {
        case "Alcohol abuse": String(localized: "Alcohol abuse")
        case "Misbehaviour": String(localized: "Misbehaviour")
        case "Rider not there": String(localized: "Rider not there")
        case "Car trouble": String(localized: "Car trouble")
        case "Other": String(localized: "Other")
        case "Unsafe driving": String(localized: "Unsafe driving")
        case "Harassment or abuse": String(localized: "Harassment or abuse")
        case "Offensive photo or text": String(localized: "Offensive photo or text")
        case "Fraud or wrong car": String(localized: "Fraud or wrong car")
        case "Impossible drop-off location": String(localized: "Impossible drop-off location")
        case "Something else": String(localized: "Something else")
        default: reason
        }
    }

    static func colour(_ name: String?) -> String {
        switch name {
        case "Black": String(localized: "Black")
        case "White": String(localized: "White")
        case "Grey": String(localized: "Grey")
        case "Silver": String(localized: "Silver")
        case "Blue": String(localized: "Blue")
        case "Red": String(localized: "Red")
        case "Green": String(localized: "Green")
        case "Yellow": String(localized: "Yellow")
        case "Orange": String(localized: "Orange")
        case "Brown": String(localized: "Brown")
        case "Beige": String(localized: "Beige")
        case "Purple": String(localized: "Purple")
        case "Pink": String(localized: "Pink")
        case "Cream": String(localized: "Cream")
        default: name ?? ""
        }
    }

    // "Black Toyota Prius": a colour before a car's name, which Dutch says differently from the colour alone (Zwarte, not Zwart).
    static func carWithColour(_ name: String?, _ title: String) -> String {
        let colour: String = switch name {
        case "Black": String(localized: "car.black", defaultValue: "Black")
        case "White": String(localized: "car.white", defaultValue: "White")
        case "Grey": String(localized: "car.grey", defaultValue: "Grey")
        case "Silver": String(localized: "car.silver", defaultValue: "Silver")
        case "Blue": String(localized: "car.blue", defaultValue: "Blue")
        case "Red": String(localized: "car.red", defaultValue: "Red")
        case "Green": String(localized: "car.green", defaultValue: "Green")
        case "Yellow": String(localized: "car.yellow", defaultValue: "Yellow")
        case "Orange": String(localized: "car.orange", defaultValue: "Orange")
        case "Brown": String(localized: "car.brown", defaultValue: "Brown")
        case "Beige": String(localized: "car.beige", defaultValue: "Beige")
        case "Purple": String(localized: "car.purple", defaultValue: "Purple")
        case "Pink": String(localized: "car.pink", defaultValue: "Pink")
        case "Cream": String(localized: "car.cream", defaultValue: "Cream")
        default: name ?? ""
        }
        return colour.isEmpty ? title : "\(colour) \(title)"
    }

    // A photo a vehicle still needs, as the server names it.
    static func photoSide(_ side: String) -> String {
        switch side {
        case "front": String(localized: "front")
        case "back": String(localized: "back")
        case "inside": String(localized: "inside")
        default: side
        }
    }

    static func carBody(_ body: String?) -> String? {
        switch body {
        case nil: nil
        case "hatchback": String(localized: "Hatchback")
        case "sedan": String(localized: "Sedan")
        case "estate": String(localized: "Estate")
        case "suv": "SUV"
        case "mpv": "MPV"
        case "van": String(localized: "Van")
        default: body?.capitalized
        }
    }

    static func coinName(_ id: String?) -> String {
        id == "usdc-sol" ? String(localized: "USDC on Solana") : coinSymbol(id)
    }
}

// A car, a motor or a scooter.
enum Vehicle {
    static let all = ["car", "motor", "scooter"]
    static func name(_ kind: String?) -> String {
        switch kind {
        case "motor": String(localized: "Motor")
        case "scooter": String(localized: "Scooter")
        default: String(localized: "Car")
        }
    }
    static func icon(_ kind: String?) -> String {
        switch kind {
        case "motor": "motorcycle.fill"
        case "scooter": "scooter"
        default: "car.side.fill"
        }
    }
    // "Only check in when you're in the car."
    static func riding(_ kind: String?) -> String {
        switch kind {
        case "motor": String(localized: "on the motor")
        case "scooter": String(localized: "on the scooter")
        default: String(localized: "in the car")
        }
    }
}

// Google's polyline format, as the server sends routes.
enum Polyline {
    static func decode(_ text: String?) -> [(lat: Double, lng: Double)] {
        guard let bytes = text?.utf8.map({ Int($0) }) else { return [] }
        var out: [(Double, Double)] = []
        var i = 0, lat = 0, lng = 0
        func next() -> Int {
            var shift = 0, result = 0, b = 0
            repeat {
                guard i < bytes.count else { return 0 }
                b = bytes[i] - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
            } while b >= 0x20
            return (result & 1) != 0 ? ~(result >> 1) : result >> 1
        }
        while i < bytes.count {
            lat += next()
            lng += next()
            out.append((Double(lat) / 1e5, Double(lng) / 1e5))
        }
        return out
    }
}

extension Date {
    init(ms: Double) { self.init(timeIntervalSince1970: ms / 1000) }
    var ms: Double { timeIntervalSince1970 * 1000 }
}
