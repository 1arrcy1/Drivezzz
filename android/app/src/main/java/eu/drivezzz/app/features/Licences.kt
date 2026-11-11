package eu.drivezzz.app.features

import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.ui.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

// What the app is built on. The LGPL and the others ask that their text comes along with the app, so it's in assets/licences, whole.
// When a library comes or goes in build.gradle.kts, change it here: docs/android.md, decision 11.
private class Group(val title: String, val parts: List<Pair<String, String>>, val file: String? = null, val footer: String? = null)

private val groups = listOf(
    Group(
        "GNU Lesser General Public License 2.1",
        listOf(
            "JMRTD" to "Reading an ID's chip",
            "SCUBA" to "Talking to the chip",
            "CVC (EJBCA)" to "Certificates on an ID",
        ),
        "LGPL-2.1.txt",
        "Used as they are, unchanged. JMRTD's and SCUBA's source is at jmrtd.org, CVC's at ejbca.org.",
    ),
    Group(
        "BSD 2-Clause",
        listOf("MapLibre Native" to "The map"),
        "BSD-2-Clause-MapLibre.txt",
    ),
    Group(
        "MIT",
        listOf("Bouncy Castle" to "Encryption"),
        "MIT-BouncyCastle.txt",
    ),
    Group(
        "Apache License 2.0",
        listOf(
            "AndroidX, Jetpack Compose and CameraX" to "The app's screens and camera",
            "Kotlin and kotlinx" to "The language",
            "OkHttp and Okio" to "Talking to the server",
            "ZXing" to "QR codes",
            "JJ2000" to "The photo on an ID",
            "SFace (OpenCV Zoo)" to "Comparing a selfie to that photo",
            "Gson, Guava and Timber" to "Used by the libraries above",
        ),
        "Apache-2.0.txt",
    ),
)

@Composable
fun LicencesScreen() {
    val nav = LocalNav.current
    val context = LocalContext.current
    Screen("Open source licences") {
        Text("Drivezzz is built on the work of others. These are the parts, and the licences they come with.", style = T.subheadline, color = Theme.muted)
        for (group in groups) {
            ListSection(group.title, group.footer) {
                group.parts.forEachIndexed { i, (name, what) ->
                    if (i > 0) CardDivider(16.dp)
                    ListRow { LabeledRow(name, what) }
                }
                if (group.file != null) {
                    CardDivider(16.dp)
                    ListRow(onClick = { nav?.push { LicenceTextScreen(group.title, group.file) } }) {
                        LabeledRow("Read the licence", trailing = {
                            Icon(Sym.chevronRight, null, tint = Theme.faint, modifier = Modifier.size(20.dp))
                        })
                    }
                }
            }
        }
        ListSection("From Google, under its own terms") {
            ListRow(onClick = { openUrl(context, "https://developers.google.com/ml-kit/terms") }) { LabeledRow("ML Kit", "Reading text and finding faces") }
            CardDivider(16.dp)
            ListRow(onClick = { openUrl(context, "https://firebase.google.com/terms") }) { LabeledRow("Firebase Cloud Messaging", "Notifications") }
        }
        ListSection("The map's data") {
            ListRow(onClick = { openUrl(context, "https://www.openstreetmap.org/copyright") }) { LabeledRow("© OpenStreetMap contributors", "ODbL") }
            CardDivider(16.dp)
            ListRow(onClick = { openUrl(context, "https://openmaptiles.org/") }) { LabeledRow("OpenMapTiles", "The map's layers") }
            CardDivider(16.dp)
            ListRow(onClick = { openUrl(context, "https://openfreemap.org/") }) { LabeledRow("OpenFreeMap", "The map's tiles") }
        }
    }
}

@Composable
private fun LicenceTextScreen(title: String, file: String) {
    val context = LocalContext.current
    var text by remember { mutableStateOf("") }
    LaunchedEffect(file) {
        text = withContext(Dispatchers.IO) {
            runCatching { context.assets.open("licences/$file").bufferedReader().use { it.readText() } }.getOrDefault("")
        }
    }
    Screen(title) {
        SelectionContainer { Text(text, style = T.caption2.mono, color = Theme.muted) }
    }
}
