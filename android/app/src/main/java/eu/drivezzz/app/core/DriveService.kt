package eu.drivezzz.app.core

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import eu.drivezzz.app.R

// What iOS's blue bar is: online or on a ride, the phone keeps sharing where it is with the app in the background, and the
// notification says so. Android stops a location service started from the background, so it starts while the app is in front.
// Going online keeps you online until you slide back or tap Go offline in this notification, also with the app swiped away
// (Pieter, 6 November 2026): the service and its loops keep running without a screen.
class DriveService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val online = AppState.driveMode
        val notification = NotificationCompat.Builder(this, Notifier.DRIVE)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(if (online) "You’re online" else "Your ride is under way")
            .setContentText(if (online) "You stay online, also with the app closed, until you go offline." else "Your position is shared until the ride is over.")
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(Notifier.opensApp)
            .apply { if (online) addAction(0, "Go offline", goOffline(this@DriveService)) }
            .build()
        try {
            ServiceCompat.startForeground(this, 1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } catch (_: Exception) {
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == GO_OFFLINE) {
            // As sliding back does: the server hears it, and the service stops once nothing else needs it.
            AppState.stopDriving(tellServer = true)
            return START_NOT_STICKY
        }
        // Android ended the app while driving and brought it back: Drive mode picks up again.
        AppState.startIfNeeded()
        return START_STICKY
    }

    // Swiping the app away from recents: the screen goes, being online doesn't. The loops live in AppState, not in the screen.
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
    }

    companion object {
        const val GO_OFFLINE = "eu.drivezzz.app.GO_OFFLINE"

        private fun goOffline(context: Context): PendingIntent = PendingIntent.getService(
            context, 2,
            Intent(context, DriveService::class.java).setAction(GO_OFFLINE),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }
}
