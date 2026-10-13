package com.cablebilling.designsystem.component

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class NumberPadKeyTest {
    private fun type(
        vararg keys: NumberPadKey,
        maxLength: Int = Int.MAX_VALUE,
        trimLeadingZeros: Boolean = false,
    ): String = keys.fold("") { digits, key -> key.applyTo(digits, maxLength, trimLeadingZeros) }

    @Test
    fun `digits append, backspace removes one, clear removes all`() {
        assertEquals("120", type(NumberPadKey.Digit(1), NumberPadKey.Digit(2), NumberPadKey.Digit(0)))
        assertEquals("1", type(NumberPadKey.Digit(1), NumberPadKey.Digit(2), NumberPadKey.Backspace))
        assertEquals("", type(NumberPadKey.Digit(1), NumberPadKey.Clear))
        assertEquals("", type(NumberPadKey.Backspace))
        assertEquals("500", type(NumberPadKey.Digit(5), NumberPadKey.DoubleZero))
        assertEquals("5", type(NumberPadKey.Digit(5), NumberPadKey.Letters))
    }

    @Test
    fun `search keeps leading zeros, amounts drop them`() {
        assertEquals("098", type(NumberPadKey.Digit(0), NumberPadKey.Digit(9), NumberPadKey.Digit(8)))
        assertEquals(
            "98",
            type(NumberPadKey.Digit(0), NumberPadKey.Digit(9), NumberPadKey.Digit(8), trimLeadingZeros = true),
        )
        assertEquals("", type(NumberPadKey.DoubleZero, trimLeadingZeros = true))
    }

    @Test
    fun `typing stops at the maximum length`() {
        assertEquals("12", type(NumberPadKey.Digit(1), NumberPadKey.Digit(2), NumberPadKey.Digit(3), maxLength = 2))
        assertEquals("9", type(NumberPadKey.Digit(9), NumberPadKey.DoubleZero, maxLength = 2))
    }

    @Test
    fun `a digit key is 0 to 9`() {
        assertThrows(IllegalArgumentException::class.java) { NumberPadKey.Digit(10) }
        assertThrows(IllegalArgumentException::class.java) { NumberPadKey.Digit(-1) }
    }
}
