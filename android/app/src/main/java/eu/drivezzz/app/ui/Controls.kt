package eu.drivezzz.app.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.IndicationNodeFactory
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.PressInteraction
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.toRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.graphics.drawscope.ContentDrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.node.DelegatableNode
import androidx.compose.ui.node.DrawModifierNode
import androidx.compose.ui.node.invalidateDraw
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import kotlinx.coroutines.launch

// The small things that say which platform you're on. iOS is the design here (docs/android.md, One look), so these are drawn by hand
// to its measures instead of being Material's.

// A press dims what's pressed, as on an iPhone. No ripple. Set for the whole app in DrivezzzTheme.
internal object PressDim : IndicationNodeFactory {
    override fun create(interactionSource: InteractionSource): DelegatableNode = PressDimNode(interactionSource)
    override fun hashCode() = 7
    override fun equals(other: Any?) = other === this
}

private class PressDimNode(private val source: InteractionSource) : Modifier.Node(), DrawModifierNode {
    private var pressed = false
    private val paint = Paint().apply { alpha = 0.55f }

    override fun onAttach() {
        coroutineScope.launch {
            var down = 0
            source.interactions.collect {
                when (it) {
                    is PressInteraction.Press -> down++
                    is PressInteraction.Release, is PressInteraction.Cancel -> down--
                }
                if (pressed != (down > 0)) {
                    pressed = down > 0
                    invalidateDraw()
                }
            }
        }
    }

    override fun ContentDrawScope.draw() {
        if (!pressed) {
            drawContent()
            return
        }
        drawIntoCanvas { canvas ->
            canvas.saveLayer(size.toRect(), paint)
            drawContent()
            canvas.restore()
        }
    }
}

// Eight spokes, the way iOS's turns.
@Composable
fun Spinner(tint: Color = Theme.accentInk, size: Dp = 22.dp) {
    val turning = rememberInfiniteTransition(label = "spinner")
    val step = turning.animateFloat(0f, 8f, infiniteRepeatable(tween(800, easing = LinearEasing)), label = "spinner")
    Canvas(Modifier.size(size)) {
        val lead = step.value.toInt() % 8
        val r = this.size.minDimension / 2
        for (spoke in 0 until 8) {
            val behind = (lead - spoke + 8) % 8
            rotate(spoke * 45f) {
                drawLine(
                    tint.copy(alpha = 1f - behind * 0.11f),
                    Offset(center.x, center.y - r * 0.52f),
                    Offset(center.x, center.y - r * 0.92f),
                    strokeWidth = r * 0.2f,
                    cap = StrokeCap.Round,
                )
            }
        }
    }
}

// 51 x 31, as iOS's.
@Composable
fun DzSwitch(checked: Boolean, label: String? = null, onChange: (Boolean) -> Unit) {
    val thumb by animateDpAsState(if (checked) 22.dp else 2.dp, spring(dampingRatio = 0.75f, stiffness = 900f), label = "switch")
    val track by animateColorAsState(if (checked) Theme.accent else Theme.line, tween(180), label = "switch")
    Box(
        Modifier
            .size(51.dp, 31.dp)
            .background(track, CircleShape)
            .toggleable(checked, interactionSource = null, indication = null, role = Role.Switch, onValueChange = onChange)
            .then(if (label != null) Modifier.semantics { contentDescription = label } else Modifier),
    ) {
        Box(Modifier.offset(x = thumb, y = 2.dp).size(27.dp).dropShadow(CircleShape, Shadow(radius = 3.dp, color = Color.Black.copy(alpha = 0.22f))).background(Color.White, CircleShape))
    }
}

// A thin line and a round white thumb, as iOS's.
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DzSlider(value: Float, range: ClosedFloatingPointRange<Float>, modifier: Modifier = Modifier, onChange: (Float) -> Unit) {
    val touch = remember { MutableInteractionSource() }
    val line = Theme.line
    val accent = Theme.accent
    Slider(
        value = value,
        onValueChange = onChange,
        modifier = modifier,
        valueRange = range,
        interactionSource = touch,
        thumb = { Box(Modifier.size(28.dp).dropShadow(CircleShape, Shadow(radius = 4.dp, color = Color.Black.copy(alpha = 0.25f))).background(Color.White, CircleShape)) },
        track = { state ->
            val part = ((state.value - range.start) / (range.endInclusive - range.start)).coerceIn(0f, 1f)
            Canvas(Modifier.fillMaxWidth().height(4.dp)) {
                val y = size.height / 2
                drawLine(line, Offset(0f, y), Offset(size.width, y), size.height, StrokeCap.Round)
                drawLine(accent, Offset(0f, y), Offset(size.width * part, y), size.height, StrokeCap.Round)
            }
        },
    )
}

// A question with a few answers, as `.confirmationDialog`: up from the bottom, on two cards.
data class Choice(val text: String, val destructive: Boolean = false, val action: () -> Unit)

@Composable
fun AskDialog(title: String, message: String? = null, choices: List<Choice>, cancelText: String = "Cancel", onDismiss: () -> Unit) {
    var up by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { up = true }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        LighterDim()
        Box(
            Modifier
                .fillMaxSize()
                .clickable(interactionSource = null, indication = null, onClick = onDismiss)
                .systemBarsPadding()
                .padding(10.dp),
            contentAlignment = Alignment.BottomCenter,
        ) {
            AnimatedVisibility(up, enter = slideInVertically(tween(260)) { it }) {
                Column(
                    Modifier.widthIn(max = 440.dp).fillMaxWidth().clickable(interactionSource = null, indication = null) {},
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Theme.card)) {
                        Column(
                            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Text(title, style = T.footnote.semibold, color = Theme.muted, textAlign = TextAlign.Center)
                            if (message != null) Text(message, style = T.footnote, color = Theme.muted, textAlign = TextAlign.Center)
                        }
                        choices.forEach { choice ->
                            Hairline()
                            WideAnswer(choice.text, T.size(19), if (choice.destructive) Theme.danger else Theme.accentInk) {
                                onDismiss()
                                choice.action()
                            }
                        }
                    }
                    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(Theme.card)) {
                        WideAnswer(cancelText, T.size(19).semibold, Theme.accentInk, onDismiss)
                    }
                }
            }
        }
    }
}

@Composable
private fun WideAnswer(text: String, style: TextStyle, color: Color, onClick: () -> Unit) {
    Box(Modifier.fillMaxWidth().height(56.dp).clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, style = style, color = color, textAlign = TextAlign.Center)
    }
}

// A small question in the middle of the screen, as `.alert`, with a field in it if it needs one.
@Composable
fun DzAlert(
    title: String,
    message: String? = null,
    confirm: String,
    cancel: String = "Cancel",
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
    content: (@Composable ColumnScope.() -> Unit)? = null,
) {
    Dialog(onDismissRequest = onDismiss) {
        LighterDim()
        Column(Modifier.width(290.dp).clip(RoundedCornerShape(14.dp)).background(Theme.card)) {
            Column(
                Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 18.dp, bottom = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Text(title, style = T.headline, color = Theme.ink, textAlign = TextAlign.Center)
                if (message != null) Text(message, style = T.footnote, color = Theme.ink, textAlign = TextAlign.Center)
                content?.invoke(this)
            }
            Hairline()
            Row(Modifier.fillMaxWidth().height(46.dp)) {
                AlertAnswer(cancel, T.callout, Modifier.weight(1f), onDismiss)
                Box(Modifier.width(0.5.dp).fillMaxHeight().background(Theme.line))
                AlertAnswer(confirm, T.callout.semibold, Modifier.weight(1f), onConfirm)
            }
        }
    }
}

@Composable
private fun AlertAnswer(text: String, style: TextStyle, modifier: Modifier, onClick: () -> Unit) {
    Box(modifier.fillMaxHeight().clickable(onClick = onClick), contentAlignment = Alignment.Center) {
        Text(text, style = style, color = Theme.accentInk)
    }
}

// iOS dims the screen behind a question less than Android does.
@Composable
private fun LighterDim() {
    val window = (LocalView.current.parent as? DialogWindowProvider)?.window
    SideEffect { window?.setDimAmount(0.32f) }
}
