package com.cablebilling.designsystem.theme

import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.generated.Tokens

/**
 * Bundled fonts (SIL OFL 1.1; licences in src/main/assets/licenses/). Only the two weights the
 * tokens use are shipped: `Tokens.Weight.Regular` (400) and `Tokens.Weight.Strong` (600).
 *
 * Tokens.Font.SansFamilies is the web's CSS fallback chain ("Inter", "Noto Sans Devanagari", …).
 * Compose cannot chain two bundled families per glyph, so [CableTheme] picks one by app language:
 * Noto Sans Devanagari for Hindi (it also has Latin letters), Inter otherwise. Anything a font lacks
 * still falls back to the phone's system fonts. Numbers always use Inter with tabular figures.
 */
object CableFonts {
    val Inter =
        FontFamily(
            Font(R.font.inter_regular, Tokens.Weight.Regular),
            Font(R.font.inter_semibold, Tokens.Weight.Strong),
        )

    val NotoSansDevanagari =
        FontFamily(
            Font(R.font.noto_sans_devanagari_regular, Tokens.Weight.Regular),
            Font(R.font.noto_sans_devanagari_semibold, Tokens.Weight.Strong),
        )

    /** Family for numbers and amounts (Tokens.Font.NumericFamilies = Inter). */
    val Numeric = Inter

    /** Body family for an app language (ISO 639 code, e.g. "hi" or "en"). */
    fun sansFor(language: String): FontFamily = if (language in DEVANAGARI_LANGUAGES) NotoSansDevanagari else Inter

    private val DEVANAGARI_LANGUAGES = setOf("hi", "mr", "ne")
}
