package eu.drivezzz.app.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

enum class PanelDetent { Peek, Middle, Full }

// The height of the bar under a panel, which a keyboard covers too.
val LocalBarHeight = compositionLocalOf { 0.dp }

// The panel over a map: swipe it down to see the map, up for all of it. Where there's room it stands at the side instead.
class PanelState(initial: PanelDetent) {
    var detent by mutableStateOf(initial)
    // Where the panel came to rest. A map lays itself out for that once, after the panel has stopped: following it frame by frame is what costs.
    var rest by mutableStateOf(initial)
        internal set
}

@Composable
fun rememberPanelState(initial: PanelDetent = PanelDetent.Middle) = remember { PanelState(initial) }

// How much of a map this panel covers, so the map can keep what matters above it.
@Composable
fun panelCover(d: PanelDetent, peek: Dp, total: Dp, middleShare: Float = 0.62f): Dp = when (d) {
    PanelDetent.Peek -> peek
    PanelDetent.Middle, PanelDetent.Full -> panelMiddle(total, middleShare)
}

// The middle height, measured as on iOS: there the tab bar floats over the panel's foot and the share counts it in, without the
// status bar. Measured above the bar instead, the panel took 65% of the screen where iOS takes 58%, and the map lost that room.
@Composable
private fun panelMiddle(total: Dp, share: Float): Dp {
    val bar = LocalBarHeight.current
    val top = with(LocalDensity.current) { WindowInsets.statusBars.getTop(this).toDp() }
    return (total + bar - top) * share - bar
}

@Composable
fun BottomPanel(
    state: PanelState,
    modifier: Modifier = Modifier,
    peek: Dp = 150.dp,
    middleShare: Float = 0.62f,
    footer: (@Composable () -> Unit)? = null,
    content: @Composable () -> Unit,
) {
    BoxWithConstraints(modifier.fillMaxSize()) {
        val density = LocalDensity.current
        val total = constraints.maxHeight.toFloat()
        val wide = Room.wide(maxWidth)
        val peekPx = with(density) { peek.toPx() }
        val middlePx = with(density) { panelMiddle(maxHeight, middleShare).toPx() }
        fun heightOf(d: PanelDetent): Float = when (d) {
            PanelDetent.Peek -> peekPx
            PanelDetent.Middle -> middlePx
            PanelDetent.Full -> total - with(density) { 8.dp.toPx() }
        }

        val scope = rememberCoroutineScope()
        val shown = remember { Animatable(heightOf(state.detent)) }
        var dragged by remember { mutableFloatStateOf(0f) }
        val scroll = rememberScrollState()
        // Whether this swipe began with the list at the top. If not the finger is scrolling, also once the list reaches the top under it.
        var startedAtTop by remember { mutableStateOf(true) }

        // A new resting place, or another height for this one (the screen turned, the peek changed).
        LaunchedEffect(state.detent, total, peekPx) {
            launch { shown.animateTo(heightOf(state.detent), spring(dampingRatio = 0.88f, stiffness = 280f)) }
            // As long as the spring takes: a map laying itself out under a panel that still moves is what stutters.
            delay(540)
            state.rest = state.detent
            if (state.detent == PanelDetent.Peek) scroll.scrollTo(0)
        }

        fun move(by: Float) {
            dragged += by
            scope.launch { shown.snapTo((shown.value + by).coerceIn(peekPx, heightOf(PanelDetent.Full))) }
        }

        // Where a swipe ends. From all the way down or up, any swipe more than a nudge goes to the middle: that's where a panel likes to stay.
        // Going all the way down takes the finger itself most of the way there, so a swipe made to scroll never ends up down there.
        fun settle(velocity: Float) {
            // Positive: down. The finger's own way plus where its speed would take it; a velocity is positive going down too.
            val moved = -dragged + velocity * 0.18f
            val finger = shown.value
            val middle = heightOf(PanelDetent.Middle)
            val full = heightOf(PanelDetent.Full)
            val pulledDown = finger < peekPx + (middle - peekPx) * 0.3f
            val best = when (state.detent) {
                PanelDetent.Peek -> if (moved >= -16 * density.density) PanelDetent.Peek else if (finger > (middle + full) / 2) PanelDetent.Full else PanelDetent.Middle
                PanelDetent.Full -> if (moved <= 16 * density.density) PanelDetent.Full else if (pulledDown) PanelDetent.Peek else PanelDetent.Middle
                PanelDetent.Middle -> when {
                    moved > 0 -> if (pulledDown) PanelDetent.Peek else PanelDetent.Middle
                    abs(full - (middle - moved)) < abs(moved) -> PanelDetent.Full
                    else -> PanelDetent.Middle
                }
            }
            dragged = 0f
            if (best == state.detent) {
                scope.launch { shown.animateTo(heightOf(best), spring(dampingRatio = 0.88f, stiffness = 280f)) }
            } else {
                state.detent = best
            }
        }

        // Up: the panel grows first, then the list scrolls. Down: only a swipe that started with the list at the top moves the panel.
        val connection = remember(total, peekPx) {
            object : NestedScrollConnection {
                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    if (source != NestedScrollSource.UserInput || available.y >= 0) return Offset.Zero
                    val room = heightOf(PanelDetent.Full) - shown.value
                    if (room <= 0.5f) return Offset.Zero
                    val take = max(available.y, -room)
                    move(-take)
                    return Offset(0f, take)
                }

                override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
                    if (source != NestedScrollSource.UserInput || available.y <= 0 || !startedAtTop) return Offset.Zero
                    val room = shown.value - peekPx
                    if (room <= 0.5f) return Offset.Zero
                    val take = min(available.y, room)
                    move(-take)
                    return Offset(0f, take)
                }

                override suspend fun onPreFling(available: Velocity): Velocity {
                    if (dragged == 0f) return Velocity.Zero
                    settle(available.y)
                    return available
                }
            }
        }

        val shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
        val ime = WindowInsets.ime.getBottom(density)
        val bar = with(density) { LocalBarHeight.current.toPx() }
        val keyboard = with(density) { max(0f, ime - bar).toDp() }

        Column(
            Modifier
                .align(Alignment.BottomEnd)
                .padding(end = if (wide) Room.EDGE else 0.dp)
                .then(if (wide) Modifier.width(Room.PANEL) else Modifier.fillMaxWidth())
                .layout { measurable, c ->
                    val h = shown.value.roundToInt().coerceAtMost(c.maxHeight)
                    val p = measurable.measure(c.copy(minHeight = h, maxHeight = h))
                    layout(p.width, h) { p.place(0, 0) }
                }
                .shadowPlate(28.dp, 0.16f, 24.dp, (-4).dp)
                .clip(shape)
                .background(Theme.card)
                .draggable(
                    rememberDraggableState { delta -> move(-delta) },
                    Orientation.Vertical,
                    onDragStopped = { velocity -> settle(velocity) },
                ),
        ) {
            Box(Modifier.fillMaxWidth().padding(top = 9.dp, bottom = 8.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(width = 36.dp, height = 5.dp).background(Theme.ink.copy(alpha = 0.16f), CircleShape))
            }
            Column(
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                            startedAtTop = scroll.value == 0
                        }
                    }
                    .nestedScroll(connection)
                    // Down, the panel shows its first line and nothing else: a list scrolling in that strip would end on whatever comes last.
                    .verticalScroll(scroll, enabled = state.detent != PanelDetent.Peek),
            ) {
                content()
                Spacer(Modifier.height(16.dp))
            }
            // Down, only the first line of the list stays: no buttons.
            if (state.detent != PanelDetent.Peek && footer != null) footer()
            Spacer(Modifier.height(keyboard))
        }
    }
}
