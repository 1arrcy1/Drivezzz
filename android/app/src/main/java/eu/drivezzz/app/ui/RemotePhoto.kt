package eu.drivezzz.app.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import eu.drivezzz.app.core.ApiClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Request

// Car photos. Decoded away from the screen, so a sheet sliding up doesn't wait for a JPEG, and kept, so opening one again is instant.
object PhotoCache {
    private val kept = LruCache<String, Bitmap>(60)

    fun cached(url: String): Bitmap? = kept.get(url)

    suspend fun load(url: String): Bitmap? {
        cached(url)?.let { return it }
        return withContext(Dispatchers.IO) {
            runCatching {
                ApiClient.http.newCall(Request.Builder().url(url).build()).execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    response.body?.bytes()?.let { decode(it) }
                }
            }.getOrNull()
        }?.also { kept.put(url, it) }
    }

    // Uploads are at most 1400 px on the long side.
    private fun decode(data: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 1400) sample *= 2
        return BitmapFactory.decodeByteArray(data, 0, data.size, BitmapFactory.Options().apply { inSampleSize = sample })
    }
}

@Composable
fun RemotePhoto(url: String?, modifier: Modifier = Modifier, contentScale: ContentScale = ContentScale.Crop, placeholder: Color = Theme.soft) {
    val image by produceState(url?.let { PhotoCache.cached(it) }, url) {
        if (url != null) value = PhotoCache.load(url)
    }
    val shown = image
    if (shown != null) {
        Image(shown.asImageBitmap(), null, modifier, contentScale = contentScale)
    } else {
        Box(modifier.background(placeholder))
    }
}
