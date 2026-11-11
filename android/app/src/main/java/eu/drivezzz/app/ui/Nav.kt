package eu.drivezzz.app.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.wrapContentWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.DialogProperties

// A screen that's kept going but isn't showing: it holds its state, its loading and its map, as a tab or a page under another does on
// iOS. Placed outside the window, so nothing draws it and no finger reaches it, and out of what a screen reader sees.
fun Modifier.keptAlive(showing: Boolean): Modifier =
    if (showing) this else this
        .clearAndSetSemantics { }
        .layout { measurable, constraints ->
            val placeable = measurable.measure(constraints)
            layout(placeable.width, placeable.height) { placeable.place(-100_000, 0) }
        }

// A page that stops growing and stays in the middle, for everything without a map. Backgrounds still reach the sides.
fun Modifier.pageWidth(): Modifier = fillMaxWidth().wrapContentWidth(Alignment.CenterHorizontally).widthIn(max = Room.PAGE)

// How a screen uses the room it has. An open foldable is wider than any phone, and split screen halves it: an app can be any size,
// so this looks at the room itself, never at the device or the way it's held.
object Room {
    val WIDE_FROM = 640.dp // from here a panel stands beside the map
    val PANEL = 400.dp // that panel: the width of a phone, and on an open foldable clear of the fold
    val EDGE = 12.dp // between it and the side of the screen
    val PAGE = 620.dp // a page of text or a list stops growing here

    fun wide(width: Dp): Boolean = width >= WIDE_FROM
}

// A stack of pages, as NavigationStack. What's under the top stays alive: going back finds it as it was.
class Navigator {
    val pages = mutableStateListOf<Page>()
    private var nextId = 0L

    class Page(val id: Long, val content: @Composable () -> Unit)

    fun push(content: @Composable () -> Unit) {
        pages.add(Page(nextId++, content))
    }

    fun pop() {
        if (pages.isNotEmpty()) pages.removeAt(pages.lastIndex)
    }

    fun popToRoot() = pages.clear()
}

val LocalNav = compositionLocalOf<Navigator?> { null }
val LocalInSheet = compositionLocalOf { false }

@Composable
fun NavStack(root: @Composable () -> Unit) {
    val nav = remember { Navigator() }
    CompositionLocalProvider(LocalNav provides nav) {
        BackHandler(enabled = nav.pages.isNotEmpty()) { nav.pop() }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val width = constraints.maxWidth.toFloat()
            Box(Modifier.fillMaxSize().keptAlive(nav.pages.isEmpty())) { root() }
            nav.pages.forEachIndexed { i, page ->
                key(page.id) {
                    val offset = remember { Animatable(width) }
                    LaunchedEffect(Unit) { offset.animateTo(0f, tween(240)) }
                    Box(Modifier.fillMaxSize().keptAlive(i == nav.pages.lastIndex).graphicsLayer { translationX = offset.value }) {
                        page.content()
                    }
                }
            }
        }
    }
}

// A page with a bar on top. Large: the big title of a tab's first page. Otherwise a small title, with back when there's something to
// go back to, or `close` on a page that opens as a sheet. Below it what doesn't scroll away, as `.safeAreaInset(edge: .bottom)`.
@Composable
fun Screen(
    title: String,
    modifier: Modifier = Modifier,
    large: Boolean = false,
    close: (() -> Unit)? = null,
    closeText: String = "Close",
    actions: @Composable RowScope.() -> Unit = {},
    bottom: (@Composable () -> Unit)? = null,
    background: androidx.compose.ui.graphics.Color = Theme.page,
    scroll: Boolean = true,
    padding: PaddingValues = PaddingValues(16.dp),
    spacing: Dp = 16.dp,
    titleContent: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val nav = LocalNav.current
    val inSheet = LocalInSheet.current
    val canPop = nav != null && nav.pages.isNotEmpty()
    Column(modifier.fillMaxSize().background(background).then(if (inSheet) Modifier else Modifier.statusBarsPadding())) {
        // A short title sits in the middle of the bar, whatever is left and right of it, as on iOS.
        val centred = !large && titleContent == null
        Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
            if (centred) {
                Text(title, style = T.headline, color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 84.dp))
            }
            Row(
                // A large title leaves the empty bar above it, as on iOS.
                Modifier.fillMaxWidth().padding(top = if (large) 34.dp else 0.dp).heightIn(min = if (large) 56.dp else 52.dp).padding(horizontal = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (canPop) {
                    IconRound(Sym.back, "Back") { nav?.pop() }
                } else if (close != null) {
                    TextAction(closeText, close)
                } else if (!large) {
                    Spacer(Modifier.size(10.dp))
                }
                Box(Modifier.weight(1f).padding(horizontal = if (large) 10.dp else 6.dp)) {
                    if (titleContent != null) {
                        titleContent()
                    } else if (!centred) {
                        Text(title, style = T.size(34).bold.kern(-0.7f), color = Theme.ink, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                actions()
            }
        }
        val body = Modifier.weight(1f).fillMaxWidth().pageWidth()
        Box(body) {
            if (scroll) {
                Column(
                    Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(padding),
                    verticalArrangement = Arrangement.spacedBy(spacing),
                    content = content,
                )
            } else {
                Column(Modifier.fillMaxSize().padding(padding), verticalArrangement = Arrangement.spacedBy(spacing), content = content)
            }
        }
        if (bottom != null) {
            Box(
                Modifier.fillMaxWidth().background(Theme.card).then(if (inSheet) Modifier else Modifier).padding(horizontal = 16.dp, vertical = 8.dp).navigationBarsPadding()
            ) { bottom() }
        }
    }
}

// A word in a bar: Close, Done, Save.
@Composable
fun TextAction(text: String, onClick: () -> Unit, enabled: Boolean = true) {
    Box(
        Modifier
            .heightIn(min = 44.dp)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 12.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, style = T.subheadline.semibold, color = if (enabled) Theme.accentInk else Theme.faint)
    }
}

@Composable
fun IconRound(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, tint: androidx.compose.ui.graphics.Color = Theme.ink, onClick: () -> Unit) {
    Box(
        Modifier.size(44.dp).clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = tint, modifier = Modifier.size(22.dp))
    }
}

// A sheet, up from the bottom, as `.sheet` on iOS. Tall when `tall`, otherwise as high as what's in it.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DzSheet(onDismiss: () -> Unit, tall: Boolean = true, background: androidx.compose.ui.graphics.Color = if (tall) Theme.page else Theme.card, content: @Composable () -> Unit) {
    val state = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = state,
        containerColor = background,
        contentColor = Theme.ink,
        scrimColor = androidx.compose.ui.graphics.Color.Black.copy(alpha = 0.32f),
        dragHandle = {
            Box(Modifier.fillMaxWidth().padding(top = 9.dp, bottom = 6.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(width = 36.dp, height = 5.dp).background(Theme.ink.copy(alpha = 0.16f), androidx.compose.foundation.shape.CircleShape))
            }
        },
    ) {
        // A sheet has pages of its own, if any: the back arrow of the page under it isn't for what's in here.
        CompositionLocalProvider(LocalInSheet provides true, LocalNav provides null) {
            Box(if (tall) Modifier.fillMaxSize() else Modifier.fillMaxWidth()) { content() }
        }
    }
}

// A dialog that fills the window.
@Composable
fun FullScreen(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    androidx.compose.ui.window.Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        content = content,
    )
}
