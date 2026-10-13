package com.cablebilling.lineman.printing.render

import com.cablebilling.lineman.printing.hex
import com.cablebilling.lineman.printing.mono
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Thresholding and bit packing (plain JVM). */
class MonoBitmapTest {
    @Test
    fun darkPixelsPrintBlack() {
        assertTrue(MonoBitmap.isDark(0xFF000000.toInt()))
        assertFalse(MonoBitmap.isDark(0xFFFFFFFF.toInt()))
        // Mid grey: luminance 127 prints, 128 does not (threshold 128).
        assertTrue(MonoBitmap.isDark(0xFF7F7F7F.toInt()))
        assertFalse(MonoBitmap.isDark(0xFF808080.toInt()))
        // Transparent counts as paper, whatever its colour.
        assertFalse(MonoBitmap.isDark(0x00000000))
        // Luminance weights: pure blue is dark, pure green is light.
        assertTrue(MonoBitmap.isDark(0xFF0000FF.toInt()))
        assertFalse(MonoBitmap.isDark(0xFF00FF00.toInt()))
        // A custom threshold.
        assertTrue(MonoBitmap.isDark(0xFFC0C0C0.toInt(), threshold = 200))
    }

    @Test
    fun rowsArePackedMostSignificantBitFirstAndPadded() {
        val image = mono("#.......#", "........#")
        assertEquals(2, image.bytesPerRow)
        assertEquals("80 80 00 80", image.packedRows().hex())
        assertEquals(3, image.blackCount())
        assertTrue(image[8, 1])
        assertFalse(image[0, 1])
    }

    @Test(expected = IllegalArgumentException::class)
    fun sizeMustMatchTheDots() {
        MonoBitmap(2, 2, BooleanArray(3))
    }
}
