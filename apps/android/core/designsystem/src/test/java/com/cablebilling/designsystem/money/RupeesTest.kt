package com.cablebilling.designsystem.money

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

/** Same cases as the web's packages/ui/src/lib/money.test.ts, so both apps print the same text. */
class RupeesTest {
    @Test
    fun `groups digits the Indian way`() {
        val cases =
            mapOf(
                "0" to "0",
                "99" to "99",
                "999" to "999",
                "1000" to "1,000",
                "12345" to "12,345",
                "123456" to "1,23,456",
                "100000" to "1,00,000",
                "1234567" to "12,34,567",
                "123456789" to "12,34,56,789",
            )
        cases.forEach { (digits, grouped) -> assertEquals(digits, grouped, Rupees.groupIndian(digits)) }
    }

    @Test
    fun `formats paise as rupees with the rupee sign`() {
        val cases =
            mapOf(
                0L to "₹0",
                9_900L to "₹99",
                45_000L to "₹450",
                10_000_000L to "₹1,00,000",
                12_345_600L to "₹1,23,456",
                1_250L to "₹12.50",
                5L to "₹0.05",
            )
        cases.forEach { (paise, text) -> assertEquals("$paise paise", text, Rupees.format(paise)) }
    }

    @Test
    fun `formats the absolute value of negatives`() {
        assertEquals("₹500", Rupees.format(-50_000L))
        assertEquals("₹92,23,37,20,36,85,47,758.07", Rupees.format(Long.MIN_VALUE + 1))
        assertEquals("₹92,23,37,20,36,85,47,758.08", Rupees.format(Long.MIN_VALUE))
        assertEquals("₹92,23,37,20,36,85,47,758.07", Rupees.format(Long.MAX_VALUE))
    }

    @Test
    fun `turns typed whole-rupee digits into paise`() {
        assertNull(Rupees.digitsToPaise(""))
        assertEquals(0L, Rupees.digitsToPaise("0"))
        assertEquals(45_000L, Rupees.digitsToPaise("450"))
        assertEquals(700L, Rupees.digitsToPaise("007"))
        assertEquals(12_345_600L, Rupees.digitsToPaise("123456"))
        assertEquals(999_999_999_999_900L, Rupees.digitsToPaise("9999999999999"))
    }

    @Test
    fun `refuses anything but a sane number of digits`() {
        assertThrows(IllegalArgumentException::class.java) { Rupees.digitsToPaise("12.5") }
        assertThrows(IllegalArgumentException::class.java) { Rupees.digitsToPaise("-1") }
        assertThrows(IllegalArgumentException::class.java) { Rupees.digitsToPaise("४५०") }
        assertThrows(IllegalArgumentException::class.java) { Rupees.digitsToPaise("10000000000000") }
    }
}
