package com.cablebilling.lineman.printing.render

import android.graphics.Bitmap

/**
 * A black-and-white picture, one bit per printer dot (`true` = black = the printer heats that dot).
 * Plain JVM data so the ESC/POS encoder can be tested without Android graphics.
 */
class MonoBitmap(
    val width: Int,
    val height: Int,
    private val dots: BooleanArray,
) {
    init {
        require(width > 0 && height > 0) { "empty image: ${width}x$height" }
        require(dots.size == width * height) { "expected ${width * height} dots, got ${dots.size}" }
    }

    /** True if the dot at column [x], row [y] is black. */
    operator fun get(
        x: Int,
        y: Int,
    ): Boolean = dots[y * width + x]

    /** Number of black dots (snapshot tests and sanity checks). */
    fun blackCount(): Int = dots.count { it }

    /**
     * The image packed as printer rows: each row is `ceil(width / 8)` bytes, leftmost dot in the
     * highest bit, padded with white (0) bits on the right. This is the data format of `GS v 0`.
     */
    fun packedRows(): ByteArray {
        val bytesPerRow = bytesPerRow
        val out = ByteArray(bytesPerRow * height)
        for (y in 0 until height) {
            for (x in 0 until width) {
                if (this[x, y]) {
                    val index = y * bytesPerRow + x / BITS_PER_BYTE
                    out[index] = (out[index].toInt() or (HIGH_BIT ushr (x % BITS_PER_BYTE))).toByte()
                }
            }
        }
        return out
    }

    val bytesPerRow: Int get() = (width + BITS_PER_BYTE - 1) / BITS_PER_BYTE

    companion object {
        const val BITS_PER_BYTE = 8
        private const val HIGH_BIT = 0x80

        /** Mid-grey: darker pixels print black. */
        const val DEFAULT_THRESHOLD = 128

        private const val RED_WEIGHT = 299
        private const val GREEN_WEIGHT = 587
        private const val BLUE_WEIGHT = 114
        private const val WEIGHT_TOTAL = 1000

        /**
         * Thresholds [bitmap]: a pixel is black when its luminance (ITU-R BT.601 weights) is below
         * [threshold]. Transparent pixels count as white paper.
         */
        fun from(
            bitmap: Bitmap,
            threshold: Int = DEFAULT_THRESHOLD,
        ): MonoBitmap {
            val width = bitmap.width
            val height = bitmap.height
            val pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
            val dots = BooleanArray(pixels.size) { i -> isDark(pixels[i], threshold) }
            return MonoBitmap(width, height, dots)
        }

        /** True if an ARGB pixel prints black (plain bit maths: usable in JVM tests without Android). */
        fun isDark(
            argb: Int,
            threshold: Int = DEFAULT_THRESHOLD,
        ): Boolean {
            val alpha = (argb ushr ALPHA_SHIFT) and CHANNEL
            if (alpha < threshold) return false
            val red = (argb ushr RED_SHIFT) and CHANNEL
            val green = (argb ushr GREEN_SHIFT) and CHANNEL
            val blue = argb and CHANNEL
            val luminance = (RED_WEIGHT * red + GREEN_WEIGHT * green + BLUE_WEIGHT * blue) / WEIGHT_TOTAL
            return luminance < threshold
        }

        private const val CHANNEL = 0xFF
        private const val ALPHA_SHIFT = 24
        private const val RED_SHIFT = 16
        private const val GREEN_SHIFT = 8
    }
}
