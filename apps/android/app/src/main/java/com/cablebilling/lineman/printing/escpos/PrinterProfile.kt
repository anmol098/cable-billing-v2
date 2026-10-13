package com.cablebilling.lineman.printing.escpos

/**
 * How to talk to one kind of printer (PLAN §11.8: init, feed and cut are configurable per printer
 * profile). Stored by [id] with the chosen printer; unknown ids fall back to [Default].
 *
 * The defaults are conservative values for cheap 58 mm Bluetooth printers and must be checked on
 * real printers (H-05): chunk size and pause keep small printer buffers from overflowing over SPP,
 * and the drain pause stops the phone closing the link before the last bytes have gone out.
 */
@Suppress("LongParameterList") // A flat record of printer settings reads best as one list.
enum class PrinterProfile(
    val id: String,
    /** Printable width in dots (58 mm paper: 48 mm × 8 dots = 384; 80 mm paper: 576). */
    val widthDots: Int,
    /** Sent first: `ESC @` (reset). */
    val initialize: ByteArray,
    /** Blank lines fed after the receipt so it clears the tear bar. */
    val feedLines: Int,
    /** Sent last, if the printer has a cutter; null = tear by hand. */
    val cut: ByteArray?,
    /** Largest image data per `GS v 0` command (bytes); the image is sent in bands of rows. */
    val maxBytesPerChunk: Int,
    /** Pause after each chunk, so slow printers keep up. */
    val chunkPauseMillis: Long,
    /** Ask `DLE EOT 4` for the paper sensor before printing (answer is optional). */
    val checksPaper: Boolean,
    /** Wait before closing the connection after the last byte. */
    val drainMillis: Long,
) {
    /** Generic 58 mm Bluetooth ESC/POS printer without a cutter (most portable printers). */
    Generic58(
        id = "generic58",
        widthDots = 384,
        initialize = EscPos.INITIALIZE,
        feedLines = 4,
        cut = null,
        maxBytesPerChunk = 2048,
        chunkPauseMillis = 20,
        checksPaper = true,
        drainMillis = 500,
    ),

    /** 58 mm printer with an auto-cutter. */
    Generic58Cutter(
        id = "generic58cut",
        widthDots = 384,
        initialize = EscPos.INITIALIZE,
        feedLines = 3,
        cut = EscPos.FEED_AND_PARTIAL_CUT,
        maxBytesPerChunk = 2048,
        chunkPauseMillis = 20,
        checksPaper = true,
        drainMillis = 500,
    ),

    /** 80 mm printer with an auto-cutter (counter printers). */
    Generic80(
        id = "generic80",
        widthDots = 576,
        initialize = EscPos.INITIALIZE,
        feedLines = 3,
        cut = EscPos.FEED_AND_PARTIAL_CUT,
        maxBytesPerChunk = 4096,
        chunkPauseMillis = 10,
        checksPaper = true,
        drainMillis = 500,
    ),
    ;

    companion object {
        val Default = Generic58

        fun fromId(id: String?): PrinterProfile = entries.firstOrNull { it.id == id } ?: Default
    }
}
