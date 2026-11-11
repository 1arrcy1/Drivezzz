package eu.drivezzz.app

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.LocationService
import eu.drivezzz.app.core.Notifier
import eu.drivezzz.app.core.Prefs
import eu.drivezzz.app.core.Secure
import eu.drivezzz.app.core.ServerConfig
import eu.drivezzz.app.core.WalletLog
import eu.drivezzz.app.core.Wallets

class DrivezzzApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        ServerConfig.init(this)
        Secure.init(this, ServerConfig.isTest)
        Notifier.init(this)
        eu.drivezzz.app.core.Push.appContext = this
        eu.drivezzz.app.core.Push.init(this)
        WalletLog.init(this)
        Wallets.init(this)
        LocationService.init(this)
        eu.drivezzz.app.map.Places.init(this)
        AppState.init()
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) {
                LocationService.refresh()
                Wallets.resume()
                AppState.checkOutside()
                AppState.sceneChanged(true)
            }

            override fun onStop(owner: LifecycleOwner) {
                AppState.sceneChanged(false)
            }
        })
    }
}
