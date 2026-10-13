package com.cablebilling.lineman.printing.escpos

/**
 * The few ESC/POS commands we use (Epson ESC/POS reference; supported by the generic 58 mm
 * Bluetooth printers sold in India, D-08). Text commands are not used: everything is printed as a
 * raster picture so Hindi works on printers without Devanagari.
 */
object EscPos {
    private const val ESC: Byte = 0x1B
    private const val GS: Byte = 0x1D
    private const val DLE: Byte = 0x10
    private const val EOT: Byte = 0x04
    private const val PRINT_AND_FEED: Byte = 0x64

    /** `ESC @`: reset the printer (clears old settings and half-received data). */
    val INITIALIZE: ByteArray = byteArrayOf(ESC, 0x40)

    /** `GS v 0` header bytes before m, xL, xH, yL, yH. */
    val RASTER_PREFIX: ByteArray = byteArrayOf(GS, 0x76, 0x30)

    /** Raster mode m = 0: normal size (1 image dot = 1 printer dot). */
    const val RASTER_MODE_NORMAL: Byte = 0

    /** Bytes before the image data in a `GS v 0` command: prefix + m + xL xH yL yH. */
    const val RASTER_HEADER_SIZE: Int = 8

    /** `GS v 0` counts are 16-bit little-endian. */
    const val MAX_RASTER_ROWS: Int = 0xFFFF

    /** `ESC d n`: print and feed n lines (n ≤ 255), so the receipt clears the tear bar. */
    fun feedLines(lines: Int): ByteArray {
        require(lines in 0..MAX_BYTE) { "lines must be 0-255" }
        return byteArrayOf(ESC, PRINT_AND_FEED, lines.toByte())
    }

    /** `GS V 66 0`: feed to the cutter and partial cut (printers with a cutter only). */
    val FEED_AND_PARTIAL_CUT: ByteArray = byteArrayOf(GS, 0x56, 0x42, 0x00)

    /** `DLE EOT 4`: real-time roll-paper sensor status. The printer answers one byte (if it supports it). */
    val PAPER_STATUS_REQUEST: ByteArray = byteArrayOf(DLE, EOT, 0x04)

    private const val STATUS_FIXED_MASK = 0x93
    private const val STATUS_FIXED_BITS = 0x12
    private const val STATUS_PAPER_END = 0x60
    private const val MAX_BYTE = 0xFF

    /**
     * Reads a `DLE EOT 4` answer: bits 5 and 6 = paper end. Only a byte with the fixed bits of a
     * status byte (bit 1 and 4 set, bit 0 and 7 clear) counts, so an echo or junk byte from a printer
     * that does not support the command is never taken for "no paper".
     */
    fun paperStatus(answer: Int): PaperStatus =
        when {
            answer !in 0..MAX_BYTE || answer and STATUS_FIXED_MASK != STATUS_FIXED_BITS -> PaperStatus.Unknown
            answer and STATUS_PAPER_END != 0 -> PaperStatus.Out
            else -> PaperStatus.Present
        }
}

enum class PaperStatus { Present, Out, Unknown }
