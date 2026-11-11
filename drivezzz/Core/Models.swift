import CoreLocation
import Foundation

// What the server sends. Everything but the ids is optional, so the app keeps working while the server changes.

struct User: Codable, Equatable {
    var id: String
    var name: String
    var email: String?
    var hasLogin: Bool?
    var isDriver: Bool?
    var demo: Bool?
    var createdAt: Double?
}

// The End User Licence Agreement, as the website has it. A block's text has Markdown for bold and links.
struct Eula: Codable, Equatable {
    var version: Int
    var updated: String?
    var short: [Block]?
    var sections: [Section]?

    struct Section: Codable, Equatable, Identifiable {
        var id: String
        var title: String
        var blocks: [Block]
    }

    struct Block: Codable, Equatable {
        var text: String
        var bullet: Bool?
    }
}

struct BlockedPerson: Codable, Identifiable, Hashable {
    var id: String
    var name: String?
    var at: Double?
}

struct BlocksResponse: Codable { var blocks: [BlockedPerson]? }

struct Strike: Codable, Identifiable, Hashable {
    var id: String
    var reason: String?
    var at: Double?
}

struct Appeal: Codable, Identifiable, Hashable {
    var id: String
    var message: String?
    var at: Double?
    var status: String?
    var answer: String?
}

struct Ban: Codable, Hashable {
    var id: String?
    var kind: String?
    var reason: String?
    var at: Double?
    var endsAt: Double?
    var decided: Bool?
    var answer: String?
    var canAppeal: Bool?
    var nextAppealAt: Double?
    var appeals: [Appeal]?
}

struct Standing: Codable, Hashable {
    var strikes: Int?
    var maxStrikes: Int?
    var strikeList: [Strike]?
    var ban: Ban?
}

struct AuthResponse: Codable {
    var token: String?
    var user: User
    var standing: Standing?
    var isNew: Bool?
}

struct MeResponse: Codable {
    var user: User
    var standing: Standing?
}

struct CarPhoto: Codable, Identifiable, Hashable {
    var id: String
    var kind: String?
    var url: String?
}

struct Car: Codable, Identifiable, Hashable {
    var id: String
    var vehicle: String?
    var plate: String
    var platePretty: String?
    var make: String?
    var model: String?
    var colorName: String?
    var colorHex: String?
    var body: String?
    var seats: Int?
    var year: Int?
    var verified: Bool?
    var perKmCents: Int?
    var perMinCents: Int?
    var pickupPerKmCents: Int?
    var petsAllowed: Bool?
    var photos: [CarPhoto]?
    var photosMissing: [String]?    // which of front, back and inside it still needs before it can drive
    var hold: CarHold?              // the driver's own: what still stops it in the Netherlands, if anything

    var priceLine: String { String(localized: "\(Fmt.rate(perKmCents))/km · \(Fmt.rate(perMinCents))/min · \(Fmt.rate(pickupPerKmCents))/km to pickup") }
    var kind: String { vehicle ?? "car" }
    var title: String {
        let name = [make, model].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        return name.isEmpty ? Vehicle.name(kind) : name
    }
    var shownPlate: String { platePretty ?? plate }
}

// What still stops a car of the driver's in the Netherlands (carHold in server/src/checks.js): its first RDW problem, or its plate
// waiting for a person because it couldn't be read from the back photo. `review`: only a person looking is left.
struct CarHold: Codable, Hashable {
    var code: String?
    var text: String?
    var review: Bool?

    var plate: Bool { code == "plate" }
}

struct PlateLookup: Codable {
    var found: Bool?
    var car: PlateCar?
}

struct PlateCar: Codable {
    var vehicle: String?
    var plate: String?
    var make: String?
    var model: String?
    var colorName: String?
    var colorHex: String?
    var body: String?
    var seats: Int?
    var year: Int?
    var verified: Bool?
}

struct DriverCard: Codable, Identifiable, Hashable {
    var id: String
    var completedPercent: Int?
    var name: String?
    var lat: Double?
    var lng: Double?
    var heading: Double?
    var online: Bool?
    var busy: Bool?
    var distanceM: Int?
    var perKmCents: Int?
    var perMinCents: Int?
    var pickupPerKmCents: Int?
    var petsAllowed: Bool?
    var allowsPlanning: Bool?
    var verified: Bool?             // ID, face, chauffeurskaart and permit checked, in the Netherlands
    var car: Car?
    var coins: [String]?
    var rating: Double?
    var ratingCount: Int?
    var arrivalScore: Int?
    var arrivals: Int?
    var averageLateS: Int?
    // In a quote.
    var priceCents: Int?
    var pickupM: Int?
    var pickupS: Int?
    var afterAnotherDrive: Bool?
    // On a profile.
    var bio: String?
    var ridesDone: Int?

    var coordinate: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }

    // What they ask for a 10 km ride of 20 minutes, with their way to you: cheapest, before there's a destination. As on the server (`askingCents`).
    var askingCents: Int {
        let way = Double(distanceM ?? 0) / 1000 * Double(pickupPerKmCents ?? 0)
        return Int(way) + 10 * (perKmCents ?? 0) + 20 * (perMinCents ?? 0)
    }
}

// `total`: how many are online, of which `drivers` are the first, in the order the rider asked for.
struct DriversResponse: Codable { var drivers: [DriverCard]?; var total: Int? }

// What a rider sees first, on the map and in the lists. The server decides who makes the list; this keeps them in that order.
enum DriverSort: String, CaseIterable, Identifiable {
    case cheapest, stars, fastest, onTime

    var id: String { rawValue }
    var name: String {
        switch self {
        case .cheapest: String(localized: "Cheapest")
        case .stars: String(localized: "Best rated")
        case .fastest: String(localized: "Fastest")
        case .onTime: String(localized: "On time")
        }
    }
    var listTitle: String {
        switch self {
        case .cheapest: String(localized: "Cheapest near you")
        case .stars: String(localized: "Best rated near you")
        case .fastest: String(localized: "Fastest to you")
        case .onTime: String(localized: "Most on time")
        }
    }

    // Many reviews count for more than a few: one 5-star review shouldn't beat 400 of 4.9. Nothing to go on comes last. As on the server (`trusted`).
    private func trusted(_ score: Double?, _ count: Int?, usual: Double) -> Double {
        guard let score, let count, count > 0 else { return -1 }
        return (score * Double(count) + usual * 3) / Double(count + 3)
    }

    func sorted(_ list: [DriverCard]) -> [DriverCard] {
        let price = { (d: DriverCard) in d.priceCents ?? d.askingCents }
        return list.sorted { a, b in
            let order: (Double, Double)
            switch self {
            case .cheapest: order = (Double(price(a)), Double(price(b)))
            case .stars: order = (-trusted(a.rating, a.ratingCount, usual: 4), -trusted(b.rating, b.ratingCount, usual: 4))
            case .fastest: order = (Double(a.pickupS ?? a.distanceM ?? .max), Double(b.pickupS ?? b.distanceM ?? .max))
            case .onTime: order = (-trusted(a.arrivalScore.map(Double.init), a.arrivals, usual: 80), -trusted(b.arrivalScore.map(Double.init), b.arrivals, usual: 80))
            }
            return order.0 != order.1 ? order.0 < order.1 : price(a) < price(b)
        }
    }
}

struct DriverReview: Codable, Hashable {
    var stars: Int?
    var text: String?
    var at: Double?
}

struct BusyTime: Codable, Hashable {
    var from: Double?
    var to: Double?
}

struct Availability: Codable, Hashable {
    var lastOnlineAt: Double?
    var bookable: Bool?
    var allowsPlanning: Bool?
    var planDays: Int?
    var busy: [BusyTime]?
    var usualHoursUtc: [Double]?
}

struct DriverProfile: Codable {
    var driver: DriverCard
    var reviews: [DriverReview]?
    var availability: Availability?
}

struct OwnDriver: Codable, Equatable {
    var allowsPlanning: Bool?
    var planDays: Int?
    var maxPlanDays: Int?
    var perKmCents: Int?
    var perMinCents: Int?
    var pickupPerKmCents: Int?
    var petsAllowed: Bool?
    var bio: String?
    // When the app told them that licences, permits and insurance are up to them.
    var rulesSeenAt: Double?
    var verified: Bool?             // their checks for driving in the Netherlands went through and nothing ran out
    var checks: ChecksSummary?      // those checks in short: what still needs attention
    var activeCarId: String?
    var online: Bool?
    var onlineSince: Double?
    var putOffline: Bool?           // for not answering a ride; stays so until they go online themselves
    var cars: [Car]?
    var rating: Double?
    var ratingCount: Int?
    var arrivalScore: Int?
    var arrivals: Int?
    var averageLateS: Int?
    var completedPercent: Int?
    var ridesDone: Int?

    var activeCar: Car? { cars?.first { $0.id == activeCarId } }
}

struct OwnDriverResponse: Codable {
    var driver: OwnDriver?
    var car: Car?
}

struct AreaPrices: Codable, Equatable {
    var driversOnline: Int?
    var cheapestPerKmCents: Int?
    var middlePerKmCents: Int?
    var cheapestPerMinCents: Int?
    var middlePerMinCents: Int?
}

struct DriverHome: Codable {
    var earnedTodayCents: Int?
    var ridesToday: Int?
    var earnedTotalCents: Int?
    var ridesTotal: Int?
    var pendingCents: Int?
    var onTimePercent: Int?
    var acceptancePercent: Int?
    var area: AreaPrices?
    var planned: [Ride]?
}

struct Place: Codable, Hashable {
    var lat: Double
    var lng: Double
    var label: String?
    var movedM: Int?
    var road: String?

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
    var json: [String: Any] {
        var out: [String: Any] = ["lat": lat, "lng": lng]
        if let label { out["label"] = label }
        if let movedM { out["movedM"] = movedM }
        return out
    }
}

struct Quote: Codable {
    var pickup: Place
    var dropoff: Place
    var polyline: String?
    var distanceM: Int?
    var durationS: Int?
    var estimated: Bool?
    var scheduledAt: Double?
    var offers: [DriverCard]?
    var suggestedBidCents: Int?
    var autoCushion: Double?
}

struct RideDriver: Codable, Hashable {
    var id: String
    var name: String?
    var car: Car?
    var rating: Double?
    var ratingCount: Int?
    var arrivalScore: Int?
    var lat: Double?
    var lng: Double?
    var heading: Double?
    var locAt: Double?

    var coordinate: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

struct RideRider: Codable, Hashable {
    var id: String
    var name: String?
    var lat: Double?
    var lng: Double?
    var locAt: Double?

    var coordinate: CLLocationCoordinate2D? {
        guard let lat, let lng else { return nil }
        return CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}

struct RidePayout: Codable, Hashable {
    var status: String?
    var dueAt: Double?
    var txid: String?
    var amount: String?
    var eurCents: Int?
}

// The ride's money in its escrow on Solana: paid, then settled as pay out, split or refund.
struct RideEscrow: Codable, Hashable {
    var status: String?
    var outcome: String?
    var settleAfter: Double?
    var onHold: Bool?               // an admin is checking this ride
    var coin: String?
    var amount: String?
    var feeAmount: String?
    var driverAmount: String?
    var address: String?
    var explorer: String?
    var settleExplorer: String?
}

struct RideReview: Codable, Hashable {
    var stars: Int?
    var text: String?
}

struct RideDispute: Codable, Hashable {
    var status: String?
    var answer: String?
    var message: String?
    var at: Double?
}

struct Ride: Codable, Identifiable, Hashable {
    var id: String
    var status: String
    var mode: String?
    var scheduledAt: Double?
    var role: String?
    var pickup: Place
    var dropoff: Place
    var polyline: String?
    var distanceM: Int?
    var durationS: Int?
    var passengers: Int?
    var pets: Bool?
    var vehicle: String?
    var priceCents: Int?
    var maxCents: Int?
    var coin: String?
    var coinAmount: String?
    var feeCents: Int?              // Drivezzz's part of a ride paid out in full, from the driver's payout
    var refundPercent: Int?         // for the rider: what cancelling now gives back
    var freeCancelUntil: Double?    // a planned ride with a driver is free to cancel until then
    var createdAt: Double?
    var acceptedAt: Double?
    var arrivedAt: Double?
    var pickupEtaAt: Double?
    var pickupDeadlineAt: Double?   // the driver's time to reach the pickup; past it a rider cancels for free
    var driverLate: Bool?           // past that time and not at the pickup
    var driverEtaS: Int?            // how long the driver still needs to the pickup
    var noShowFrom: Double?         // a driver waiting at the pickup can cancel for half the price from then
    var pickupM: Int?
    var checkedInAt: Double?
    var checkedOutAt: Double?
    var cancelledAt: Double?
    var cancelledBy: String?
    var cancelReason: String?
    var offeredUntil: Double?
    var syncScore: Double?
    var reviewRequired: Bool?
    var now: Double?
    var driver: RideDriver?
    var rider: RideRider?
    var apartM: Int?
    var canCheckIn: Bool?
    var driverToDropoffM: Int?
    var riderToDropoffM: Int?
    var driverToPickupM: Int?       // for the rider, while the driver comes: how far they still are, in a straight line
    var checkOutM: Int?             // for the driver on the ride: check-out opens this close to the drop-off
    var safetyAsked: Bool?
    // Paying: once a driver has it, until payBy, through a Solana Pay link that opens the rider's wallet.
    var payBy: Double?
    var payUrl: String?
    var payAmount: String?          // what it comes to in the coin: what the wallet was asked for, or at the latest price
    var eurPerCoin: Double?         // the price that amount is at
    var testPay: Bool?              // a test server with no chain: paying is pretended, no wallet can do it there
    var network: String?            // of a ride waiting to be paid: mainnet or testnet
    var escrow: RideEscrow?
    var checkoutWarning: Bool?      // the rider's phone wasn't near the drop-off at check-out
    var payout: RidePayout?
    var review: RideReview?
    var dispute: RideDispute?

    var isLive: Bool { ["accepted", "arrived", "riding"].contains(status) }
    var isOver: Bool { ["completed", "cancelled"].contains(status) }
    var isWaiting: Bool { ["searching", "awaiting_payment", "offered", "open"].contains(status) }
    var needsPayment: Bool { status == "awaiting_payment" }
    var isCash: Bool { coin == Coins.cash }
    var shownPriceCents: Int? { priceCents ?? maxCents }
    // How long until the driver is at the pickup, for the map and the ride's page.
    var etaShort: String? { driverEtaS.map { $0 < 60 ? String(localized: "Almost there") : Fmt.minutes($0) } }
    var etaLine: String? { driverEtaS.map { $0 < 60 ? String(localized: "Your driver is almost there") : String(localized: "Your driver is about \(Fmt.minutes($0)) away") } }
    // While the driver comes: how long and how far, which changes with each of their positions (every 5 seconds on the way).
    var comingLine: String? {
        guard ["accepted", "awaiting_payment"].contains(status) else { return nil }
        let far = driverToPickupM.map { Fmt.km($0) }
        switch (etaShort, far) {
        case let (eta?, far?): return eta == String(localized: "Almost there") ? String(localized: "Almost there · \(far)") : String(localized: "About \(eta) · \(far) away")
        case let (eta?, nil): return eta == String(localized: "Almost there") ? eta : String(localized: "About \(eta) away")
        case let (nil, far?): return String(localized: "\(far) away")
        default: return nil
        }
    }

    var statusTitle: String {
        switch status {
        case "awaiting_payment": String(localized: "Waiting for payment")
        case "searching", "offered": String(localized: "Waiting for driver to accept")
        case "open": scheduledAt == nil ? String(localized: "Waiting for a driver") : String(localized: "Planned, no driver yet")
        case "scheduled": String(localized: "Planned")
        case "accepted": driverLate == true ? String(localized: "Your driver is late") : String(localized: "Driver on the way")
        case "arrived": String(localized: "Your driver is here")
        case "riding": String(localized: "Riding")
        case "completed": String(localized: "Completed")
        case "cancelled": String(localized: "Cancelled")
        default: status.capitalized
        }
    }

    var route: [CLLocationCoordinate2D] {
        Polyline.decode(polyline).map { CLLocationCoordinate2D(latitude: $0.lat, longitude: $0.lng) }
    }
}

struct RideResponse: Codable {
    var ride: Ride
}

struct RidesResponse: Codable { var rides: [Ride]? }

struct DrivingState: Codable, Equatable {
    var online: Bool?
    var putOffline: Bool?
    var offer: Ride?
    var drive: Ride?
    var checks: ChecksSummary?      // Driving in the Netherlands in short, so a person's decision shows within a sync
}

struct SyncResponse: Codable {
    var rev: Int
    var same: Bool?
    var banned: Bool?
    var standing: Standing?
    var strikes: Int?
    var ride: Ride?
    var toPay: Ride?                    // a planned ride a driver just claimed, waiting for the rider's payment
    var driving: DrivingState?
    var unreadMessages: Int?
}

struct ChatPerson: Codable, Hashable, Identifiable {
    var id: String
    var name: String?
    var isDriver: Bool?
    var publicKey: String?
}

struct ChatMessage: Codable, Identifiable, Hashable {
    var id: String
    var fromMe: Bool?
    var body: String            // sealed: only E2E can open it
    var senderKey: String
    var toKey: String
    var at: Double?
    var readAt: Double?
}

struct ChatThread: Codable {
    var with: ChatPerson?
    var messages: [ChatMessage]?
    var canSend: Bool?
    var why: String?
    var messagesLeft: Int?
}

struct ChatSummary: Codable, Identifiable, Hashable {
    var person: ChatPerson
    var lastAt: Double?
    var unread: Int?
    var last: ChatMessage?
    var id: String { person.id }
}

struct ChatList: Codable {
    var unread: Int?
    var conversations: [ChatSummary]?
}

struct MarketOrder: Codable, Identifiable, Hashable {
    var id: String
    var kind: String?
    var scheduledAt: Double?
    var lat: Double
    var lng: Double
    var pickupLabel: String?
    var dropoffLabel: String?
    var dropoffLat: Double?
    var dropoffLng: Double?
    var distanceM: Int?
    var durationS: Int?
    var passengers: Int?
    var pets: Bool?
    var vehicle: String?
    var bidCents: Int?
    var coin: String?
    var awayM: Int?
    var canClaim: Bool?
    var forYou: Bool?                   // a rider chose this driver: theirs alone to claim, for now

    var coordinate: CLLocationCoordinate2D { CLLocationCoordinate2D(latitude: lat, longitude: lng) }
    var isPlanned: Bool { kind == "planned" }
}

extension Array where Element == MarketOrder {
    // An order a rider chose this driver for stays on top, however the rest is sorted.
    var forYouFirst: [MarketOrder] { filter { $0.forYou == true } + filter { $0.forYou != true } }
}

// `booked`: this driver's own rides, now or planned, before the drop-off is on its way: on the map too, and a tap opens the ride.
struct MarketResponse: Codable { var orders: [MarketOrder]?; var booked: [Ride]? }

struct WalletCoin: Codable, Identifiable, Hashable {
    var id: String
    var name: String?
    var symbol: String?
    var chain: String?
    var eurPerCoin: Double?
    var address: String?
    var tag: Int?
    var enabled: Bool?
    var available: Bool?
    var via: String?                // the wallet app the address came from
    var needsTokenAccount: Bool?    // a driver's wallet without a USDC account: USDC can't reach it yet
}

// One line of the wallet overview. `direction` is out or in; `reason` is ride, half, refund, drive or driveHalf.
struct WalletMove: Codable, Identifiable, Hashable {
    var id: String
    var direction: String?
    var reason: String?
    var coin: String?
    var amount: String?
    var eurCents: Int?
    var wallet: String?             // in: where it lands. Out: the driver's
    var pending: Bool?
    var when: Double?               // when it clears, once that's known
    var settling: Bool?
    var onHold: Bool?
    var needsUsdcAccount: Bool?
    var demo: Bool?
    var rideId: String?
    var rideStatus: String?
    var to: String?
    var at: Double?                 // when it cleared
    var explorer: String?
}

struct PayResponse: Codable { var transaction: String?; var message: String? }
// The server's line for the Solana connection (GET /api/chain/queue): how many requests wait, and about how long.
struct ChainQueue: Codable { var waiting: Int?; var seconds: Int? }

// The coins Drivezzz uses. An old ride can still say XRP, LTC or XLM; nothing else shows them, whatever a server still lists.
enum Coins {
    static let used = ["usdc-sol", "sol"]
    // Not a coin: it goes from rider to driver in the car, and has a ride's `coin` to itself.
    static let cash = "cash"
    static let payWith = [cash, "sol", "usdc-sol"]
}

// A connected wallet is locked: changing it takes a request and support's yes, good for one change.
struct WalletChange: Codable, Hashable {
    var locked: Bool?
    var request: WalletChangeRequest?
}
struct WalletChangeRequest: Codable, Hashable {
    var status: String?             // open, allowed, declined or used
    var message: String?
    var at: Double?
    var decidedAt: Double?
}

struct WalletView_: Codable {
    var network: String?
    var demo: Bool?
    var change: WalletChange?
    var takesCash: Bool?            // a driver takes cash unless they turned it off
    var coins: [WalletCoin]?
    var moves: [WalletMove]?

    var usedCoins: [WalletCoin] { (coins ?? []).filter { Coins.used.contains($0.id) } }
}
