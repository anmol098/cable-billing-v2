package com.cablebilling.lineman.data.db

import java.text.Normalizer
import java.util.Locale

/**
 * How customers are matched by the search (PLAN §11.3): digits typed on the number pad match any
 * part of the customer code, a phone or a VC number; letters (ABC key) match any part of the name
 * or code. Both sides are normalised the same way here, so the stored columns and the query agree.
 *
 * The roster is small (about 1,000 customers per operator, 7,616 in the largest legacy snapshot),
 * so a `LIKE '%…%'` scan over one short pre-computed column per row is fast on low-end phones and
 * needs no FTS (whose tokenizers do not match inside numbers anyway).
 */
object SearchText {
    private val WHITESPACE = Regex("\\s+")

    /** ` 1045 9876543210 000123456789 ` style: every non-empty digit token, space separated and padded. */
    fun digitsColumn(
        code: String,
        phones: List<String?>,
        vcNumbers: List<String>,
    ): String {
        val tokens = (listOf(code) + phones.filterNotNull() + vcNumbers).map(::digitsOnly).filter { it.isNotEmpty() }
        return tokens.joinToString(separator = " ", prefix = " ", postfix = " ")
    }

    /** The name and code, lower-case, Unicode NFC, single spaces. */
    fun nameColumn(
        name: String,
        code: String,
    ): String = normaliseText("$name $code")

    /** Only the ASCII digits of [text] (a phone like `+91 98765-43210` becomes `919876543210`). */
    fun digitsOnly(text: String): String = text.filter { it in '0'..'9' }

    /** Lower-case (locale independent), NFC, trimmed, inner whitespace collapsed to one space. */
    fun normaliseText(text: String): String =
        Normalizer
            .normalize(text, Normalizer.Form.NFC)
            .lowercase(Locale.ROOT)
            .trim()
            .replace(WHITESPACE, " ")

    /** [text] for a `LIKE … ESCAPE '\'` pattern: `\`, `%` and `_` match themselves. */
    fun escapeLike(text: String): String =
        buildString(text.length) {
            text.forEach { char ->
                if (char == '\\' || char == '%' || char == '_') append('\\')
                append(char)
            }
        }
}
