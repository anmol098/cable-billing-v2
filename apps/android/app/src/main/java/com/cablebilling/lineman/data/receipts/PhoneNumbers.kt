package com.cablebilling.lineman.data.receipts

/**
 * Indian mobile numbers for the receipt flow (FR-004, contract `IndianMobile`): exactly 10 digits
 * starting with 6, 7, 8 or 9, without +91 or spaces. Stored numbers may be legacy text
 * ("+91 98765-43210", "098765 43210"); [normalize] turns them into the 10 digits or null.
 */
object PhoneNumbers {
    /** Digits in an Indian mobile number. */
    const val LENGTH = 10

    /** India's country code, for WhatsApp's international form. */
    const val COUNTRY_CODE = "91"

    private val MOBILE = Regex("^[6-9][0-9]{9}$")

    /** True for a 10-digit Indian mobile number (the server's rule). */
    fun isValid(digits: String): Boolean = MOBILE.matches(digits)

    /**
     * The 10-digit number in [raw], or null when it is not an Indian mobile number. Accepts the
     * forms people type or legacy data holds: spaces, dashes, brackets, a leading `+91` / `91` /
     * `0091` / `0`.
     */
    fun normalize(raw: String?): String? {
        val digits = raw.orEmpty().filter { it in '0'..'9' }
        val prefix = PREFIXES.firstOrNull { digits.length == LENGTH + it.length && digits.startsWith(it) }
        return prefix?.let { digits.drop(it.length) }?.takeIf(::isValid)
    }

    /** `98765 43210`: easier to read and check aloud than ten digits in a row. */
    fun display(digits: String): String =
        if (digits.length == LENGTH) "${digits.take(SPLIT)} ${digits.drop(SPLIT)}" else digits

    /** `919876543210` (WhatsApp's `wa.me/<number>` wants the country code, no `+`). */
    fun international(phone: String): String = COUNTRY_CODE + phone

    private const val SPLIT = 5

    /** What may stand before the 10 digits: nothing, `91` (+91), `0` (trunk prefix), `0091`. */
    private val PREFIXES = listOf("", COUNTRY_CODE, "0", "00$COUNTRY_CODE")
}
