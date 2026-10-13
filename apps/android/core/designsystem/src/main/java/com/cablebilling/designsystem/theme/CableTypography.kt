package com.cablebilling.designsystem.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import com.cablebilling.designsystem.generated.Tokens

/**
 * Material 3 type scale built only from tokens (android scale in sp). Body text is never below
 * `Tokens.Type.Base` (18sp, PLAN §2.2); `Sm` is for secondary labels. Line height is left to the font
 * so Devanagari marks above and below the line are never clipped.
 */
internal fun cableTypography(sans: FontFamily): Typography {
    fun style(
        size: TextUnit,
        weight: FontWeight,
    ) = TextStyle(
        fontFamily = sans,
        fontSize = size,
        fontWeight = weight,
        lineHeight = TextUnit.Unspecified,
    )
    val regular = Tokens.Weight.Regular
    val strong = Tokens.Weight.Strong
    val amount = numericTypography().amount
    return Typography(
        displayLarge = amount,
        displayMedium = amount,
        displaySmall = amount,
        headlineLarge = style(Tokens.Type.Xxl, strong),
        headlineMedium = style(Tokens.Type.Xxl, strong),
        headlineSmall = style(Tokens.Type.Xl, strong),
        titleLarge = style(Tokens.Type.Xl, strong),
        titleMedium = style(Tokens.Type.Lg, strong),
        titleSmall = style(Tokens.Type.Base, strong),
        bodyLarge = style(Tokens.Type.Base, regular),
        bodyMedium = style(Tokens.Type.Base, regular),
        bodySmall = style(Tokens.Type.Sm, regular),
        labelLarge = style(Tokens.Type.Base, strong),
        labelMedium = style(Tokens.Type.Sm, strong),
        labelSmall = style(Tokens.Type.Sm, regular),
    )
}
