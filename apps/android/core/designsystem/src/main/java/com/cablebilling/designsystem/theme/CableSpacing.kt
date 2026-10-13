package com.cablebilling.designsystem.theme

import androidx.compose.ui.unit.Dp
import com.cablebilling.designsystem.generated.Tokens

/**
 * Spacing steps: multiples of `Tokens.Space.Base` (4dp), named like the web's Tailwind spacing
 * (`p-4` on web = `CableSpacing.S4` here), so both platforms use the same rhythm. Screens use these
 * instead of `.dp` literals (detekt `RawDimensionLiteral`).
 */
object CableSpacing {
    val S1: Dp = Tokens.Space.Base * 1
    val S2: Dp = Tokens.Space.Base * 2
    val S3: Dp = Tokens.Space.Base * 3
    val S4: Dp = Tokens.Space.Base * 4
    val S6: Dp = Tokens.Space.Base * 6
    val S8: Dp = Tokens.Space.Base * 8
}
