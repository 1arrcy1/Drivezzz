package eu.drivezzz.app.features

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import eu.drivezzz.app.core.ApiClient
import eu.drivezzz.app.core.AppState
import eu.drivezzz.app.core.Eula
import eu.drivezzz.app.core.EulaBlock
import eu.drivezzz.app.core.Markdown
import eu.drivezzz.app.core.shown
import eu.drivezzz.app.ui.ErrorText
import eu.drivezzz.app.ui.GhostButton
import eu.drivezzz.app.ui.PrimaryButton
import eu.drivezzz.app.ui.ScreenTitle
import eu.drivezzz.app.ui.Spinner
import eu.drivezzz.app.ui.T
import eu.drivezzz.app.ui.Theme
import eu.drivezzz.app.ui.pageWidth
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

// The End User Licence Agreement, opened by Continue on the first screen. Accept makes the account, Decline goes back. The words come
// from the server (server/public/eula.html), so they're the website's, and the account keeps which version was accepted.
// `scope` is the first screen's: the sheet going away mustn't cancel an account being made.
@Composable
fun EulaSheet(first: Eula?, scope: CoroutineScope, close: () -> Unit) {
    var eula by remember { mutableStateOf(first) }
    var working by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    suspend fun load() {
        try {
            eula = ApiClient.get<Eula>("/api/eula")
            error = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (eula == null) error = e.shown
        }
    }

    fun primary() {
        val shown = eula
        if (shown == null) {
            error = null
            scope.launch { load() }
            return
        }
        working = true
        error = null
        scope.launch {
            try {
                AppState.continueNew(shown.version)
                close()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = e.shown
                // It may have changed while it was being read: what shows next is what can be accepted.
                load()
            }
            working = false
        }
    }

    LaunchedEffect(Unit) { load() }

    val shown = eula
    Column(Modifier.fillMaxSize()) {
        LazyColumn(
            Modifier.weight(1f).pageWidth(),
            contentPadding = PaddingValues(24.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            item { ScreenTitle("End User Licence Agreement", shown?.updated?.let { "Last updated $it" }) }
            if (shown != null) {
                item {
                    Box(Modifier.fillMaxWidth().background(Theme.accentSoft, RoundedCornerShape(Theme.radius)).padding(16.dp)) {
                        EulaBlocks(shown.short.orEmpty())
                    }
                }
                items(shown.sections.orEmpty(), key = { it.id }) { section ->
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(section.title, style = T.headline, color = Theme.ink)
                        EulaBlocks(section.blocks)
                    }
                }
            } else if (error == null) {
                item { Box(Modifier.fillMaxWidth().padding(top = 40.dp), contentAlignment = Alignment.Center) { Spinner() } }
            }
        }
        Column(
            Modifier.pageWidth().padding(horizontal = 24.dp, vertical = 12.dp).navigationBarsPadding(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            ErrorText(error)
            val link = TextLinkStyles(SpanStyle(color = Theme.accentInk, fontWeight = FontWeight.Medium))
            Text(
                buildAnnotatedString {
                    append("By tapping Accept you confirm you’re 18 or over, and you accept this agreement and the ")
                    withLink(LinkAnnotation.Url("https://drivezzz.s3rver.nl/terms", link)) { append("Terms") }
                    append(". How we handle your data is in the ")
                    withLink(LinkAnnotation.Url("https://drivezzz.s3rver.nl/privacy", link)) { append("Privacy Policy") }
                    append(".")
                },
                style = T.caption,
                color = Theme.muted,
                textAlign = TextAlign.Center,
            )
            PrimaryButton(
                if (shown == null) "Try again" else "Accept",
                working = working,
                enabled = !working && (shown != null || error != null),
                onClick = { primary() },
            )
            GhostButton("Decline", enabled = !working, onClick = close)
        }
    }
}

@Composable
private fun EulaBlocks(blocks: List<EulaBlock>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        blocks.forEach { block ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (block.bullet == true) Text("•", style = T.subheadline, color = Theme.faint)
                Text(styled(block.text), style = T.subheadline, color = Theme.ink)
            }
        }
    }
}

// Bold and links, from the page's text.
@Composable
private fun styled(text: String): AnnotatedString {
    val link = TextLinkStyles(SpanStyle(color = Theme.accentInk, fontWeight = FontWeight.Medium))
    return remember(text, link) {
        buildAnnotatedString {
            Markdown.spans(text).forEach { span ->
                val bold = if (span.bold) SpanStyle(fontWeight = FontWeight.SemiBold) else SpanStyle()
                withStyle(bold) {
                    if (span.url != null) withLink(LinkAnnotation.Url(span.url, link)) { append(span.text) } else append(span.text)
                }
            }
        }
    }
}
