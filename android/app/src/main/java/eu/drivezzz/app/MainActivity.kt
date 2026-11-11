package eu.drivezzz.app

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.LocationService
import eu.drivezzz.app.core.Permissions
import eu.drivezzz.app.core.Wallets
import eu.drivezzz.app.features.RootView
import eu.drivezzz.app.ui.DrivezzzTheme
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    private val asking = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { answers ->
        if (answers.keys.any { it.contains("LOCATION") }) LocationService.answered()
        Permissions.answered()
    }

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        applyDebugServer(intent)
        Permissions.launcher = asking
        handle(intent)
        setContent {
            val dark = AppState.isDark
            // Again after the window changes size: it would otherwise lose them.
            LaunchedEffect(dark, androidx.compose.ui.platform.LocalConfiguration.current.screenWidthDp) {
                val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT) else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
                enableEdgeToEdge(style, style)
            }
            LaunchedEffect(Unit) {
                AppState.startIfNeeded()
                while (true) {
                    AppState.checkOutside()
                    delay(60_000)
                }
            }
            DrivezzzTheme {
                RootView(Modifier.semantics { testTagsAsResourceId = true })
            }
        }
    }

    override fun onDestroy() {
        if (Permissions.launcher === asking) Permissions.launcher = null
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        intent?.data?.let { Wallets.handle(it) }
    }

    // A debug build's server, set from the Mac. See ServerConfig. Takes effect the next time the app starts.
    private fun applyDebugServer(intent: Intent?) {
        if (!BuildConfig.DEBUG) return
        val url = intent?.getStringExtra("serverURLOverride") ?: return
        getSharedPreferences("settings", Context.MODE_PRIVATE).edit().putString("serverURLOverride", url).commit()
        if (eu.drivezzz.app.core.ServerConfig.baseURL != url.trimEnd('/')) {
            Runtime.getRuntime().exit(0)
        }
    }
}
