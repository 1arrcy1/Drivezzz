package eu.drivezzz.app.core

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import eu.drivezzz.app.BuildConfig
import eu.drivezzz.app.MainActivity
import eu.drivezzz.app.R

// A notification from the app itself, for when it's running in the background.
object Notifier {
    const val RIDES = "rides"
    const val DRIVE = "drive"
    private lateinit var context: Context

    fun init(context: Context) {
        this.context = context.applicationContext
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(RIDES, "Rides and messages", NotificationManager.IMPORTANCE_HIGH))
        manager.createNotificationChannel(NotificationChannel(DRIVE, "Sharing your location", NotificationManager.IMPORTANCE_LOW))
    }

    val opensApp: PendingIntent
        get() = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

    val allowed get() = ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun say(key: String, title: String, body: String) {
        if (!allowed) return
        val notification = NotificationCompat.Builder(context, RIDES)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(opensApp)
            .build()
        runCatching { NotificationManagerCompat.from(context).notify(key.hashCode(), notification) }
    }
}

// Push from the server, through Firebase Cloud Messaging. It's on in a build made with the Firebase project's
// android/app/google-services.json (read into BuildConfig by build.gradle.kts, no Google plugin), and only once the server says it
// pushes through Firebase too (AppState.pushToken). Without either, AppState says everything itself while the app runs, and
// DriveService keeps it running during a ride. A phone without Google Play services gets no token, and works the same way.
object Push {
    val configured: Boolean get() = BuildConfig.FCM_APP_ID.isNotEmpty()

    fun init(context: Context) {
        if (!configured || FirebaseApp.getApps(context).isNotEmpty()) return
        runCatching {
            FirebaseApp.initializeApp(
                context,
                FirebaseOptions.Builder()
                    .setApplicationId(BuildConfig.FCM_APP_ID)
                    .setApiKey(BuildConfig.FCM_API_KEY)
                    .setProjectId(BuildConfig.FCM_PROJECT_ID)
                    .setGcmSenderId(BuildConfig.FCM_SENDER_ID)
                    .build(),
            )
        }
    }

    // This phone's token for the server, once Firebase has one.
    fun register(onToken: (String) -> Unit) {
        if (!configured || FirebaseApp.getApps(appContext).isEmpty()) return
        runCatching { FirebaseMessaging.getInstance().token.addOnSuccessListener { if (!it.isNullOrBlank()) onToken(it) } }
    }

    internal lateinit var appContext: Context
}

// What Firebase hands the app. With the app in the background Android shows a push itself, on the "Rides and messages" channel
// (the manifest's default); here only what comes while the app runs, which the app then fetches at once.
class PushService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        AppState.pushToken(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        AppState.pushed()
        val n = message.notification ?: return
        if (!AppState.isActive) Notifier.say(message.messageId ?: (n.title + n.body), n.title ?: "Drivezzz", n.body ?: "")
    }
}
