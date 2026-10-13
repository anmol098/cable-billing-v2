package com.cablebilling.designsystem.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import com.cablebilling.designsystem.generated.Tokens

/**
 * Colours with a fixed meaning (PLAN §6.1 `semantic`), the same on web and Android.
 * Pair each with its icon and word (PLAN §2.2): cash = green, UPI = blue, pending = amber, …
 * Read them with `CableTheme.semanticColors`.
 */
@Immutable
data class SemanticColors(
    val cash: Color,
    val upi: Color,
    val pending: Color,
    val success: Color,
    val danger: Color,
    val due: Color,
    val credit: Color,
) {
    companion object {
        /** The values from tokens.json. */
        val Default =
            SemanticColors(
                cash = Tokens.Color.Cash,
                upi = Tokens.Color.Upi,
                pending = Tokens.Color.Pending,
                success = Tokens.Color.Success,
                danger = Tokens.Color.Danger,
                due = Tokens.Color.Due,
                credit = Tokens.Color.Credit,
            )
    }
}

/** Provided by [CableTheme]; defaults to the token values so previews and tests work without a theme. */
val LocalSemanticColors = staticCompositionLocalOf { SemanticColors.Default }
