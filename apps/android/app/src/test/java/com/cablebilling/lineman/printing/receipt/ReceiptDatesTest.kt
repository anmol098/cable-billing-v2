package com.cablebilling.lineman.printing.receipt

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.YearMonth

/** Receipt month names must stay the same as the web / server labels (T-024, `packages/domain`). */
class ReceiptDatesTest {
    private val labels: String by lazy {
        val file =
            generateSequence(File(checkNotNull(System.getProperty("user.dir"))).absoluteFile) { it.parentFile }
                .map { File(it, "packages/domain/src/time/labels.ts") }
                .firstOrNull { it.isFile }
                ?: error("packages/domain/src/time/labels.ts not found")
        file.readText()
    }

    /** The `short: [...]` list after `<language>: {` in labels.ts. */
    private fun domainShortMonths(language: String): List<String> {
        val block = labels.substringAfter("  $language: {")
        val list = block.substringAfter("short: [").substringBefore("]")
        return Regex("\"([^\"]+)\"").findAll(list).map { it.groupValues[1] }.toList()
    }

    @Test
    fun shortMonthsMatchTheDomainPackage() {
        assertEquals(domainShortMonths("en"), (1..12).map { ReceiptDates.shortMonth(it, ReceiptLanguage.English) })
        assertEquals(domainShortMonths("hi"), (1..12).map { ReceiptDates.shortMonth(it, ReceiptLanguage.Hindi) })
        assertEquals(12, domainShortMonths("hi").size)
    }

    @Test
    fun datesAndMonths() {
        val instant = Instant.parse("2026-10-12T10:35:00Z")
        assertEquals("12 Oct 2026", ReceiptDates.date(instant, ReceiptLanguage.English))
        assertEquals("12 अक्टू 2026", ReceiptDates.date(instant, ReceiptLanguage.Hindi))
        assertEquals("अक्टू 2026", ReceiptDates.month(YearMonth.of(2026, 10), ReceiptLanguage.Hindi))
        assertEquals(ReceiptDates.ClockTime("4:05", afterNoon = true), ReceiptDates.time(instant))
    }

    @Test(expected = IllegalArgumentException::class)
    fun monthOutOfRange() {
        ReceiptDates.shortMonth(13, ReceiptLanguage.English)
    }
}
