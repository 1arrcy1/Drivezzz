package eu.drivezzz.app.map

import android.content.Context
import android.location.Geocoder
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.JsonFormat
import eu.drivezzz.app.core.LatLng
import eu.drivezzz.app.core.Place
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import java.util.Locale

// Finding an address, and the name of a spot: this one seam. iOS asks Apple. Here the phone's own geocoder if it has one, and Photon,
// a free search on OpenStreetMap's data, which needs no key. What's typed and roughly where you are goes to them: docs/android.md.
object Places {
    var searchUrl = "https://photon.komoot.io"
    private lateinit var context: Context

    fun init(context: Context) {
        this.context = context.applicationContext
    }

    data class Completion(val title: String, val subtitle: String, val at: LatLng) {
        val place: Place
            get() = Place(at.lat, at.lng, listOf(title, subtitle.split(",").firstOrNull() ?: "").filter { it.isNotEmpty() }.joinToString(", "))
    }

    @Serializable private data class Geometry(val coordinates: List<Double>? = null)
    @Serializable private data class Properties(
        val name: String? = null, val street: String? = null, val housenumber: String? = null,
        val city: String? = null, val locality: String? = null, val district: String? = null, val state: String? = null, val country: String? = null, val postcode: String? = null,
    )
    @Serializable private data class Feature(val geometry: Geometry? = null, val properties: Properties? = null)
    @Serializable private data class Answer(val features: List<Feature>? = null)

    private fun fetch(url: okhttp3.HttpUrl): List<Feature> {
        val request = Request.Builder().url(url).header("User-Agent", "drivezzz-android").build()
        return ApiClient.http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return@use emptyList()
            JsonFormat.decodeFromString(Answer.serializer(), response.body?.string() ?: "").features ?: emptyList()
        }
    }

    suspend fun search(text: String, near: LatLng?): List<Completion> = withContext(Dispatchers.IO) {
        val url = "$searchUrl/api/".toHttpUrl().newBuilder().addQueryParameter("q", text).addQueryParameter("limit", "7")
        // Only to rank what's nearby first, so rounded to about a kilometre: Privacy says "roughly where you are".
        if (near != null) {
            url.addQueryParameter("lat", (Math.round(near.lat * 100) / 100.0).toString()).addQueryParameter("lon", (Math.round(near.lng * 100) / 100.0).toString())
        }
        val found = runCatching { fetch(url.build()) }.getOrNull()
        found?.mapNotNull { f ->
            val c = f.geometry?.coordinates ?: return@mapNotNull null
            if (c.size < 2) return@mapNotNull null
            val p = f.properties ?: return@mapNotNull null
            val street = p.street?.let { s -> p.housenumber?.let { "$s $it" } ?: s }
            val title = p.name ?: street ?: p.city ?: return@mapNotNull null
            val subtitle = listOfNotNull(if (p.name != null) street else null, p.city ?: p.locality ?: p.district, p.state, p.country).distinct().filter { it != title }.joinToString(", ")
            Completion(title, subtitle, LatLng(c[1], c[0]))
        }?.distinctBy { it.title + it.subtitle } ?: geocoderSearch(text)
    }

    @Suppress("DEPRECATION")
    private fun geocoderSearch(text: String): List<Completion> {
        if (!Geocoder.isPresent()) return emptyList()
        return runCatching {
            Geocoder(context, Locale.getDefault()).getFromLocationName(text, 6)?.map { a ->
                Completion(a.featureName ?: a.thoroughfare ?: text, listOfNotNull(a.thoroughfare, a.locality, a.countryName).joinToString(", "), LatLng(a.latitude, a.longitude))
            }
        }.getOrNull() ?: emptyList()
    }

    // The name of a spot: street and number, town.
    @Suppress("DEPRECATION")
    suspend fun name(of: LatLng): String? = withContext(Dispatchers.IO) {
        withTimeoutOrNull(5000) {
            if (Geocoder.isPresent()) {
                runCatching {
                    Geocoder(context, Locale.getDefault()).getFromLocation(of.lat, of.lng, 1)?.firstOrNull()?.let { a ->
                        val street = a.thoroughfare
                        if (street != null) "$street${a.subThoroughfare?.let { " $it" } ?: ""}${a.locality?.let { ", $it" } ?: ""}" else a.featureName ?: a.locality
                    }
                }.getOrNull()?.let { return@withTimeoutOrNull it }
            }
            val url = "$searchUrl/reverse".toHttpUrl().newBuilder().addQueryParameter("lat", of.lat.toString()).addQueryParameter("lon", of.lng.toString()).build()
            runCatching { fetch(url).firstOrNull()?.properties }.getOrNull()?.let { p ->
                val street = p.street ?: p.name
                if (street != null) "$street${p.housenumber?.let { " $it" } ?: ""}${(p.city ?: p.locality)?.let { ", $it" } ?: ""}" else p.city ?: p.locality
            }
        }
    }
}
