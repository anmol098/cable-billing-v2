package com.cablebilling.designsystem.money

/**
 * Money for the UI (CLAUDE.md: integer paise, whole rupees on screen, no floats). Same rules as the
 * web's `packages/ui/src/lib/money.ts`, so both apps show the same text:
 *
 * - `12345600` paise → `"₹1,23,456"` (Indian grouping: the last three digits, then pairs).
 * - Paise appear only when the amount is not whole rupees: `1250` → `"₹12.50"`.
 * - [format] shows the absolute value; the caller decides how to show the sign (credit colour and
 *   word, never a minus sign; see [com.cablebilling.designsystem.component.AmountDisplay]).
 *
 * Digits stay Latin (0–9) in Hindi too (PLAN §11.4).
 */
object Rupees {
    /** Paise in one rupee. */
    const val PAISE_PER_RUPEE: Long = 100L

    /**
     * At most 13 rupee digits (₹99,99,99,99,99,999), the web's limit; `rupees × 100` then always fits
     * in a Long.
     */
    const val MAX_RUPEE_DIGITS: Int = 13

    private const val GROUP_TAIL = 3
    private const val GROUP_PAIR = 2

    /** `"1234567"` → `"12,34,567"`. [digits] must be ASCII digits only. */
    fun groupIndian(digits: String): String {
        require(digits.all { it in '0'..'9' }) { "not digits: $digits" }
        if (digits.length <= GROUP_TAIL) return digits
        val head = digits.dropLast(GROUP_TAIL)
        val tail = digits.takeLast(GROUP_TAIL)
        val pairs =
            head
                .reversed()
                .chunked(GROUP_PAIR)
                .joinToString(",")
                .reversed()
        return "$pairs,$tail"
    }

    /** Integer paise → `"₹1,23,456"` for the absolute value (`"₹12.50"` when not whole). */
    fun format(paise: Long): String {
        // Unsigned so Long.MIN_VALUE has an absolute value too.
        val abs: ULong = if (paise < 0) (-(paise + 1)).toULong() + 1u else paise.toULong()
        val rupees = abs / PAISE_PER_RUPEE.toULong()
        val rest = abs % PAISE_PER_RUPEE.toULong()
        val fraction = if (rest == 0uL) "" else "." + rest.toString().padStart(GROUP_PAIR, '0')
        return "₹" + groupIndian(rupees.toString()) + fraction
    }

    /**
     * Whole-rupee digits typed on the [com.cablebilling.designsystem.component.NumberPad] → paise.
     * `""` → `null` (nothing typed); `"450"` → `45000`; leading zeros are fine (`"007"` → `700`).
     * Throws [IllegalArgumentException] for anything but ASCII digits or more than
     * [MAX_RUPEE_DIGITS] significant digits.
     */
    fun digitsToPaise(digits: String): Long? {
        if (digits.isEmpty()) return null
        require(digits.all { it in '0'..'9' }) { "not digits: $digits" }
        val significant = digits.trimStart('0').ifEmpty { "0" }
        require(significant.length <= MAX_RUPEE_DIGITS) { "too many digits: ${significant.length}" }
        return significant.toLong() * PAISE_PER_RUPEE
    }
}
