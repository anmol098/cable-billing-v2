package com.cablebilling.lineman.printing.escpos

import com.cablebilling.lineman.printing.render.MonoBitmap

/**
 * Encodes a picture as ESC/POS raster commands (`GS v 0`, PLAN §11.8): the image is cut into bands
 * of whole rows, each band one complete `GS v 0 m xL xH yL yH d1…dk` command with at most
 * `maxBytesPerChunk` data bytes, so a long receipt never overflows a small printer buffer and every
 * write is a self-contained command.
 *
 * Data layout: `x = ceil(width / 8)` bytes per row, `y` rows, leftmost dot in the highest bit,
 * 1 = black, the row padded with white bits on the right.
 */
object EscPosRasterEncoder {
    private const val LOW_BYTE = 0xFF
    private const val BYTE_SHIFT = 8

    /** The `GS v 0` commands for [image], top band first. */
    fun raster(
        image: MonoBitmap,
        maxBytesPerChunk: Int,
    ): List<ByteArray> {
        require(maxBytesPerChunk > 0) { "maxBytesPerChunk must be positive" }
        val bytesPerRow = image.bytesPerRow
        require(bytesPerRow <= EscPos.MAX_RASTER_ROWS) { "image too wide: ${image.width}" }
        val rowsPerBand = (maxBytesPerChunk / bytesPerRow).coerceIn(1, EscPos.MAX_RASTER_ROWS)
        val data = image.packedRows()
        return (0 until image.height step rowsPerBand).map { firstRow ->
            val rows = minOf(rowsPerBand, image.height - firstRow)
            val command = ByteArray(EscPos.RASTER_HEADER_SIZE + rows * bytesPerRow)
            EscPos.RASTER_PREFIX.copyInto(command)
            var at = EscPos.RASTER_PREFIX.size
            command[at++] = EscPos.RASTER_MODE_NORMAL
            command[at++] = (bytesPerRow and LOW_BYTE).toByte()
            command[at++] = (bytesPerRow shr BYTE_SHIFT).toByte()
            command[at++] = (rows and LOW_BYTE).toByte()
            command[at++] = (rows shr BYTE_SHIFT).toByte()
            data.copyInto(command, at, firstRow * bytesPerRow, (firstRow + rows) * bytesPerRow)
            command
        }
    }

    /** Everything to send for one print with [profile]: reset, the picture in chunks, feed and cut. */
    fun encode(
        image: MonoBitmap,
        profile: PrinterProfile,
    ): PrintJob {
        require(image.width <= profile.widthDots) {
            "image is ${image.width} dots wide; ${profile.id} prints ${profile.widthDots}"
        }
        val end = EscPos.feedLines(profile.feedLines) + (profile.cut ?: ByteArray(0))
        return PrintJob(
            start = profile.initialize.copyOf(),
            chunks = raster(image, profile.maxBytesPerChunk),
            end = end,
        )
    }
}

/**
 * The bytes of one print, in order: [start], each of [chunks] (with the profile's pause after
 * each), then [end].
 */
class PrintJob(
    val start: ByteArray,
    val chunks: List<ByteArray>,
    val end: ByteArray,
) {
    /** All bytes in sending order (tests, logs). */
    fun bytes(): ByteArray = chunks.fold(start) { acc, chunk -> acc + chunk } + end
}
