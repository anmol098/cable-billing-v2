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
    /** Amounts inside a list row (a customer's due): `Tokens.Type.Xl`. */
    val amountSmall: TextStyle,
    /** Number-pad digits: `Tokens.Type.Xxl`. */
    val key: TextStyle,
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
        amountSmall = numeric.copy(fontSize = Tokens.Type.Xl, fontWeight = Tokens.Weight.Strong),
        key = numeric.copy(fontSize = Tokens.Type.Xxl, fontWeight = Tokens.Weight.Strong),
        body = numeric.copy(fontSize = Tokens.Type.Base, fontWeight = Tokens.Weight.Regular),
    )
}
