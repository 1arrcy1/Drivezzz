package eu.drivezzz.app.features.checks

import kotlinx.serialization.Serializable
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

// What the server knows about a driver's checks for driving a taxi in the Netherlands (server/src/checks.js). As ChecksModels.swift.
// Every field optional, as everywhere: the app keeps working while the server changes.
@Serializable
data class DriverChecks(
    val status: String? = null, // none, started, review, approved, declined
    val verified: Boolean? = null,
    val items: Map<String, String>? = null, // consent, id, face, chauffeurskaart, permit, kvk: missing, waiting, expired or done
    val consentVersion: Int? = null,
    val id: CheckedID? = null,
    val chauffeurskaart: CheckedDocument? = null,
    val permit: CheckedDocument? = null,
    val kvk: CheckedKvk? = null,
    val note: String? = null,
    val vehicles: List<CheckedVehicle>? = null,
    val fake: Boolean? = null,
    val open: List<String>? = null, // until approved: what's still open, in the driver's words (publicChecks in checks.js)
    val again: String? = null, // what a person asked to have sent again (id, face, chauffeurskaart, permit, kvk), with `note`
    val renew: List<String>? = null, // done rows that may be sent again all the same, as they run out within 30 days
    val retake: List<String>? = null, // to send again by itself: a photo that couldn't be read, or a KvK number KvK doesn't know
) {
    fun item(key: String): String = items?.get(key) ?: "missing"

    // "your taxi permit", for "A person asked you to send … again".
    val againWhat: String? get() = ChecksSummary.what(again)
    val waitingForPerson: Boolean get() = status == "review"
}

// Driving in the Netherlands in short, in the driver's own data and in every sync (checksSummary in checks.js): for saying what
// still needs attention outside the checks (Pieter, 8 November 2026). As ChecksModels.swift.
@Serializable
data class ChecksSummary(val status: String? = null, val open: Int? = null, val again: String? = null) {
    // Null when there's nothing to say.
    val attention: String? get() {
        what(again)?.let { return "A person asked you to send $it again." }
        val n = open ?: 0
        val things = if (n == 1) "1 thing needs" else "$n things need"
        return when {
            status == "declined" -> "Not approved. Open it to see why."
            status == "review" -> if (n > 0) "A person checks your documents. $things attention." else "A person checks your documents."
            status == "started" && n > 0 -> "$things attention."
            else -> null
        }
    }

    companion object {
        fun what(again: String?): String? = when (again) {
            null -> null
            "id" -> "your ID and a selfie"
            "face" -> "your selfie"
            "chauffeurskaart" -> "your chauffeurskaart"
            "permit" -> "your taxi permit"
            "kvk" -> "your KvK number"
            else -> "something"
        }
    }
}

@Serializable
data class CheckedID(
    val surname: String? = null,
    val givenNames: String? = null,
    val birthDate: String? = null,
    val expires: String? = null,
    val docType: String? = null,
    val country: String? = null,
    val numberEnd: String? = null,
)

@Serializable data class CheckedDocument(val number: String? = null, val expires: String? = null)

@Serializable data class CheckedKvk(val number: String? = null, val name: String? = null, val found: Boolean? = null)

@Serializable
data class CheckedVehicle(
    val id: String,
    val plate: String? = null,
    val checkedAt: Double? = null,
    val found: Boolean? = null,
    val taxi: Boolean? = null,
    val insured: Boolean? = null,
    val apkUntil: String? = null,
    val exported: Boolean? = null,
    val plateSeen: Boolean? = null, // its plate was read from its back photo, or a person looked instead
) {
    val ok: Boolean get() = found == true && taxi == true && insured == true && exported != true && plateSeen != false && (apkUntil ?: "") >= ChecksDate.today
}

@Serializable data class ChecksResponse(val checks: DriverChecks? = null, val chip: ChipResult? = null, val face: FaceResult? = null)
@Serializable data class ChipResult(val signed: Boolean? = null, val live: Boolean? = null, val country: String? = null)
@Serializable data class FaceResult(val passed: Boolean? = null)

@Serializable data class CheckChallenge(val id: String, val nonce: String, val steps: List<String> = emptyList())

object ChecksDate {
    private val zone = ZoneId.of("Europe/Amsterdam")
    val today: String get() = LocalDate.now(zone).toString()
    fun iso(ms: Long): String = java.time.Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toString()
    fun show(iso: String?): String {
        val d = iso?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return "–"
        return d.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    }
    // Day and month only, for a pill next to a title: "18 Nov". As ChecksDate.showShort in ChecksModels.swift.
    fun showShort(iso: String?): String {
        val d = iso?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return "–"
        return d.format(DateTimeFormatter.ofPattern("d MMM", java.util.Locale.getDefault()))
    }
}
