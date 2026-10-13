package com.cablebilling.designsystem.theme

import androidx.compose.ui.unit.Dp
import com.cablebilling.designsystem.generated.Tokens

/**
 * Component sizes, all taken from (or derived from) `Tokens.Size` (PLAN §2.2 rule 9: touch targets
 * at least 56dp, primary buttons 64dp). Change the values in packages/design-tokens/tokens.json.
 */
object CableSizes {
    /** Smallest tappable thing (rows, chips you can tap, speak / voice buttons). */
    val TouchMin: Dp = Tokens.Size.TouchMin

    /** Height of a primary button ([com.cablebilling.designsystem.component.BigButton]). */
    val PrimaryButton: Dp = Tokens.Size.PrimaryButton

    /** Icon next to a word (buttons, chips, rows). */
    val Icon: Dp = Tokens.Size.Icon

    /** Icon on a big tile (Cash / UPI, receipt actions, confirm card). */
    val IconLarge: Dp = Tokens.Size.IconLarge

    /** A number-pad key is as tall as a primary button. */
    val NumberPadKey: Dp = Tokens.Size.PrimaryButton

    /** Big tiles (Cash / UPI, receipt actions) are two primary buttons tall. */
    val Tile: Dp = Tokens.Size.PrimaryButton * 2
}
