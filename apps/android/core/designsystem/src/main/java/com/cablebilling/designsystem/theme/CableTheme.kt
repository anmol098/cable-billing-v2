package com.cablebilling.designsystem.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import com.cablebilling.designsystem.generated.Tokens

/**
 * The app theme: design tokens mapped onto MaterialTheme (colours, shapes, typography) plus
 * [LocalSemanticColors] and [LocalNumericTypography]. Wrap every screen (and every UI test) in it.
 *
 * Light only, flat (no shadows, no tonal tint: PLAN §6.3). The body font follows the app language
 * (see [CableFonts]); pass [language] to force one, e.g. in previews.
 */
@Composable
fun CableTheme(
    language: String = LocalConfiguration.current.locales[0].language,
    content: @Composable () -> Unit,
) {
    val typography = remember(language) { cableTypography(CableFonts.sansFor(language)) }
    val numeric = remember { numericTypography() }
    CompositionLocalProvider(
        LocalSemanticColors provides SemanticColors.Default,
        LocalNumericTypography provides numeric,
    ) {
        MaterialTheme(
            colorScheme = CableColorScheme,
            shapes = CableShapes,
            typography = typography,
            content = content,
        )
    }
}

/** Accessors in the style of `MaterialTheme.colorScheme`. */
object CableTheme {
    val semanticColors: SemanticColors
        @Composable @ReadOnlyComposable
        get() = LocalSemanticColors.current

    val numericTypography: NumericTypography
        @Composable @ReadOnlyComposable
        get() = LocalNumericTypography.current
}

/**
 * Every Material colour role points at a token. Containers and surfaces stay flat (bg / surface);
 * the selected-item indicator (secondaryContainer) uses the border grey.
 */
internal val CableColorScheme: ColorScheme =
    lightColorScheme(
        primary = Tokens.Color.Accent,
        onPrimary = Tokens.Color.OnAccent,
        primaryContainer = Tokens.Color.Accent,
        onPrimaryContainer = Tokens.Color.OnAccent,
        inversePrimary = Tokens.Color.OnAccent,
        secondary = Tokens.Color.Accent,
        onSecondary = Tokens.Color.OnAccent,
        secondaryContainer = Tokens.Color.Border,
        onSecondaryContainer = Tokens.Color.Text,
        tertiary = Tokens.Color.Accent,
        onTertiary = Tokens.Color.OnAccent,
        tertiaryContainer = Tokens.Color.Surface,
        onTertiaryContainer = Tokens.Color.Text,
        background = Tokens.Color.Bg,
        onBackground = Tokens.Color.Text,
        surface = Tokens.Color.Bg,
        onSurface = Tokens.Color.Text,
        surfaceVariant = Tokens.Color.Surface,
        onSurfaceVariant = Tokens.Color.TextMuted,
        surfaceTint = Tokens.Color.Bg,
        inverseSurface = Tokens.Color.Text,
        inverseOnSurface = Tokens.Color.Bg,
        error = Tokens.Color.Danger,
        onError = Tokens.Color.OnAccent,
        errorContainer = Tokens.Color.Surface,
        onErrorContainer = Tokens.Color.Danger,
        outline = Tokens.Color.Border,
        outlineVariant = Tokens.Color.Border,
        scrim = Tokens.Color.Text,
        surfaceBright = Tokens.Color.Bg,
        surfaceDim = Tokens.Color.Surface,
        surfaceContainerLowest = Tokens.Color.Bg,
        surfaceContainerLow = Tokens.Color.Surface,
        surfaceContainer = Tokens.Color.Surface,
        surfaceContainerHigh = Tokens.Color.Surface,
        surfaceContainerHighest = Tokens.Color.Surface,
    )

internal val CableShapes =
    Shapes(
        extraSmall = RoundedCornerShape(Tokens.Radius.Sm),
        small = RoundedCornerShape(Tokens.Radius.Sm),
        medium = RoundedCornerShape(Tokens.Radius.Md),
        large = RoundedCornerShape(Tokens.Radius.Lg),
        extraLarge = RoundedCornerShape(Tokens.Radius.Lg),
    )
