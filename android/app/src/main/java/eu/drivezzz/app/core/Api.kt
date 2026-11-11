package eu.drivezzz.app.core

import android.annotation.SuppressLint
import android.content.Context
import android.provider.Settings
import eu.drivezzz.app.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

object ServerConfig {
    const val PRODUCTION = "https://drivezzz.s3rver.nl"
    private lateinit var appContext: Context

    // Release: always the live server. Debug: the live server too, as on iOS, unless set from the Mac with
    //   adb shell am start -n eu.drivezzz.app/.MainActivity --es serverURLOverride http://…
    // which stays until set again ("" for the default).
    lateinit var baseURL: String
        private set

    fun init(context: Context) {
        appContext = context.applicationContext
        val override = if (BuildConfig.DEBUG) context.getSharedPreferences("settings", Context.MODE_PRIVATE).getString("serverURLOverride", null) else null
        baseURL = (override?.takeIf { it.startsWith("http") } ?: BuildConfig.DEFAULT_SERVER).trimEnd('/')
    }

    val isTest: Boolean get() = baseURL != PRODUCTION

    // For the line at the bottom of Profile in a debug build: which server this is.
    val shownServer: String
        get() = if (BuildConfig.BUILD_TYPE == "release") "" else if (isTest) " · test server" else " · live server"

    // This phone's id, so a ban survives reinstalling the app. Android's own id for this app on this phone does (it only changes
    // with a factory reset), which is what the Keychain is for on iOS. Made from it, not it, and with its own id for a test server.
    @get:SuppressLint("HardwareIds")
    val deviceId: String by lazy {
        val android = Settings.Secure.getString(appContext.contentResolver, Settings.Secure.ANDROID_ID)
        if (android.isNullOrEmpty()) {
            Secure.read("deviceId") ?: UUID.randomUUID().toString().also { Secure.write("deviceId", it) }
        } else {
            UUID.nameUUIDFromBytes("drivezzz|$android|${if (isTest) "test" else "live"}".toByteArray()).toString()
        }
    }
}

class ApiError(val status: Int, override val message: String, val code: String? = null, val extra: Map<String, Double> = emptyMap()) : Exception(message) {
    companion object {
        const val OFFLINE_MESSAGE = "Can’t reach Drivezzz. Check your connection."
        fun offline() = ApiError(0, OFFLINE_MESSAGE)
    }
}

// What the app has sent and received, to keep an eye on the data budget (30 MB an hour while driving).
object DataMeter {
    @Volatile private var bytes = 0L
    @Volatile private var startedAt = System.currentTimeMillis()
    private const val OVERHEAD = 700 // headers and TLS records per request, roughly

    fun add(count: Long) { bytes += count + OVERHEAD }
    fun reset() { bytes = 0; startedAt = System.currentTimeMillis() }
    val megabytesPerHour: Double
        get() {
            val hours = maxOf((System.currentTimeMillis() - startedAt) / 3_600_000.0, 1.0 / 60)
            return bytes / 1_000_000.0 / hours
        }
}

// The server's clock, so countdowns are right on a phone whose clock is a little off.
object ServerClock {
    @Volatile var ahead = 0.0
    // Server time in ms, as this phone's own clock would read it.
    fun date(ms: Double): Double = ms - ahead
    fun secondsUntil(ms: Double): Long = ((date(ms) - System.currentTimeMillis()) / 1000).toLong()
}

val JsonFormat = Json {
    ignoreUnknownKeys = true
    isLenient = true
    coerceInputValues = true
    explicitNulls = false
    encodeDefaults = false
}

// A body as plain maps and lists, as on iOS.
fun Any?.toJsonElement(): JsonElement = when (this) {
    null -> JsonNull
    is JsonElement -> this
    is Map<*, *> -> JsonObject(entries.associate { (k, v) -> k.toString() to v.toJsonElement() })
    is Iterable<*> -> JsonArray(map { it.toJsonElement() })
    is String -> JsonPrimitive(this)
    is Number -> JsonPrimitive(this)
    is Boolean -> JsonPrimitive(this)
    else -> JsonPrimitive(toString())
}

object ApiClient {
    private const val TOKEN_KEY = "token"
    private val json = "application/json".toMediaType()

    val http: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(40, TimeUnit.SECONDS)
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(40, TimeUnit.SECONDS)
        .build()
    // Waiting for news takes up to a minute, and that's fine.
    private val waiting: OkHttpClient = http.newBuilder().callTimeout(70, TimeUnit.SECONDS).readTimeout(70, TimeUnit.SECONDS).build()

    private var storedToken: String? = null
    private var tokenRead = false
    var token: String?
        get() {
            if (!tokenRead) {
                storedToken = Secure.read(TOKEN_KEY)
                tokenRead = true
            }
            return storedToken
        }
        set(value) {
            storedToken = value
            tokenRead = true
            Secure.write(TOKEN_KEY, value)
        }

    fun request(method: String, path: String, body: RequestBody? = null, headers: Map<String, String> = emptyMap()): Request {
        val builder = Request.Builder().url(ServerConfig.baseURL + path)
            .header("X-Device-Id", ServerConfig.deviceId)
            .header("X-Client", "drivezzz-android/1")
        for ((k, v) in headers) builder.header(k, v)
        token?.let { builder.header("Authorization", "Bearer $it") }
        return builder.method(method, body).build()
    }

    private suspend fun <T> perform(req: Request, serializer: KSerializer<T>): T = suspendCancellableCoroutine { out ->
        val call = (if (req.url.queryParameter("wait") != null) waiting else http).newCall(req)
        out.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (out.isCancelled) return
                out.resumeWithException(ApiError.offline())
            }

            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        val text = response.body?.string() ?: ""
                        DataMeter.add(text.length.toLong() + (req.body?.contentLength() ?: 0))
                        response.header("X-Now")?.toDoubleOrNull()?.let { ServerClock.ahead = it - System.currentTimeMillis() }
                        if (response.code !in 200..299) {
                            val parsed = runCatching { JsonFormat.parseToJsonElement(text) as? JsonObject }.getOrNull()
                            val extra = parsed?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.let { k to it } }?.toMap() ?: emptyMap()
                            out.resumeWithException(
                                ApiError(
                                    response.code,
                                    (parsed?.get("error") as? JsonPrimitive)?.contentOrNull ?: "Something went wrong. Try again.",
                                    (parsed?.get("code") as? JsonPrimitive)?.contentOrNull,
                                    extra,
                                )
                            )
                            return
                        }
                        val decoded = try {
                            JsonFormat.decodeFromString(serializer, text)
                        } catch (e: Exception) {
                            if (BuildConfig.DEBUG) android.util.Log.e("drivezzz", "decode ${req.url.encodedPath}: ${e.message}")
                            out.resumeWithException(ApiError(response.code, "This version of the app can’t read that. Update the app."))
                            return
                        }
                        out.resume(decoded)
                    } catch (e: IOException) {
                        if (!out.isCancelled) out.resumeWithException(ApiError.offline())
                    }
                }
            }
        })
    }

    suspend inline fun <reified T> get(path: String): T = getWith(path, serializer())
    suspend fun <T> getWith(path: String, serializer: KSerializer<T>): T = perform(request("GET", path), serializer)

    suspend inline fun <reified T> send(method: String, path: String, body: Map<String, Any?> = emptyMap()): T = sendWith(method, path, body, serializer())
    suspend fun <T> sendWith(method: String, path: String, body: Map<String, Any?>, serializer: KSerializer<T>): T =
        perform(request(method, path, body.toJsonElement().toString().toRequestBody(json)), serializer)

    suspend inline fun <reified T> post(path: String, body: Map<String, Any?> = emptyMap()): T = send("POST", path, body)

    suspend fun call(method: String, path: String, body: Map<String, Any?> = emptyMap()) {
        sendWith(method, path, body, serializer<Empty>())
    }

    // `headers`: the photo's signature (AppAttest.headers), where there is one.
    suspend inline fun <reified T> upload(path: String, jpeg: ByteArray, headers: Map<String, String> = emptyMap()): T = uploadWith(path, jpeg, serializer(), headers)
    suspend fun <T> uploadWith(path: String, jpeg: ByteArray, serializer: KSerializer<T>, headers: Map<String, String> = emptyMap()): T =
        perform(request("POST", path, jpeg.toRequestBody("image/jpeg".toMediaType()), headers), serializer)

    fun imageURL(path: String?): String? = when {
        path == null -> null
        path.startsWith("http") -> path
        else -> ServerConfig.baseURL + path
    }

    // For when the app is closing: there's no time for anything to come back. Only from a background thread.
    fun fireAndWait(method: String, path: String) {
        runCatching { http.newCall(request(method, path, "{}".toRequestBody(json))).execute().close() }
    }
}

// `try?`: the answer, or null when it failed. Being cancelled is not failing.
suspend inline fun <T> attempt(block: () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (_: Exception) {
    null
}

// What to tell someone when it failed.
val Throwable.shown: String get() = message ?: "Something went wrong. Try again."
