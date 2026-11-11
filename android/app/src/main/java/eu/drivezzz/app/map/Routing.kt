package eu.drivezzz.app.map

import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.JsonFormat
import eu.drivezzz.app.core.LatLng
import eu.drivezzz.app.core.Polyline
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.Request

// Directions on Android: this one seam. iOS asks Apple; here it's an OSRM server, the same kind the server's own quotes use. The public
// demo server has no key and no promises: fine for now, a server of our own or a paid one before many drivers rely on it (docs/android.md).
object Router {
    var baseUrl = "https://router.project-osrm.org"

    // A step means: drive along its line, then do what it says at the end of that line.
    data class Step(val text: String, val line: List<LatLng>)
    data class Route(val line: List<LatLng>, val steps: List<Step>, val metres: Double, val seconds: Double)

    @Serializable private data class Maneuver(val type: String? = null, val modifier: String? = null, val exit: Int? = null)
    @Serializable private data class OsrmStep(val geometry: String? = null, val maneuver: Maneuver? = null, val name: String? = null, val ref: String? = null, val destinations: String? = null)
    @Serializable private data class Leg(val steps: List<OsrmStep>? = null)
    @Serializable private data class OsrmRoute(val distance: Double? = null, val duration: Double? = null, val geometry: String? = null, val legs: List<Leg>? = null)
    @Serializable private data class Answer(val code: String? = null, val routes: List<OsrmRoute>? = null)

    suspend fun route(from: LatLng, to: LatLng): Route? = withContext(Dispatchers.IO) {
        runCatching {
            val url = "$baseUrl/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=full&geometries=polyline&steps=true&alternatives=false"
            val request = Request.Builder().url(url).header("User-Agent", "drivezzz-android").build()
            ApiClient.http.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return@use null
                val answer = JsonFormat.decodeFromString(Answer.serializer(), response.body?.string() ?: "")
                val route = answer.routes?.firstOrNull() ?: return@use null
                val raw = route.legs?.firstOrNull()?.steps ?: emptyList()
                // OSRM says what to do at the start of a step; a Step here says it for the end of its line, so each takes the next one's words.
                val steps = raw.mapIndexedNotNull { i, step ->
                    val line = Polyline.decode(step.geometry)
                    if (line.size < 2) return@mapIndexedNotNull null
                    Step(instruction(raw.getOrNull(i + 1) ?: return@mapIndexedNotNull null), line)
                }
                Route(Polyline.decode(route.geometry), steps, route.distance ?: 0.0, route.duration ?: 0.0)
            }
        }.getOrNull()
    }

    private fun instruction(s: OsrmStep): String {
        val type = s.maneuver?.type ?: "turn"
        val modifier = s.maneuver?.modifier
        val road = s.name?.takeIf { it.isNotBlank() } ?: s.ref?.takeIf { it.isNotBlank() }
        val onto = road?.let { " onto $it" } ?: ""
        val way = when (modifier) {
            "left" -> "left"
            "right" -> "right"
            "slight left" -> "slightly left"
            "slight right" -> "slightly right"
            "sharp left" -> "sharp left"
            "sharp right" -> "sharp right"
            "straight" -> "straight"
            "uturn" -> "around"
            else -> null
        }
        return when (type) {
            "arrive" -> "You have arrived"
            "depart" -> "Head off" + (road?.let { " on $it" } ?: "")
            "turn", "end of road" -> if (modifier == "uturn") "Make a U-turn$onto" else if (way == "straight") "Continue straight$onto" else "Turn ${way ?: "ahead"}$onto"
            "continue", "new name" -> "Continue" + (if (way != null && way != "straight") " $way" else "") + onto
            "merge" -> "Merge" + (way?.takeIf { it != "straight" }?.let { " $it" } ?: "") + onto
            "on ramp" -> "Take the ramp" + (way?.takeIf { it != "straight" }?.let { " on the $it" } ?: "") + onto
            "off ramp" -> "Take the exit" + (way?.takeIf { it != "straight" }?.let { " on the $it" } ?: "") + onto
            "fork" -> "Keep ${way?.replace("slightly ", "") ?: "ahead"}$onto"
            "roundabout", "rotary", "roundabout turn" -> s.maneuver?.exit?.let { "At the roundabout, take exit $it$onto" } ?: "Go round the roundabout$onto"
            "exit roundabout", "exit rotary" -> "Leave the roundabout$onto"
            else -> "Continue$onto"
        }
    }
}
