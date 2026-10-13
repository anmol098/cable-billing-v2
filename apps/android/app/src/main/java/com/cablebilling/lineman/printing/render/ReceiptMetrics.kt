package com.cablebilling.lineman.printing.render

import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.lineman.printing.receipt.ReceiptTextStyle

/**
 * Sizes on paper, in printer dots. They come from the design tokens (CLAUDE.md: no hard-coded
 * sizes): a token in sp is printed as large as it looks on a phone screen. Android's sp is 1/160 inch
 * at normal font scale, and a 58 mm ESC/POS printer has 203 dots per inch (8 dots per mm), so
 * 1 sp = 203 / 160 ≈ 1.27 dots: body text (18 sp) ≈ 23 dots ≈ 2.9 mm, the amount (44 sp) ≈ 56 dots.
 */
data class ReceiptMetrics(
    /** Body text size per [ReceiptTextStyle], in dots. */
    val small: Float = Tokens.Type.Sm.value * DOTS_PER_SP,
    val body: Float = Tokens.Type.Base.value * DOTS_PER_SP,
    val title: Float = Tokens.Type.Xl.value * DOTS_PER_SP,
    val amount: Float = Tokens.Type.Amount.value * DOTS_PER_SP,
    /** Space between blocks. */
    val gap: Float = Tokens.Space.Base.value * 2 * DOTS_PER_SP,
    /** Left/right margin inside the printable width. */
    val margin: Float = Tokens.Space.Base.value * DOTS_PER_SP,
    /** Thickness of a [com.cablebilling.lineman.printing.receipt.ReceiptLine.Rule]. */
    val rule: Float = Tokens.Border.Strong.value * DOTS_PER_SP,
    /** Blank paper above the first line and below the last one. */
    val edge: Float = Tokens.Space.Base.value * 2 * DOTS_PER_SP,
) {
    fun textSize(style: ReceiptTextStyle): Float =
        when (style) {
            ReceiptTextStyle.Small -> small
            ReceiptTextStyle.Body, ReceiptTextStyle.Strong -> body
            ReceiptTextStyle.Title -> title
        }

    companion object {
        /** Dots per inch of a standard 58 mm / 80 mm thermal printer (8 dots per mm). */
        const val PRINTER_DPI: Float = 203f

        /** Android's baseline density: 1 dp (and 1 sp at font scale 1) = 1/160 inch. */
        const val SP_PER_INCH: Float = 160f

        const val DOTS_PER_SP: Float = PRINTER_DPI / SP_PER_INCH

        val Default = ReceiptMetrics()
    }
}
