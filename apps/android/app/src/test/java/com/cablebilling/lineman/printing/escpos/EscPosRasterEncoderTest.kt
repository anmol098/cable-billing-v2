package com.cablebilling.lineman.printing.escpos

import com.cablebilling.lineman.printing.bytes
import com.cablebilling.lineman.printing.hex
import com.cablebilling.lineman.printing.mono
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Exact ESC/POS bytes (PLAN §11.8: `GS v 0` raster, chunked, profile init / feed / cut). Plain JVM. */
class EscPosRasterEncoderTest {
    /** 10 dots wide → 2 bytes per row, the last 6 bits of each row are white padding. */
    private val tiny =
        mono(
            "#........#",
            "##########",
            ".#.#.#.#..",
        )

    @Test
    fun tinyBitmapIsOneGsV0CommandWithPackedRows() {
        val commands = EscPosRasterEncoder.raster(tiny, maxBytesPerChunk = 1024)
        assertEquals(1, commands.size)
        assertEquals(
            // GS v 0, m=0, xL=2 xH=0 (bytes per row), yL=3 yH=0 (rows), then the rows MSB-first.
            bytes(0x1D, 0x76, 0x30, 0x00, 0x02, 0x00, 0x03, 0x00, 0x80, 0x40, 0xFF, 0xC0, 0x55, 0x00).hex(),
            commands.single().hex(),
        )
    }

    @Test
    fun chunksAreBandsOfWholeRowsWithinTheByteLimit() {
        // 4 data bytes per chunk = 2 rows of 2 bytes.
        val commands = EscPosRasterEncoder.raster(tiny, maxBytesPerChunk = 4)
        assertEquals(
            listOf(
                bytes(0x1D, 0x76, 0x30, 0x00, 0x02, 0x00, 0x02, 0x00, 0x80, 0x40, 0xFF, 0xC0).hex(),
                bytes(0x1D, 0x76, 0x30, 0x00, 0x02, 0x00, 0x01, 0x00, 0x55, 0x00).hex(),
            ),
            commands.map { it.hex() },
        )
        // 5 bytes still only fits 2 whole rows; a limit below one row still sends one row per command.
        assertEquals(2, EscPosRasterEncoder.raster(tiny, maxBytesPerChunk = 5).size)
        assertEquals(3, EscPosRasterEncoder.raster(tiny, maxBytesPerChunk = 1).size)
    }

    @Test
    fun receiptWidthBandsAndSixteenBitRowCounts() {
        val width = PrinterProfile.Generic58.widthDots
        val image = mono(*Array(100) { y -> if (y % 2 == 0) "#".repeat(width) else ".".repeat(width) })
        val commands = EscPosRasterEncoder.raster(image, maxBytesPerChunk = 2048)
        // 384 dots = 48 bytes per row; 2048 / 48 = 42 rows per band.
        assertEquals(listOf(42, 42, 16), commands.map { (it[6].toInt() and 0xFF) or ((it[7].toInt() and 0xFF) shl 8) })
        commands.forEach { assertEquals(48, it[4].toInt()) }
        assertEquals(8 + 42 * 48, commands.first().size)
        // The data is the image, row after row, across the bands.
        val data = commands.flatMap { it.drop(8) }.map { it.toInt() and 0xFF }
        assertEquals(List(48) { 0xFF } + List(48) { 0x00 }, data.take(96))

        val tall = mono(*Array(300) { "#" })
        val single = EscPosRasterEncoder.raster(tall, maxBytesPerChunk = 4096).single()
        // 300 rows = 0x012C: yL = 0x2C, yH = 0x01.
        assertEquals("1D 76 30 00 01 00 2C 01", single.copyOfRange(0, 8).hex())
    }

    @Test
    fun profileAddsResetFeedAndCut() {
        val plain = EscPosRasterEncoder.encode(tiny, PrinterProfile.Generic58)
        assertEquals("1B 40", plain.start.hex())
        assertEquals("1B 64 04", plain.end.hex())
        assertEquals(1, plain.chunks.size)
        assertEquals(
            "1B 40 1D 76 30 00 02 00 03 00 80 40 FF C0 55 00 1B 64 04",
            plain.bytes().hex(),
        )

        val cutter = EscPosRasterEncoder.encode(tiny, PrinterProfile.Generic58Cutter)
        assertEquals("1B 64 03 1D 56 42 00", cutter.end.hex())
    }

    @Test(expected = IllegalArgumentException::class)
    fun imageWiderThanThePaperIsRefused() {
        EscPosRasterEncoder.encode(mono("#".repeat(385)), PrinterProfile.Generic58)
    }

    @Test
    fun paperStatusOnlyTrustsRealStatusBytes() {
        assertEquals(PaperStatus.Present, EscPos.paperStatus(0x12))
        // Paper near end (bits 2-3) still prints.
        assertEquals(PaperStatus.Present, EscPos.paperStatus(0x1E))
        assertEquals(PaperStatus.Out, EscPos.paperStatus(0x72))
        // Junk or an echo of our own request is never "no paper".
        listOf(
            0x00,
            0x04,
            0x10,
            0x60,
            0xFF,
            -1,
            256,
        ).forEach { assertEquals(PaperStatus.Unknown, EscPos.paperStatus(it)) }
        assertArrayEquals(bytes(0x10, 0x04, 0x04), EscPos.PAPER_STATUS_REQUEST)
    }

    @Test
    fun profilesAreFoundById() {
        PrinterProfile.entries.forEach { assertEquals(it, PrinterProfile.fromId(it.id)) }
        assertEquals(PrinterProfile.Generic58, PrinterProfile.fromId("something-new"))
        assertEquals(PrinterProfile.Generic58, PrinterProfile.fromId(null))
        assertEquals(384, PrinterProfile.Default.widthDots)
        assertNull(PrinterProfile.Generic58.cut)
    }
}
