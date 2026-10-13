package com.cablebilling.lineman.printing.render

import android.content.Context
import android.graphics.Typeface
import androidx.core.content.res.ResourcesCompat
import com.cablebilling.designsystem.R as DesignR

/**
 * The bundled fonts (T-008, `core/designsystem/res/font`) used for printing. Text is always drawn
 * with Noto Sans Devanagari, which also has Latin letters, so a Hindi name on an English receipt
 * still prints and nothing depends on the phone's or printer's fonts (D-08: printers have no
 * Devanagari, so we send pictures). Amounts use Inter, like `AmountDisplay` on screen.
 */
data class ReceiptFonts(
    val text: Typeface,
    val textStrong: Typeface,
    val numericStrong: Typeface,
) {
    companion object {
        /** Loads the font files from resources (fast after the first call; Android caches them). */
        fun load(context: Context): ReceiptFonts =
            ReceiptFonts(
                text = font(context, DesignR.font.noto_sans_devanagari_regular),
                textStrong = font(context, DesignR.font.noto_sans_devanagari_semibold),
                numericStrong = font(context, DesignR.font.inter_semibold),
            )

        private fun font(
            context: Context,
            id: Int,
        ): Typeface = checkNotNull(ResourcesCompat.getFont(context, id)) { "font $id missing" }
    }
}
