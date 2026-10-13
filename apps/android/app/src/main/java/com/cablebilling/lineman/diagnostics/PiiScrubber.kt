package com.cablebilling.lineman.diagnostics

/**
 * Removes personal data from text before it is written to the diagnostic log or sent to Sentry
 * (PLAN §11.1). The log's own events carry only codes and counts; this is the safety net for text the
 * app does not control (exception messages, URLs, library breadcrumbs).
 *
 * What goes: tokens (bearer, JWT, long random strings and ids), values of fields whose name says
 * name / phone / amount / password / token …, e-mail addresses, the query part of URLs, rupee
 * amounts, digit runs of 6 or more (phone numbers, VC numbers, money in paise), and Hindi text (a
 * name typed in Devanagari). Short numbers (counts, HTTP status, line numbers) stay.
 */
object PiiScrubber {
    const val TOKEN = "[token]"
    const val REMOVED = "[removed]"
    const val EMAIL = "[email]"
    const val AMOUNT = "[amount]"
    const val NUMBER = "[number]"
    const val TEXT = "[text]"

    /** Digit runs this long or longer are treated as phone / VC / account numbers. */
    private const val MIN_NUMBER_DIGITS = 6

    private val bearer = Regex("""(?i)\bbearer\s+\S+""")
    private val jwt = Regex("""\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]*)?""")
    private val sensitiveField =
        Regex(
            """(?i)\b([A-Za-z_]*(?:name|phone|mobile|login|password|passwd|token|secret|amount|paise|rupee|""" +
                """address|email|upi|customer|collector|receipt|reference|dsn)[A-Za-z_]*)""" +
                """(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\])]+)""",
        )
    private val email = Regex("""[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}""")
    private val urlQuery = Regex("""(https?://[^\s?#]+)\?[^\s#]*""")
    private val rupees = Regex("""(?:₹|(?i:\brs\.?|\binr))\s*\d[\d,]*(?:\.\d+)?""")

    /** 20+ characters of a token alphabet containing both a letter and a digit (UUIDs, refresh tokens, base64). */
    private val randomString =
        Regex("""(?<![A-Za-z0-9_+/=-])(?=[A-Za-z0-9_+/=-]*\d)(?=[A-Za-z0-9_+/=-]*[A-Za-z])[A-Za-z0-9_+/=-]{20,}""")
    private val digits = Regex("""(?<![\d])\+?\d[\d\s-]*\d(?![\d])""")
    private val devanagari = Regex("""[\u0900-\u097F]+(?:[\s.,]+[\u0900-\u097F]+)*""")

    fun scrub(text: String?): String {
        if (text.isNullOrEmpty()) return ""
        var out = text
        out = bearer.replace(out, "Bearer $TOKEN")
        out = jwt.replace(out, TOKEN)
        out = sensitiveField.replace(out) { match -> match.groupValues[1] + match.groupValues[2] + REMOVED }
        out = email.replace(out, EMAIL)
        out = urlQuery.replace(out) { match -> match.groupValues[1] + "?" + REMOVED }
        out = rupees.replace(out, AMOUNT)
        out = randomString.replace(out, TOKEN)
        out =
            digits.replace(out) { match ->
                if (match.value.count(Char::isDigit) >=
                    MIN_NUMBER_DIGITS
                ) {
                    NUMBER
                } else {
                    match.value
                }
            }
        out = devanagari.replace(out, TEXT)
        return out
    }
}
