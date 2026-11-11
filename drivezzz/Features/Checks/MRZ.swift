import Foundation
import Vision

// The key that opens a passport or ID card chip: its document number, birth date and expiry, as in the MRZ (the two or three
// lines of letters and < at the bottom), each with its check digit (BAC or PACE, ICAO 9303).
nonisolated struct MRZKey: Equatable {
    var documentNumber: String  // as printed, letters and digits
    var birth: String           // YYMMDD
    var expiry: String          // YYMMDD

    var key: String {
        let number = documentNumber.uppercased().filter { $0.isLetter || $0.isNumber }
        let padded = number.count < 9 ? number + String(repeating: "<", count: 9 - number.count) : number
        return padded + Self.checkDigit(padded) + birth + Self.checkDigit(birth) + expiry + Self.checkDigit(expiry)
    }

    static func checkDigit(_ s: String) -> String {
        let weights = [7, 3, 1]
        var sum = 0
        for (i, c) in s.uppercased().enumerated() {
            let v: Int
            if c == "<" { v = 0 } else if let d = c.wholeNumberValue { v = d } else if let a = c.asciiValue, c.isLetter { v = Int(a) - 55 } else { v = 0 }
            sum += v * weights[i % 3]
        }
        return String(sum % 10)
    }

    // In the phone's own time zone, like the date pickers: UTC showed a date of birth a day early west of Greenwich.
    static let yymmdd: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyMMdd"
        return f
    }()

    // The day a YYMMDD means, at noon so no clock change moves it. "65" is 1965 for a birth date, never 2065.
    static func date(_ yymmdd: String, past: Bool) -> Date? {
        guard yymmdd.count == 6, let n = Int(yymmdd) else { return nil }
        let calendar = Calendar(identifier: .gregorian)
        var year = 2000 + n / 10000
        if past, year > calendar.component(.year, from: Date()) { year -= 100 }
        return calendar.date(from: DateComponents(year: year, month: n / 100 % 100, day: n % 100, hour: 12))
    }
}

// What the code on an ID says. The optional data, where older Dutch documents have the BSN, is never looked at: the chip doesn't
// need it, and a company may only use a BSN where a law allows it (docs/driver-checks-nl.md).
nonisolated struct MRZRead: Equatable {
    var number: String?
    var birth: String?          // YYMMDD
    var expiry: String?         // YYMMDD
    var surname: String?
    var givenNames: String?
    var nationality: String?

    var hasKey: Bool { number != nil && birth != nil && expiry != nil }
    var isEmpty: Bool { self == MRZRead() }
}

// One look at the lines: what it read, and which parts were a guess. A number that only fit its check digit with a look-alike
// swapped is one, and so is anything found only in text reading's second guesses. A guess can be right, but counts for less.
nonisolated struct MRZLook: Equatable {
    var read = MRZRead()
    var guessed: Set<String> = []
}

// Reading the lines by their places, as ICAO 9303 lays them out: TD3 (passports, two lines of 44) and TD1 (ID cards, three of 30).
// A place only for digits gets the digit a look-alike stands for, and the check digits say whether that was right. Text reading
// loses and adds fillers (<), so nothing leans on a line's length.
nonisolated enum MRZScan {
    private static let toDigit: [Character: Character] = ["O": "0", "Q": "0", "D": "0", "I": "1", "L": "1", "Z": "2", "A": "4", "S": "5", "G": "6", "T": "7", "B": "8"]
    private static let toLetter: [Character: Character] = ["0": "O", "1": "I", "2": "Z", "4": "A", "5": "S", "6": "G", "7": "T", "8": "B"]
    // In a document number, where letters and digits can both be: the ones the check digit can tell apart.
    private static let lookAlikes: [Character: Character] = ["O": "0", "0": "O", "Q": "0", "I": "1", "1": "I", "L": "1", "Z": "2", "2": "Z", "S": "5", "5": "S", "B": "8", "8": "B"]

    // Letters of other alphabets that look the same, which text reading sometimes gives for ours (an М in EMMA).
    private static let sameLooking: [Character: Character] = [
        "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "У": "Y", "І": "I",
        "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "к": "k",
        "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
    ]

    // Ours: a look-alike from another alphabet as the letter it looks like, and a letter with an accent (Ą) without it.
    private static func latin(_ c: Character) -> Character {
        if c.isASCII { return c }
        if let same = sameLooking[c] { return same }
        let plain = String(c).folding(options: .diacriticInsensitive, locale: nil)
        return plain.count == 1 && plain.first?.isASCII == true ? plain.first! : c
    }

    // Every place stays a place, whatever text reading made of it: only capitals, digits and < are on a code, so anything else was
    // a <, and a blurry < comes out as a small c, e, k or x.
    static func clean(_ line: String) -> [Character] {
        var out: [Character] = []
        for c in line.map(latin) {
            switch c {
            case " ": continue
            case "«", "≪", "《": out += ["<", "<"]
            case "Ø", "ø": out.append("0")
            case "c", "e", "k", "x": out.append("<")
            default:
                let upper = c.uppercased().first ?? c
                out.append(upper.isASCII && (upper.isLetter || upper.isNumber) ? upper : "<")
            }
        }
        return out
    }

    private static func digit(_ c: Character) -> Character? { c.isNumber ? c : toDigit[c] }

    private static func digits(_ part: ArraySlice<Character>) -> String? {
        let mapped = part.compactMap(digit)
        return mapped.count == part.count ? String(mapped) : nil
    }

    private static func isDate(_ yymmdd: String) -> Bool {
        guard let n = Int(yymmdd) else { return false }
        return (1...12).contains(n / 100 % 100) && (1...31).contains(n % 100)
    }

    // Dates a document can have: born before today, and valid until no longer than 15 years ago and no more than 12 years ahead
    // (an ID or passport is valid for 10). A misreading that slips past a check digit is mostly far outside that.
    private static func plausible(birth: String, expiry: String, today: Date) -> Bool {
        let calendar = Calendar(identifier: .gregorian)
        guard let born = MRZKey.date(birth, past: true), let until = MRZKey.date(expiry, past: false), born < today,
              let earliest = calendar.date(byAdding: .year, value: -15, to: today), let latest = calendar.date(byAdding: .year, value: 12, to: today)
        else { return false }
        return until > born && until >= earliest && until <= latest
    }

    // Birth date, its check digit, sex, expiry, its check digit: 15 places in a row, the same on a card and in a passport. Only where
    // they can be: at the start of a card's second line, or behind a passport's number and nationality (13 places in), with a
    // place or two for what text reading lost or added. The sex is M, F, X or <.
    private static func dates(in row: [Character], today: Date) -> (at: Int, birth: String, expiry: String)? {
        guard row.count >= 15 else { return nil }
        for at in [0, 1, 2] + Array(10...15) where at + 15 <= row.count {
            guard let birth = digits(row[at..<(at + 6)]), let expiry = digits(row[(at + 8)..<(at + 14)]), isDate(birth), isDate(expiry),
                  digit(row[at + 6]).map(String.init) == MRZKey.checkDigit(birth),
                  digit(row[at + 14]).map(String.init) == MRZKey.checkDigit(expiry),
                  "MFX<".contains(row[at + 7]), plausible(birth: birth, expiry: expiry, today: today) else { continue }
            return (at, birth, expiry)
        }
        return nil
    }

    // The number that fits its check digit: as read, or with one look-alike swapped, if only one such swap fits. More guessing than
    // that makes almost anything fit, and even one swap is a guess: a misread elsewhere can make the wrong swap fit by chance.
    // A Dutch number is two letters, six letters or digits and a digit, and never has an O.
    private static func number(_ part: ArraySlice<Character>, check: Character, dutch: Bool) -> (number: String, guessed: Bool)? {
        guard let c = digit(check).map(String.init) else { return nil }
        var read = Array(part)
        if dutch, read.count == 9 {
            read = read.map { $0 == "O" ? "0" : $0 }
            for i in 0...1 { read[i] = toLetter[read[i]] ?? read[i] }
            read[8] = digit(read[8]) ?? read[8]
        }
        func fits(_ chars: [Character]) -> Bool {
            guard MRZKey.checkDigit(String(chars)) == c else { return false }
            return !dutch || (chars[0].isLetter && chars[1].isLetter && chars[8].isNumber && !chars.contains("O") && !chars.contains("<"))
        }
        var found: [[Character]] = fits(read) ? [read] : []
        if found.isEmpty {
            for i in read.indices {
                guard let other = lookAlikes[read[i]] else { continue }
                var swapped = read
                swapped[i] = other
                if fits(swapped) { found.append(swapped) }
            }
        }
        guard found.count == 1 else { return nil }
        let number = String(found[0]).replacingOccurrences(of: "<", with: "")
        return number.count >= 6 ? (number, found[0] != read) : nil
    }

    // A card's first line: I<NLD, the number, its check digit. Text reading can lose the < after the I, so NLD says where it starts.
    private static func firstLine(_ row: [Character]) -> (number: String, guessed: Bool)? {
        guard row.count >= 14, "IAC1".contains(row[0]), row.contains(where: \.isNumber) else { return nil }
        let at = (1...3).first { String(row[$0..<($0 + 3)]) == "NLD" }.map { $0 + 3 }
        guard at != nil || row[1] == "<" else { return nil }     // not a passport's second line, whose number can start with an I
        let start = at ?? 5
        // A line cut short (text reading can stop halfway) has no number and check digit to read: past its end crashed the app.
        guard row.count >= start + 10 else { return nil }
        return number(row[start..<(start + 9)], check: row[start + 9], dutch: at != nil)
    }

    private static func country(_ part: ArraySlice<Character>) -> String? {
        let code = String(part.map { toLetter[$0] ?? $0 }).replacingOccurrences(of: "<", with: "")
        return !code.isEmpty && code.allSatisfy(\.isLetter) ? code : nil
    }

    // SURNAME<<GIVEN<NAMES, behind P<NLD in a passport. Text reading can lose the P<'s <, read it as a letter, or drop the fillers
    // at the end, so the line's length can't say which it is: a passport's line starts with P and its country (NLD, or the < after
    // the P). A filler at either end of a name, or two inside one, is no space in it: "LUCAS<MARIA<" is "LUCAS MARIA", the same
    // name as without the <, so the looks agree.
    // A names line ends in fillers, unless the names fill all of it: one that stops on a letter sooner was cut short by text reading
    // ("LUCAS<MAR"), and gave the wrong given names half the time against one in ten for a whole line, so it isn't used.
    private static func names(_ row: [Character]) -> (surname: String, given: String)? {
        guard row.filter(\.isNumber).count <= 1, row.last == "<" || row.count >= 30 else { return nil }
        var chars = row.map { toLetter[$0] ?? $0 }
        if chars.count > 5, chars[0] == "P", chars[1] == "<" {
            chars.removeFirst(5)
        } else if chars.count > 5, chars[0] == "P", let nld = (1...2).first(where: { String(chars[$0..<($0 + 3)]) == "NLD" }) {
            chars.removeFirst(nld + 3)
        } else if chars.count > 30 {        // longer than a card's line: a passport's, whose P was lost too, or read as a letter
            if let nld = (0...2).first(where: { String(chars[$0..<($0 + 3)]) == "NLD" }) { chars.removeFirst(nld + 3) }
            else if chars[0] == "P" { chars.removeFirst(5) }
        }
        // The fillers at the end read as K or C, as a blurry < looks like either: three or more of them can't end a name ("ARNOUDKKKKK"),
        // while one or two can ("ERIK<<<<").
        let filler: Set<Character> = ["<", "K", "C"]
        var end = chars.count
        while end > 0, filler.contains(chars[end - 1]) { end -= 1 }
        if chars[end...].filter({ $0 != "<" }).count >= 3 { chars.removeSubrange(end...) }
        let parts = String(chars).components(separatedBy: "<<").filter { !$0.isEmpty }
        guard parts.count >= 2 else { return nil }
        func tidy(_ part: String) -> String { part.split(separator: "<").joined(separator: " ") }
        let surname = tidy(parts[0]), given = tidy(parts[1])
        guard surname.count >= 2, given.count >= 2 else { return nil }
        return (surname, given)
    }

    // What one look at the lines gave.
    static func read(_ lines: [String]) -> MRZRead { look(lines).read }

    // The same, with which parts were guessed. Text reading's second guesses only fill in what its first reading didn't give.
    static func look(_ lines: [String], alternatives: [String] = [], today: Date = Date()) -> MRZLook {
        var out = parse(lines, today: today)
        guard !alternatives.isEmpty else { return out }
        let second = parse(alternatives, today: today)
        for (name, path) in MRZTally.fields where out.read[keyPath: path] == nil {
            guard let value = second.read[keyPath: path] else { continue }
            out.read[keyPath: path] = value
            out.guessed.insert(name)
        }
        return out
    }

    // Earlier lines are the likelier reading, so they aren't overwritten.
    private static func parse(_ lines: [String], today: Date) -> MRZLook {
        var out = MRZLook()
        func take(number found: (number: String, guessed: Bool)) {
            guard out.read.number == nil else { return }
            out.read.number = found.number
            if found.guessed { out.guessed.insert("number") }
        }
        for row in lines.map(clean) where row.count >= 14 {
            if let n = firstLine(row) {
                take(number: n)
            } else if let (at, birth, expiry) = dates(in: row, today: today) {
                out.read.birth = out.read.birth ?? birth
                out.read.expiry = out.read.expiry ?? expiry
                if at >= 10 {           // a passport: the number and nationality come first
                    let nationality = country(row[(at - 3)..<at])
                    out.read.nationality = out.read.nationality ?? nationality
                    if at >= 13, let n = number(row[(at - 13)..<(at - 4)], check: row[at - 4], dutch: nationality == "NLD") { take(number: n) }
                } else if row.count >= at + 18 {
                    out.read.nationality = out.read.nationality ?? country(row[(at + 15)..<(at + 18)])
                }
            } else if let n = names(row) {
                out.read.surname = out.read.surname ?? n.surname
                out.read.givenNames = out.read.givenNames ?? n.given
            }
        }
        return out
    }

    // The text in a picture, line by line, and Vision's second guesses apart. The fillers can break a line in two, and two pieces
    // side by side at one height are one line. `region` is in the upright picture, measured from its bottom left.
    static func lines(in picture: VNImageRequestHandler, region: CGRect) -> (lines: [String], alternatives: [String]) {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["en-US"]
        request.usesLanguageCorrection = false
        request.regionOfInterest = region
        try? picture.perform([request])
        let found = request.results ?? []
        func sameLine(_ a: CGRect, _ b: CGRect) -> Bool {
            abs(a.midY - b.midY) < b.height / 2 && min(a.maxX, b.maxX) - max(a.minX, b.minX) < 0.02
        }
        var rows: [[VNRecognizedTextObservation]] = []
        for o in found.sorted(by: { $0.boundingBox.midY > $1.boundingBox.midY }) {
            if let last = rows.last, last.allSatisfy({ sameLine($0.boundingBox, o.boundingBox) }) {
                rows[rows.count - 1].append(o)
            } else {
                rows.append([o])
            }
        }
        let lines = rows.map { row in
            row.sorted { $0.boundingBox.minX < $1.boundingBox.minX }.compactMap { $0.topCandidates(1).first?.string }.joined()
        }
        return (lines, found.flatMap { $0.topCandidates(3).dropFirst().map(\.string) })
    }
}

// One picture can misread a character in a way its check digit misses, and pictures a moment apart are nearly the same picture,
// so they can be wrong the same way: two agreeing was too quick, and took wrong numbers and dates. A part of the key counts once
// it was read the same way in at least 6 looks (a guess counts for half a look) over at least two and a half seconds, and
// everything else it was read as adds up to no more than a quarter of that. So a scan takes a few seconds, on purpose. Every part is counted by itself: one picture may get the first
// line, the next the second. As Mrz.kt.
nonisolated struct MRZTally {
    static let fields: [(String, WritableKeyPath<MRZRead, String?>)] = [
        ("number", \.number), ("birth", \.birth), ("expiry", \.expiry), ("surname", \.surname), ("given", \.givenNames), ("nationality", \.nationality),
    ]
    static let key = ["number", "birth", "expiry"]
    static let pointsNeeded = 12        // 2 a look, 1 a guess
    static let secondsNeeded = 2.5

    private struct Votes { var points = 0, looks = 0, first: Double, last: Double }
    private var votes: [String: [String: Votes]] = [:]

    mutating func add(_ look: MRZLook, at time: Double) {
        for (name, path) in Self.fields {
            guard let value = look.read[keyPath: path] else { continue }
            var v = votes[name]?[value] ?? Votes(first: time, last: time)
            v.points += look.guessed.contains(name) ? 1 : 2
            v.looks += 1
            v.last = time
            votes[name, default: [:]][value] = v
        }
    }

    private func ranked(_ name: String) -> [(value: String, votes: Votes)] {
        var seen = votes[name] ?? [:]
        // A surname that's the end of another one read: text reading lost the start of the line ("DER" for MULDER), which Google's
        // reader does often in a blurry picture. It doesn't compete.
        if name == "surname" {
            let all = Array(seen.keys)
            for k in all where all.contains(where: { $0 != k && $0.hasSuffix(k) }) { seen[k] = nil }
        }
        return seen.sorted { ($0.value.points, $0.key) > ($1.value.points, $1.key) }.map { ($0.key, $0.value) }
    }

    // A part of the key, sure as above. The name has no check digit, and its misreadings (a filler read as a C or K) mostly differ
    // from each other: it's sure once one reading was seen 3 times and twice as often as any other. The app doesn't take the name
    // from the scan any more (the chip gives it exactly), so nothing waits for it.
    func isSure(_ name: String) -> Bool {
        let seen = ranked(name)
        guard let top = seen.first?.votes else { return false }
        let others = seen.dropFirst().reduce(0) { $0 + $1.votes.points }
        if Self.key.contains(name) {
            return top.points >= Self.pointsNeeded && top.last - top.first >= Self.secondsNeeded && others * 4 <= top.points
        }
        return top.looks >= 3 && top.points >= 2 * (seen.dropFirst().first?.votes.points ?? 0)
    }

    // The most seen of everything so far: what the screen shows while it's still looking.
    var read: MRZRead {
        var out = MRZRead()
        for (name, path) in Self.fields { out[keyPath: path] = ranked(name).first?.value }
        return out
    }

    // Only what's sure: what goes in the form.
    var confirmed: MRZRead {
        var out = MRZRead()
        for (name, path) in Self.fields where isSure(name) { out[keyPath: path] = ranked(name).first?.value }
        return out
    }

    var sure: Bool { Self.key.allSatisfy(isSure) }
}
