package eu.drivezzz.app.core

import kotlinx.serialization.Serializable

// What the server sends. Everything but the ids is optional, so the app keeps working while the server changes.

@Serializable
data class User(
    val id: String,
    val name: String,
    val email: String? = null,
    val hasLogin: Boolean? = null,
    val isDriver: Boolean? = null,
    val demo: Boolean? = null,
    val createdAt: Double? = null,
)

// The End User Licence Agreement, as the website has it. A block's text has Markdown for bold and links (Markdown in core/Format.kt).
@Serializable
data class Eula(val version: Int, val updated: String? = null, val short: List<EulaBlock>? = null, val sections: List<EulaSection>? = null)
@Serializable data class EulaSection(val id: String, val title: String, val blocks: List<EulaBlock> = emptyList())
@Serializable data class EulaBlock(val text: String, val bullet: Boolean? = null)

// How long what the server asks the Solana network is waiting (server/src/rpcqueue.js).
@Serializable data class ChainQueue(val waiting: Int? = null, val seconds: Int? = null)

@Serializable data class BlockedPerson(val id: String, val name: String? = null, val at: Double? = null)
@Serializable data class BlocksResponse(val blocks: List<BlockedPerson>? = null)
@Serializable data class Strike(val id: String, val reason: String? = null, val at: Double? = null)

@Serializable
data class Appeal(val id: String, val message: String? = null, val at: Double? = null, val status: String? = null, val answer: String? = null)

@Serializable
data class Ban(
    val id: String? = null,
    val kind: String? = null,
    val reason: String? = null,
    val at: Double? = null,
    val endsAt: Double? = null,
    val decided: Boolean? = null,
    val answer: String? = null,
    val canAppeal: Boolean? = null,
    val nextAppealAt: Double? = null,
    val appeals: List<Appeal>? = null,
)

@Serializable
data class Standing(val strikes: Int? = null, val maxStrikes: Int? = null, val strikeList: List<Strike>? = null, val ban: Ban? = null)

@Serializable
data class AuthResponse(val token: String? = null, val user: User, val standing: Standing? = null, val isNew: Boolean? = null)

@Serializable data class MeResponse(val user: User, val standing: Standing? = null, val pushOn: Boolean? = null, val fcmOn: Boolean? = null)

@Serializable data class CarPhoto(val id: String, val kind: String? = null, val url: String? = null)

// What still stops a car of the driver's in the Netherlands (carHold in server/src/checks.js): its first RDW problem, or its plate
// waiting for a person because it couldn't be read from the back photo. `review`: only a person looking is left.
@Serializable
data class CarHold(val code: String? = null, val text: String? = null, val review: Boolean? = null) {
    val plate: Boolean get() = code == "plate"
}

@Serializable
data class Car(
    val id: String,
    val vehicle: String? = null,
    val plate: String,
    val platePretty: String? = null,
    val make: String? = null,
    val model: String? = null,
    val colorName: String? = null,
    val colorHex: String? = null,
    val body: String? = null,
    val seats: Int? = null,
    val year: Int? = null,
    val verified: Boolean? = null,
    val perKmCents: Int? = null,
    val perMinCents: Int? = null,
    val pickupPerKmCents: Int? = null,
    val petsAllowed: Boolean? = null,
    val photos: List<CarPhoto>? = null,
    val photosMissing: List<String>? = null, // which of front, back and inside it still needs before it can drive
    val hold: CarHold? = null, // the driver's own: what still stops it in the Netherlands, if anything
) {
    val kind: String get() = vehicle ?: "car"
    val title: String
        get() {
            val name = listOfNotNull(make, model).filter { it.isNotEmpty() }.joinToString(" ")
            return name.ifEmpty { Vehicle.name(kind) }
        }
    val shownPlate: String get() = platePretty ?: plate
}

@Serializable data class PlateLookup(val found: Boolean? = null, val car: PlateCar? = null)

@Serializable
data class PlateCar(
    val vehicle: String? = null,
    val plate: String? = null,
    val make: String? = null,
    val model: String? = null,
    val colorName: String? = null,
    val colorHex: String? = null,
    val body: String? = null,
    val seats: Int? = null,
    val year: Int? = null,
    val verified: Boolean? = null,
)

@Serializable
data class DriverCard(
    val id: String,
    val completedPercent: Int? = null,
    val name: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    val heading: Double? = null,
    val online: Boolean? = null,
    val busy: Boolean? = null,
    val distanceM: Int? = null,
    val perKmCents: Int? = null,
    val perMinCents: Int? = null,
    val pickupPerKmCents: Int? = null,
    val petsAllowed: Boolean? = null,
    val allowsPlanning: Boolean? = null,
    val verified: Boolean? = null, // ID, face, chauffeurskaart and permit checked, in the Netherlands
    val car: Car? = null,
    val coins: List<String>? = null,
    val rating: Double? = null,
    val ratingCount: Int? = null,
    val arrivalScore: Int? = null,
    val arrivals: Int? = null,
    val averageLateS: Int? = null,
    // In a quote.
    val priceCents: Int? = null,
    val pickupM: Int? = null,
    val pickupS: Int? = null,
    val afterAnotherDrive: Boolean? = null,
    // On a profile.
    val bio: String? = null,
    val ridesDone: Int? = null,
) {
    val coordinate: LatLng? get() = if (lat != null && lng != null) LatLng(lat, lng) else null

    // What they ask for a 10 km ride of 20 minutes, with their way to you: cheapest, before there's a destination. As on the server (`askingCents`).
    val askingCents: Int get() = ((distanceM ?: 0) / 1000.0 * (pickupPerKmCents ?: 0)).toInt() + 10 * (perKmCents ?: 0) + 20 * (perMinCents ?: 0)
}

// `total`: how many are online, of which `drivers` are the first, in the order the rider asked for.
@Serializable data class DriversResponse(val drivers: List<DriverCard>? = null, val total: Int? = null)

// What a rider sees first in the lists. The server decides who makes the list; this keeps them in that order.
enum class DriverSort(val key: String, val label: String, val listTitle: String) {
    Cheapest("cheapest", "Cheapest", "Cheapest near you"),
    Stars("stars", "Best rated", "Best rated near you"),
    Fastest("fastest", "Fastest", "Fastest to you"),
    OnTime("onTime", "On time", "Most on time");

    // Many reviews count for more than a few: one 5-star review shouldn't beat 400 of 4.9. Nothing to go on comes last. As on the server (`trusted`).
    private fun trusted(score: Double?, count: Int?, usual: Double): Double {
        if (score == null || count == null || count <= 0) return -1.0
        return (score * count + usual * 3) / (count + 3)
    }

    fun sorted(list: List<DriverCard>): List<DriverCard> {
        val price = { d: DriverCard -> (d.priceCents ?: d.askingCents).toDouble() }
        return list.sortedWith(
            compareBy<DriverCard> { d ->
                when (this) {
                    Cheapest -> price(d)
                    Stars -> -trusted(d.rating, d.ratingCount, 4.0)
                    Fastest -> (d.pickupS ?: d.distanceM)?.toDouble() ?: Double.MAX_VALUE
                    OnTime -> -trusted(d.arrivalScore?.toDouble(), d.arrivals, 80.0)
                }
            }.thenBy(price),
        )
    }

    companion object {
        fun of(key: String?) = entries.firstOrNull { it.key == key } ?: Cheapest
    }
}

@Serializable data class DriverReview(val stars: Int? = null, val text: String? = null, val at: Double? = null)
@Serializable data class BusyTime(val from: Double? = null, val to: Double? = null)

@Serializable
data class Availability(
    val lastOnlineAt: Double? = null,
    val bookable: Boolean? = null,
    val allowsPlanning: Boolean? = null,
    val planDays: Int? = null,
    val busy: List<BusyTime>? = null,
    val usualHoursUtc: List<Double>? = null,
)

@Serializable
data class DriverProfile(val driver: DriverCard, val reviews: List<DriverReview>? = null, val availability: Availability? = null)

@Serializable
data class OwnDriver(
    val allowsPlanning: Boolean? = null,
    val planDays: Int? = null,
    val maxPlanDays: Int? = null,
    val perKmCents: Int? = null,
    val perMinCents: Int? = null,
    val pickupPerKmCents: Int? = null,
    val petsAllowed: Boolean? = null,
    val bio: String? = null,
    // When the app told them that licences, permits and insurance are up to them.
    val rulesSeenAt: Double? = null,
    val verified: Boolean? = null, // their checks for driving in the Netherlands went through and nothing ran out
    val checks: eu.drivezzz.app.features.checks.ChecksSummary? = null, // those checks in short: what still needs attention
    val activeCarId: String? = null,
    val online: Boolean? = null,
    val onlineSince: Double? = null,
    val putOffline: Boolean? = null, // for not answering a ride; stays so until they go online themselves
    val cars: List<Car>? = null,
    val rating: Double? = null,
    val ratingCount: Int? = null,
    val arrivalScore: Int? = null,
    val arrivals: Int? = null,
    val averageLateS: Int? = null,
    val completedPercent: Int? = null,
    val ridesDone: Int? = null,
) {
    val activeCar: Car? get() = cars?.firstOrNull { it.id == activeCarId }
}

@Serializable data class OwnDriverResponse(val driver: OwnDriver? = null, val car: Car? = null)

@Serializable
data class AreaPrices(
    val driversOnline: Int? = null,
    val cheapestPerKmCents: Int? = null,
    val middlePerKmCents: Int? = null,
    val cheapestPerMinCents: Int? = null,
    val middlePerMinCents: Int? = null,
)

@Serializable
data class DriverHome(
    val earnedTodayCents: Int? = null,
    val ridesToday: Int? = null,
    val earnedTotalCents: Int? = null,
    val ridesTotal: Int? = null,
    val pendingCents: Int? = null,
    val onTimePercent: Int? = null,
    val acceptancePercent: Int? = null,
    val area: AreaPrices? = null,
    val planned: List<Ride>? = null,
)

@Serializable
data class Place(
    val lat: Double,
    val lng: Double,
    val label: String? = null,
    val movedM: Int? = null,
    val road: String? = null,
) {
    val coordinate: LatLng get() = LatLng(lat, lng)
    val json: Map<String, Any?>
        get() = buildMap {
            put("lat", lat)
            put("lng", lng)
            if (label != null) put("label", label)
            if (movedM != null) put("movedM", movedM)
        }
}

@Serializable
data class Quote(
    val pickup: Place,
    val dropoff: Place,
    val polyline: String? = null,
    val distanceM: Int? = null,
    val durationS: Int? = null,
    val estimated: Boolean? = null,
    val scheduledAt: Double? = null,
    val offers: List<DriverCard>? = null,
    val suggestedBidCents: Int? = null,
    val autoCushion: Double? = null,
)

@Serializable
data class RideDriver(
    val id: String,
    val name: String? = null,
    val car: Car? = null,
    val rating: Double? = null,
    val ratingCount: Int? = null,
    val arrivalScore: Int? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    val heading: Double? = null,
    val locAt: Double? = null,
) {
    val coordinate: LatLng? get() = if (lat != null && lng != null) LatLng(lat, lng) else null
}

@Serializable
data class RideRider(
    val id: String,
    val name: String? = null,
    val lat: Double? = null,
    val lng: Double? = null,
    val locAt: Double? = null,
) {
    val coordinate: LatLng? get() = if (lat != null && lng != null) LatLng(lat, lng) else null
}

@Serializable
data class RidePayout(val status: String? = null, val dueAt: Double? = null, val txid: String? = null, val amount: String? = null, val eurCents: Int? = null)

// The ride's money in its escrow on Solana: paid, then settled as pay out, split or refund.
@Serializable
data class RideEscrow(
    val status: String? = null,
    val outcome: String? = null,
    val settleAfter: Double? = null,
    val onHold: Boolean? = null, // an admin is checking this ride
    val coin: String? = null,
    val amount: String? = null,
    val feeAmount: String? = null,
    val driverAmount: String? = null,
    val address: String? = null,
    val explorer: String? = null,
    val settleExplorer: String? = null,
)

@Serializable data class RideReview(val stars: Int? = null, val text: String? = null)
@Serializable data class RideDispute(val status: String? = null, val answer: String? = null, val message: String? = null, val at: Double? = null)

@Serializable
data class Ride(
    val id: String,
    val status: String,
    val mode: String? = null,
    val scheduledAt: Double? = null,
    val role: String? = null,
    val pickup: Place,
    val dropoff: Place,
    val polyline: String? = null,
    val distanceM: Int? = null,
    val durationS: Int? = null,
    val passengers: Int? = null,
    val pets: Boolean? = null,
    val vehicle: String? = null,
    val priceCents: Int? = null,
    val maxCents: Int? = null,
    val coin: String? = null,
    val coinAmount: String? = null,
    val feeCents: Int? = null, // Drivezzz's part of a ride paid out in full, from the driver's payout
    val refundPercent: Int? = null, // for the rider: what cancelling now gives back
    val freeCancelUntil: Double? = null, // a planned ride with a driver is free to cancel until then
    val createdAt: Double? = null,
    val acceptedAt: Double? = null,
    val arrivedAt: Double? = null,
    val pickupEtaAt: Double? = null,
    val pickupDeadlineAt: Double? = null, // the driver's time to reach the pickup; past it a rider cancels for free
    val driverLate: Boolean? = null, // past that time and not at the pickup
    val driverEtaS: Int? = null, // how long the driver still needs to the pickup
    val noShowFrom: Double? = null, // a driver waiting at the pickup can cancel for half the price from then
    val pickupM: Int? = null,
    val checkedInAt: Double? = null,
    val checkedOutAt: Double? = null,
    val cancelledAt: Double? = null,
    val cancelledBy: String? = null,
    val cancelReason: String? = null,
    val offeredUntil: Double? = null,
    val syncScore: Double? = null,
    val reviewRequired: Boolean? = null,
    val now: Double? = null,
    val driver: RideDriver? = null,
    val rider: RideRider? = null,
    val apartM: Int? = null,
    val canCheckIn: Boolean? = null,
    val driverToDropoffM: Int? = null,
    val riderToDropoffM: Int? = null,
    val driverToPickupM: Int? = null, // for the rider, while the driver comes: how far they still are, in a straight line
    val checkOutM: Int? = null, // for the driver on the ride: check-out opens this close to the drop-off
    val safetyAsked: Boolean? = null,
    // Paying: once a driver has it, until payBy, through a Solana Pay link that opens the rider's wallet.
    val payBy: Double? = null,
    val payUrl: String? = null,
    val payAmount: String? = null, // what it comes to in the coin: what the wallet was asked for, or at the latest price
    val eurPerCoin: Double? = null, // the price that amount is at
    val testPay: Boolean? = null, // a test server with no chain: paying is pretended, no wallet can do it there
    val network: String? = null, // of a ride waiting to be paid: mainnet or testnet
    val escrow: RideEscrow? = null,
    val checkoutWarning: Boolean? = null, // the rider's phone wasn't near the drop-off at check-out
    val payout: RidePayout? = null,
    val review: RideReview? = null,
    val dispute: RideDispute? = null,
) {
    val isLive: Boolean get() = status in listOf("accepted", "arrived", "riding")
    val isOver: Boolean get() = status in listOf("completed", "cancelled")
    val isWaiting: Boolean get() = status in listOf("searching", "awaiting_payment", "offered", "open")
    val needsPayment: Boolean get() = status == "awaiting_payment"
    val isCash: Boolean get() = coin == Coins.cash
    val shownPriceCents: Int? get() = priceCents ?: maxCents

    // How long until the driver is at the pickup, for the map and the ride's page.
    val etaShort: String? get() = driverEtaS?.let { if (it < 60) "Almost there" else Fmt.minutes(it) }
    val etaLine: String? get() = driverEtaS?.let { if (it < 60) "Your driver is almost there" else "Your driver is about ${Fmt.minutes(it)} away" }
    // While the driver comes: how long and how far, which changes with each of their positions (every 5 seconds on the way). As Models.swift.
    val comingLine: String?
        get() {
            if (status !in listOf("accepted", "awaiting_payment")) return null
            val eta = etaShort
            val far = driverToPickupM?.let { Fmt.km(it) }
            return when {
                eta != null && far != null -> if (eta == "Almost there") "Almost there · $far" else "About $eta · $far away"
                eta != null -> if (eta == "Almost there") eta else "About $eta away"
                far != null -> "$far away"
                else -> null
            }
        }

    val statusTitle: String
        get() = when (status) {
            "awaiting_payment" -> "Waiting for payment"
            "searching", "offered" -> "Waiting for driver to accept"
            "open" -> if (scheduledAt == null) "Waiting for a driver" else "Planned, no driver yet"
            "scheduled" -> "Planned"
            "accepted" -> if (driverLate == true) "Your driver is late" else "Driver on the way"
            "arrived" -> "Your driver is here"
            "riding" -> "Riding"
            "completed" -> "Completed"
            "cancelled" -> "Cancelled"
            else -> status.capitalized()
        }

    val route: List<LatLng> get() = Polyline.decode(polyline)

    // Where the directions lead: the rider, then the drop-off. Nowhere while waiting for them to check in.
    val navigationTarget: Place?
        get() = when (status) {
            "accepted", "awaiting_payment" -> pickup
            "riding" -> dropoff
            else -> null
        }
}

@Serializable data class RideResponse(val ride: Ride)
@Serializable data class RidesResponse(val rides: List<Ride>? = null)

@Serializable
data class DrivingState(
    val online: Boolean? = null,
    val putOffline: Boolean? = null,
    val offer: Ride? = null,
    val drive: Ride? = null,
    val checks: eu.drivezzz.app.features.checks.ChecksSummary? = null, // Driving in the Netherlands in short, so a person's decision shows within a sync
)

@Serializable
data class SyncResponse(
    val rev: Int,
    val same: Boolean? = null,
    val banned: Boolean? = null,
    val standing: Standing? = null,
    val strikes: Int? = null,
    val ride: Ride? = null,
    val toPay: Ride? = null, // a planned ride a driver just claimed, waiting for the rider's payment
    val driving: DrivingState? = null,
    val unreadMessages: Int? = null,
)

@Serializable
data class ChatPerson(val id: String, val name: String? = null, val isDriver: Boolean? = null, val publicKey: String? = null)

@Serializable
data class ChatMessage(
    val id: String,
    val fromMe: Boolean? = null,
    val body: String, // sealed: only E2E can open it
    val senderKey: String,
    val toKey: String,
    val at: Double? = null,
    val readAt: Double? = null,
)

@Serializable
data class ChatThread(
    val with: ChatPerson? = null,
    val messages: List<ChatMessage>? = null,
    val canSend: Boolean? = null,
    val why: String? = null,
    val messagesLeft: Int? = null,
)

@Serializable
data class ChatSummary(val person: ChatPerson, val lastAt: Double? = null, val unread: Int? = null, val last: ChatMessage? = null) {
    val id: String get() = person.id
}

@Serializable data class ChatList(val unread: Int? = null, val conversations: List<ChatSummary>? = null)

@Serializable
data class MarketOrder(
    val id: String,
    val kind: String? = null,
    val scheduledAt: Double? = null,
    val lat: Double,
    val lng: Double,
    val pickupLabel: String? = null,
    val dropoffLabel: String? = null,
    val dropoffLat: Double? = null,
    val dropoffLng: Double? = null,
    val distanceM: Int? = null,
    val durationS: Int? = null,
    val passengers: Int? = null,
    val pets: Boolean? = null,
    val vehicle: String? = null,
    val bidCents: Int? = null,
    val coin: String? = null,
    val awayM: Int? = null,
    val canClaim: Boolean? = null,
    val forYou: Boolean? = null, // a rider chose this driver: theirs alone to claim, for now
) {
    val coordinate: LatLng get() = LatLng(lat, lng)
    val isPlanned: Boolean get() = kind == "planned"
}

// An order a rider chose this driver for stays on top, however the rest is sorted.
val List<MarketOrder>.forYouFirst: List<MarketOrder>
    get() = filter { it.forYou == true } + filter { it.forYou != true }

// `booked`: this driver's own rides, now or planned, before the drop-off is on its way: on the map too, and a tap opens the ride.
@Serializable data class MarketResponse(val orders: List<MarketOrder>? = null, val booked: List<Ride>? = null)

@Serializable
data class WalletCoin(
    val id: String,
    val name: String? = null,
    val symbol: String? = null,
    val chain: String? = null,
    val eurPerCoin: Double? = null,
    val address: String? = null,
    val tag: Int? = null,
    val enabled: Boolean? = null,
    val available: Boolean? = null,
    val via: String? = null, // the wallet app the address came from
    val needsTokenAccount: Boolean? = null, // a driver's wallet without a USDC account: USDC can't reach it yet
)

// One line of the wallet overview. `direction` is out or in; `reason` is ride, half, refund, drive or driveHalf.
@Serializable
data class WalletMove(
    val id: String,
    val direction: String? = null,
    val reason: String? = null,
    val coin: String? = null,
    val amount: String? = null,
    val eurCents: Int? = null,
    val wallet: String? = null, // in: where it lands. Out: the driver's
    val pending: Boolean? = null,
    val `when`: Double? = null, // when it clears, once that's known
    val settling: Boolean? = null,
    val onHold: Boolean? = null,
    val needsUsdcAccount: Boolean? = null,
    val demo: Boolean? = null,
    val rideId: String? = null,
    val rideStatus: String? = null,
    val to: String? = null,
    val at: Double? = null, // when it cleared
    val explorer: String? = null,
)

@Serializable data class PayResponse(val transaction: String? = null, val message: String? = null)

// A connected wallet is locked: changing it takes a request and support's yes, good for one change.
@Serializable data class WalletChange(val locked: Boolean? = null, val request: WalletChangeRequest? = null)

@Serializable
data class WalletChangeRequest(
    val status: String? = null, // open, allowed, declined or used
    val message: String? = null,
    val at: Double? = null,
    val decidedAt: Double? = null,
)

@Serializable
data class WalletView(
    val network: String? = null,
    val demo: Boolean? = null,
    val change: WalletChange? = null,
    val takesCash: Boolean? = null, // a driver takes cash unless they turned it off
    val coins: List<WalletCoin>? = null,
    val moves: List<WalletMove>? = null,
) {
    val usedCoins: List<WalletCoin> get() = (coins ?: emptyList()).filter { it.id in Coins.used }
}

@Serializable data class LocationAnswer(val every: Int? = null, val online: Boolean? = null)
@Serializable data class FilterResponse(val words: List<String>? = null)
@Serializable class Empty
