package com.cablebilling.designsystem.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.TextUnit
import com.cablebilling.designsystem.generated.Tokens

/**
 * Number styles that MaterialTheme.typography has no slot for. Read them with
 * `CableTheme.numericTypography`. Both use Inter with tabular figures (`'tnum'`), so amounts line up.
 */
@Immutable
data class NumericTypography(
    /** Big amounts (₹ due, totals): `Tokens.Type.Amount`. */
    val amount: TextStyle,
    /** Numbers inside body text (codes, counts, small amounts): `Tokens.Type.Base`. */
    val body: TextStyle,
)

val LocalNumericTypography = staticCompositionLocalOf { numericTypography() }

internal fun numericTypography(): NumericTypography {
    val numeric =
        TextStyle(
            fontFamily = CableFonts.Numeric,
            fontFeatureSettings = Tokens.Font.NumericFeatureSettings,
            lineHeight = TextUnit.Unspecified,
        )
    return NumericTypography(
        amount = numeric.copy(fontSize = Tokens.Type.Amount, fontWeight = Tokens.Weight.Strong),
        body = numeric.copy(fontSize = Tokens.Type.Base, fontWeight = Tokens.Weight.Regular),
    )
}
