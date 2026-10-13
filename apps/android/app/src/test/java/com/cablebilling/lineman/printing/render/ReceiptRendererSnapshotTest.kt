package com.cablebilling.lineman.printing.render

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.printing.BluetoothReceiptPrinter
import com.cablebilling.lineman.printing.FakeBluetoothPrinters
import com.cablebilling.lineman.printing.FakePrinterSettings
import com.cablebilling.lineman.printing.FakeTransport
import com.cablebilling.lineman.printing.PrintResult
import com.cablebilling.lineman.printing.RECORDED_AT
import com.cablebilling.lineman.printing.SAVED_PRINTER
import com.cablebilling.lineman.printing.escpos.PrinterProfile
import com.cablebilling.lineman.printing.hex
import com.cablebilling.lineman.printing.permanentReceipt
import com.cablebilling.lineman.printing.provisionalReceipt
import com.cablebilling.lineman.printing.receipt.ReceiptContent
import com.cablebilling.lineman.printing.receipt.ReceiptDocument
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import com.cablebilling.lineman.printing.receipt.ReceiptLine
import com.cablebilling.lineman.printing.receipt.ReceiptStrings
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.security.MessageDigest

/**
 * Renderer snapshot test (T-068 "Tests required"). Robolectric's native graphics draw the receipt
 * with the bundled fonts exactly as the phone's text stack would; the picture is thresholded to the
 * printer's black and white dots and compared dot for dot with the committed golden PNGs in
 * `src/test/resources/receipt-snapshots/` (look at them to review the layout).
 *
 * After an intended change (layout, strings, metrics, fonts), rewrite the goldens and commit them:
 * `./gradlew :app:testDevDebugUnitTest --tests '*ReceiptRendererSnapshotTest' -Pcb.writeReceiptSnapshots=true`.
 * Every run also writes the current pictures to `app/build/receipt-snapshots/` for comparison.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReceiptRendererSnapshotTest {
    private val context = RuntimeEnvironment.getApplication()
    private val renderer = ReceiptRenderer(ReceiptFonts.load(context))
    private val english = ReceiptStrings.load(context, ReceiptLanguage.English)
    private val hindi = ReceiptStrings.load(context, ReceiptLanguage.Hindi)
    private val width = PrinterProfile.Generic58.widthDots

    private fun dots(
        document: ReceiptDocument,
        widthDots: Int = width,
    ): MonoBitmap = MonoBitmap.from(renderer.render(document, widthDots))

    @Test
    fun receiptsMatchTheGoldenPictures() {
        val cases =
            mapOf(
                "receipt_en_permanent_upi" to ReceiptContent.receipt(permanentReceipt(), english),
                "receipt_hi_provisional_cash" to ReceiptContent.receipt(provisionalReceipt(), hindi),
                "receipt_hi_permanent_upi" to ReceiptContent.receipt(permanentReceipt(), hindi),
                "test_page_hi" to ReceiptContent.testPage("MTP-II", RECORDED_AT, hindi),
            )
        val failures = cases.mapNotNull { (name, document) -> compareWithGolden(name, dots(document)) }
        if (failures.isNotEmpty()) fail(failures.joinToString("\n"))
    }

    @Test
    fun renderingIsDeterministic() {
        val document = ReceiptContent.receipt(permanentReceipt(), hindi)
        val first = dots(document)
        val again = MonoBitmap.from(ReceiptRenderer(ReceiptFonts.load(context)).render(document, width))
        assertEquals(sha256(first), sha256(again))
    }

    @Test
    fun everyReceiptIsExactlyThePaperWidth() {
        assertEquals(384, dots(ReceiptContent.receipt(permanentReceipt(), english)).width)
        assertEquals(576, dots(ReceiptContent.receipt(permanentReceipt(), english), widthDots = 576).width)
    }

    @Test
    fun hindiIsDrawnWithTheBundledDevanagariFont() {
        // Missing glyphs would all be the same box ("tofu"); real glyphs differ and have ink.
        val ka = dots(ReceiptDocument(listOf(ReceiptLine.Text("क"))))
        val kha = dots(ReceiptDocument(listOf(ReceiptLine.Text("ख"))))
        assertTrue(ka.blackCount() > 0)
        assertNotEquals(sha256(ka), sha256(kha))
        // A conjunct is shaped (क + ् + ष = क्ष), not drawn as three separate glyphs.
        val shaped = dots(ReceiptDocument(listOf(ReceiptLine.Text("क्ष"))))
        val loose = dots(ReceiptDocument(listOf(ReceiptLine.Text("क ् ष"))))
        assertNotEquals(sha256(shaped), sha256(loose))
    }

    @Test
    fun longNamesWrapInsteadOfBeingCutOff() {
        val short = dots(ReceiptContent.receipt(permanentReceipt(), english))
        val longName = "Ramesh Kumar Shrivastava Son Of Late Shri Mahesh Prasad Shrivastava, Ward 12"
        val long = dots(ReceiptContent.receipt(permanentReceipt().copy(customerName = longName), english))
        assertEquals(short.width, long.width)
        assertTrue("wrapped name adds lines", long.height > short.height)
    }

    @Test
    fun drawOnAnyCanvasUsesTheSameHeight() {
        val document = ReceiptContent.receipt(provisionalReceipt(), hindi)
        val bitmap = renderer.render(document, width)
        val page = Bitmap.createBitmap(width, bitmap.height * 2, Bitmap.Config.ARGB_8888)
        val used = renderer.draw(Canvas(page), document, width)
        assertEquals(bitmap.height, used)
    }

    @Test
    fun aRealReceiptGoesToThePrinterAsRasterBands() =
        runTest {
            val transport = FakeTransport()
            val printer =
                BluetoothReceiptPrinter(
                    context = context,
                    bluetooth = FakeBluetoothPrinters(),
                    settings = FakePrinterSettings(SAVED_PRINTER),
                    transport = transport,
                    renderDispatcher = StandardTestDispatcher(testScheduler),
                )
            assertEquals(PrintResult.Printed, printer.print(provisionalReceipt(), ReceiptLanguage.Hindi))
            val writes = transport.link.writes
            assertEquals("1B 40", writes.first().hex())
            assertEquals("10 04 04", writes[1].hex())
            assertEquals("1B 64 04", writes.last().hex())
            val bands = writes.subList(2, writes.size - 1)
            bands.forEach { band ->
                assertEquals("1D 76 30 00 30 00", band.copyOfRange(0, 6).hex())
                assertTrue(band.size <= 8 + PrinterProfile.Generic58.maxBytesPerChunk)
            }
            val rows = bands.sumOf { (it[6].toInt() and 0xFF) or ((it[7].toInt() and 0xFF) shl 8) }
            assertEquals(dots(ReceiptContent.receipt(provisionalReceipt(), hindi)).height, rows)
            assertTrue(transport.link.closed)
        }

    /** Null if [actual] equals the golden `name.png`, else a message (and the new picture in build/). */
    private fun compareWithGolden(
        name: String,
        actual: MonoBitmap,
    ): String? {
        val png = toPng(actual)
        File("build/receipt-snapshots").apply { mkdirs() }.resolve("$name.png").writeBytes(png)
        val golden = File("src/test/resources/receipt-snapshots/$name.png")
        val writing = System.getProperty("cb.writeReceiptSnapshots") == "true"
        if (writing) {
            golden.parentFile?.mkdirs()
            golden.writeBytes(png)
        }
        return when {
            writing -> null
            !golden.isFile -> "$name: no golden at ${golden.path} (run with -Pcb.writeReceiptSnapshots=true)"
            else -> difference(name, MonoBitmap.from(checkNotNull(BitmapFactory.decodeFile(golden.path))), actual)
        }
    }

    /** Null if the two pictures are the same dots, else what changed. */
    private fun difference(
        name: String,
        expected: MonoBitmap,
        actual: MonoBitmap,
    ): String? {
        val sameSize = expected.width == actual.width && expected.height == actual.height
        if (sameSize && sha256(expected) == sha256(actual)) return null
        val differing =
            if (sameSize) {
                val count =
                    (0 until actual.height).sumOf { y ->
                        (0 until actual.width).count { x ->
                            expected[x, y] !=
                                actual[x, y]
                        }
                    }
                ", $count dots differ"
            } else {
                ""
            }
        return "$name changed: expected ${expected.width}x${expected.height}, got ${actual.width}x${actual.height}" +
            "$differing, sha256 ${sha256(actual)}. New picture: app/build/receipt-snapshots/$name.png. If the " +
            "change is intended, rewrite the goldens with -Pcb.writeReceiptSnapshots=true and commit them."
    }

    private fun toPng(image: MonoBitmap): ByteArray {
        val pixels =
            IntArray(
                image.width * image.height,
            ) { i -> if (image[i % image.width, i / image.width]) Color.BLACK else Color.WHITE }
        val bitmap = Bitmap.createBitmap(pixels, image.width, image.height, Bitmap.Config.ARGB_8888)
        return java.io
            .ByteArrayOutputStream()
            .also {
                bitmap.compress(
                    Bitmap.CompressFormat.PNG,
                    100,
                    it,
                )
            }.toByteArray()
    }

    private fun sha256(image: MonoBitmap): String =
        MessageDigest
            .getInstance("SHA-256")
            .digest(image.packedRows() + "${image.width}x${image.height}".toByteArray())
            .joinToString("") { "%02x".format(it) }
}
