package com.cablebilling.lineman.printing.receipt

import java.time.Instant
import java.time.LocalDateTime
import java.time.YearMonth
import java.time.ZoneId

/**
 * Month and date text for receipts: `12 Oct 2026` / `12 अक्टू 2026`, months `Oct` / `अक्टू`.
 *
 * A copy of `MONTH_NAMES` in `packages/domain/src/time/labels.ts` (T-024), so the phone prints the
 * same words as the web and the server. No `java.text`/ICU month names: ICU builds disagree on the
 * Hindi abbreviations (`अक्तू॰` vs `अक्टू`). Digits stay Latin (PLAN §11.4). Keep both lists in step;
 * `ReceiptDatesTest` pins them.
 */
object ReceiptDates {
    /** Business dates and receipt times are shown in India time (CLAUDE.md). */
    val BUSINESS_ZONE: ZoneId = ZoneId.of("Asia/Kolkata")

    private val SHORT_MONTHS: Map<ReceiptLanguage, List<String>> =
        mapOf(
            ReceiptLanguage.English to
                listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"),
            ReceiptLanguage.Hindi to
                listOf("जन", "फ़र", "मार्च", "अप्रैल", "मई", "जून", "जुल", "अग", "सित", "अक्टू", "नव", "दिस"),
        )

    private const val MONTHS_PER_YEAR = 12
    private const val HOURS_PER_HALF_DAY = 12
    private const val MINUTE_DIGITS = 2

    /** `Oct` / `अक्टू` for month 1–12. */
    fun shortMonth(
        month: Int,
        language: ReceiptLanguage,
    ): String {
        require(month in 1..MONTHS_PER_YEAR) { "month must be 1-12, got $month" }
        return SHORT_MONTHS.getValue(language)[month - 1]
    }

    /** `Oct 2026` / `अक्टू 2026`. */
    fun month(
        month: YearMonth,
        language: ReceiptLanguage,
    ): String = "${shortMonth(month.monthValue, language)} ${month.year}"

    /** `12 Oct 2026` / `12 अक्टू 2026` for [instant] in India time. */
    fun date(
        instant: Instant,
        language: ReceiptLanguage,
    ): String {
        val local = LocalDateTime.ofInstant(instant, BUSINESS_ZONE)
        return "${local.dayOfMonth} ${shortMonth(local.monthValue, language)} ${local.year}"
    }

    /** Clock time in India time on a 12-hour clock: `4:05` and whether it is after noon. */
    fun time(instant: Instant): ClockTime {
        val local = LocalDateTime.ofInstant(instant, BUSINESS_ZONE)
        val hour12 = (local.hour % HOURS_PER_HALF_DAY).let { if (it == 0) HOURS_PER_HALF_DAY else it }
        val minutes = local.minute.toString().padStart(MINUTE_DIGITS, '0')
        return ClockTime(text = "$hour12:$minutes", afterNoon = local.hour >= HOURS_PER_HALF_DAY)
    }

    /** `4:05` + AM/PM (the words come from the receipt strings). */
    data class ClockTime(
        val text: String,
        val afterNoon: Boolean,
    )
}
