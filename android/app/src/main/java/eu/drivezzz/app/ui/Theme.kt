package eu.drivezzz.app.ui

import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.LocalRippleConfiguration
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import eu.drivezzz.app.core.AppAccent
import eu.drivezzz.app.core.AppState

private fun hex(v: Long): Color = Color(0xFF000000L or v)
private fun themed(light: Long, dark: Long): Color = if (AppState.isDark) hex(dark) else hex(light)

val AppAccent.color: Color
    get() = when (this) {
        AppAccent.Blue -> hex(0x1659E0)
        AppAccent.Red -> hex(0xD92D20)
        AppAccent.Yellow -> hex(0xF5C400)
    }

// What's readable on it.
val AppAccent.onColor: Color get() = if (this == AppAccent.Yellow) Theme.night else Color.White

// Drivezzz's look: a calm map, cards that lift off the page with soft shadows, bold type, and one colour of your choice, in light
// and in dark. Green and red for orders and warnings keep their meaning whatever you choose. Everything on screen uses these:
// no fixed white or black, or it breaks in the other appearance.
// `night` is the one dark that stays dark, for what carries white text (the turn banner, the escrow moment, text on yellow).
// Reading any of these in a composable is enough: a new appearance or colour redoes what used it.
object Theme {
    private val a: AppAccent get() = AppState.accent

    val accent: Color get() = a.color
    val onAccent: Color get() = a.onColor
    // For text and small icons on a card: yellow goes with near-black in light, and is itself readable in dark.
    val accentInk: Color
        get() = when (a) {
            AppAccent.Blue -> themed(0x1659E0, 0x7AA5FF)
            AppAccent.Red -> themed(0xC4251A, 0xFF8A80)
            AppAccent.Yellow -> themed(0x0F172A, 0xF5C400)
        }
    val accentSoft: Color
        get() = when (a) {
            AppAccent.Blue -> themed(0xEDF2FE, 0x1B2A4D)
            AppAccent.Red -> themed(0xFDECEA, 0x3D1C1A)
            AppAccent.Yellow -> themed(0xFFF7D1, 0x2B2D33)
        }
    // A route on the map: brighter on a dark one.
    val route: Color
        get() = when (a) {
            AppAccent.Blue -> themed(0x1659E0, 0x5B8DFF)
            AppAccent.Red -> themed(0xD92D20, 0xFF6259)
            AppAccent.Yellow -> hex(0xF5C400)
        }
    // The same as accentInk, on something that stays white, whatever the appearance.
    val accentOnWhite: Color
        get() = when (a) {
            AppAccent.Blue -> hex(0x1659E0)
            AppAccent.Red -> hex(0xC4251A)
            AppAccent.Yellow -> night
        }
    private val top: Color
        get() = when (a) {
            AppAccent.Blue -> hex(0x2F7BFF)
            AppAccent.Red -> hex(0xEF4A3E)
            AppAccent.Yellow -> hex(0xFFD83D)
        }
    private val bottom: Color
        get() = when (a) {
            AppAccent.Blue -> hex(0x0B4FD6)
            AppAccent.Red -> hex(0xB91C13)
            AppAccent.Yellow -> hex(0xF0B800)
        }
    val gradient: Brush get() = Brush.verticalGradient(listOf(top, bottom))
    // The middle line of the road in the logo, and the edge that keeps a route readable on the map.
    val roadDash: Color get() = if (a == AppAccent.Yellow) a.color else accentInk
    val routeEdge: Color get() = if (a == AppAccent.Yellow) night else themed(0xFFFFFF, 0x0F172A)

    val ink: Color get() = themed(0x0F172A, 0xF1F3F7)
    val muted: Color get() = themed(0x4B5563, 0xAEB6C2)
    val faint: Color get() = themed(0x6B7280, 0x8B93A1)
    val line: Color get() = themed(0xE9EBEF, 0x2C313C)
    val soft: Color get() = themed(0xF4F5F7, 0x252933) // a fill inside a card
    val page: Color get() = themed(0xF4F5F7, 0x0B0D12) // behind the cards
    val card: Color get() = themed(0xFFFFFF, 0x171A21)
    val track: Color get() = themed(0xE3E3E8, 0x2C2F38) // behind a segmented control, as iOS's
    val raised: Color get() = themed(0xFFFFFF, 0x3A404D) // what slides over a fill: the switch's thumb
    val night: Color get() = hex(0x0F172A)
    val road: Color get() = themed(0x0F172A, 0x2F3543) // the road of the progress bar and the slide to go offline
    val pickupPin: Color get() = themed(0xF97316, 0xFB923C) // the pickup spot, on every map and in every list: orange (Pieter's choice)
    val ok: Color get() = themed(0x15803D, 0x4ADE80)
    val okSoft: Color get() = themed(0xE7F6EC, 0x12301C)
    val okFill: Color get() = hex(0x15803D) // a green button, with white on it
    val verified: Color get() = themed(0x1659E0, 0x5B9BFF) // the check of a verified driver: always blue, whatever colour the app is set to
    val verifiedSoft: Color get() = themed(0xEDF2FE, 0x1B2A4D)
    val danger: Color get() = themed(0xDC2626, 0xF87171)
    val dangerSoft: Color get() = themed(0xFDEEEE, 0x3A1717)
    val warn: Color get() = themed(0xC2410C, 0xFB923C)
    val warnSoft: Color get() = themed(0xFFF1E6, 0x2F2A2B)
    val ongoing: Color get() = hex(0x0F172A) // a ride under way: yellow, with ink on it so it can be read
    val ongoingSoft: Color get() = hex(0xFEF08A)
    val plate: Color get() = hex(0xF7C600)
    val plateBand: Color get() = hex(0x0B4FD6)
    val now: Color get() = hex(0x15803D) // an order looking for a driver now
    val planned: Color get() = hex(0xFACC15) // an order booked for a time: yellow, with ink on it
    val radius: Dp = 18.dp
    val buttonRadius: Dp = 16.dp
}

// The text sizes, by the names iOS gives them, so screens read the same on both.
object T {
    private fun s(size: Int, line: Int = (size * 1.26f).toInt()) = TextStyle(fontSize = size.sp, lineHeight = line.sp)
    val largeTitle = s(34)
    val title = s(28)
    val title2 = s(22)
    val title3 = s(20)
    val headline = s(17).w(FontWeight.SemiBold)
    val body = s(17)
    val callout = s(16)
    val subheadline = s(15)
    val footnote = s(13)
    val caption = s(12)
    val caption2 = s(11)
    fun size(size: Int) = s(size)
}

fun TextStyle.w(weight: FontWeight) = copy(fontWeight = weight)
val TextStyle.medium get() = w(FontWeight.Medium)
val TextStyle.semibold get() = w(FontWeight.SemiBold)
val TextStyle.bold get() = w(FontWeight.Bold)
val TextStyle.heavy get() = w(FontWeight.ExtraBold)
val TextStyle.italic get() = copy(fontStyle = FontStyle.Italic)
val TextStyle.mono get() = copy(fontFamily = FontFamily.Monospace)
val TextStyle.digits get() = copy(fontFeatureSettings = "tnum")
fun TextStyle.kern(value: Float) = copy(letterSpacing = value.sp)

@Composable
fun DrivezzzTheme(content: @Composable () -> Unit) {
    val dark = AppState.isDark
    val accent = Theme.accent
    val on = Theme.onAccent
    val colors = if (dark) {
        darkColorScheme(
            primary = accent, onPrimary = on, secondary = accent, onSecondary = on, tertiary = accent,
            background = Theme.page, onBackground = Theme.ink, surface = Theme.card, onSurface = Theme.ink,
            surfaceVariant = Theme.soft, onSurfaceVariant = Theme.muted, outline = Theme.line, outlineVariant = Theme.line,
            surfaceContainer = Theme.card, surfaceContainerLow = Theme.card, surfaceContainerHigh = Theme.card, surfaceContainerHighest = Theme.soft,
            surfaceContainerLowest = Theme.card, error = Theme.danger,
            primaryContainer = Theme.accentSoft, onPrimaryContainer = Theme.accentInk, secondaryContainer = Theme.accentSoft, onSecondaryContainer = Theme.accentInk,
        )
    } else {
        lightColorScheme(
            primary = accent, onPrimary = on, secondary = accent, onSecondary = on, tertiary = accent,
            background = Theme.page, onBackground = Theme.ink, surface = Theme.card, onSurface = Theme.ink,
            surfaceVariant = Theme.soft, onSurfaceVariant = Theme.muted, outline = Theme.line, outlineVariant = Theme.line,
            surfaceContainer = Theme.card, surfaceContainerLow = Theme.card, surfaceContainerHigh = Theme.card, surfaceContainerHighest = Theme.soft,
            surfaceContainerLowest = Theme.card, error = Theme.danger,
            primaryContainer = Theme.accentSoft, onPrimaryContainer = Theme.accentInk, secondaryContainer = Theme.accentSoft, onSecondaryContainer = Theme.accentInk,
        )
    }
    MaterialTheme(colorScheme = colors) {
        CompositionLocalProvider(LocalContentColor provides Theme.ink, LocalIndication provides PressDim, LocalRippleConfiguration provides null, content = content)
    }
}

// Two shadows: a tight one for the edge, a wide one for the lift. Drawn once and kept, so scrolling a page of cards costs nothing.
fun Modifier.lifted(strength: Float = 1f, radius: Dp): Modifier = lifted(strength, RoundedCornerShape(radius))

fun Modifier.lifted(strength: Float, shape: Shape): Modifier = this
    .dropShadow(shape, Shadow(radius = 20.dp, color = Color.Black.copy(alpha = (0.11f * strength).coerceAtMost(1f)), offset = DpOffset(0.dp, 8.dp)))
    .dropShadow(shape, Shadow(radius = 2.dp, color = Color.Black.copy(alpha = (0.05f * strength).coerceAtMost(1f)), offset = DpOffset(0.dp, 1.dp)))

fun Modifier.shadowPlate(radius: Dp, opacity: Float, blur: Dp, y: Dp): Modifier =
    dropShadow(RoundedCornerShape(radius), Shadow(radius = blur, color = Color.Black.copy(alpha = opacity), offset = DpOffset(0.dp, y)))

@Composable
fun Modifier.card(radius: Dp = Theme.radius, padding: Dp = 16.dp): Modifier = this
    .lifted(0.6f, radius)
    .background(Theme.card, RoundedCornerShape(radius))
    .padding(padding)

@Composable
fun Modifier.floating(radius: Dp = Theme.radius): Modifier = this
    .lifted(1f, radius)
    .background(Theme.card, RoundedCornerShape(radius))

// A row in your colour with what fits a primary action: pressed, it gives a little.
@Composable
fun PrimaryButton(
    text: String? = null,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    height: Dp = 54.dp,
    color: Color = Theme.accent,
    textColor: Color = Theme.onAccent,
    working: Boolean = false,
    content: (@Composable () -> Unit)? = null,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.98f else 1f, spring(dampingRatio = 0.7f, stiffness = 600f), label = "press")
    val shape = RoundedCornerShape(Theme.buttonRadius)
    Box(
        modifier
            .scale(scale)
            .fillMaxWidth()
            .heightIn(min = height)
            .clip(shape)
            .background(if (enabled) color else Theme.line, shape)
            .clickable(interactionSource = source, indication = null, enabled = enabled && !working, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides if (enabled) textColor else Theme.faint) {
            when {
                working -> Spinner(tint = if (enabled) textColor else Theme.faint)
                content != null -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) { content() }
                else -> Text(text ?: "", style = T.size(17).semibold.kern(-0.2f))
            }
        }
    }
}

// The second choice next to a primary button: a quiet fill, on white and on grey alike.
@Composable
fun GhostButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    height: Dp = 54.dp,
    color: Color = Theme.ink,
    working: Boolean = false,
    icon: (@Composable () -> Unit)? = null,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val scale by animateFloatAsState(if (pressed) 0.98f else 1f, spring(dampingRatio = 0.7f, stiffness = 600f), label = "press")
    val shape = RoundedCornerShape(Theme.buttonRadius)
    Box(
        modifier
            .scale(scale)
            .fillMaxWidth()
            .heightIn(min = height)
            .clip(shape)
            .background(color.copy(alpha = if (pressed) 0.14f else 0.07f), shape)
            .clickable(interactionSource = source, indication = null, enabled = enabled && !working, onClick = onClick)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) {
        CompositionLocalProvider(LocalContentColor provides if (enabled) color else Theme.faint) {
            if (working) {
                Spinner(tint = color)
            } else {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    icon?.invoke()
                    Text(text, style = T.callout.semibold.kern(-0.2f))
                }
            }
        }
    }
}
