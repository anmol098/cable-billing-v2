package com.cablebilling.lineman.data.receipts

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import androidx.core.graphics.createBitmap
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.printing.permanentReceipt
import com.cablebilling.lineman.printing.provisionalReceipt
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import com.cablebilling.lineman.printing.receipt.ReceiptModel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.io.OutputStream

/**
 * The receipt PDF made on the phone: offline with the provisional number, again with the permanent
 * number after sync (the provisional file is then gone), shared through FileProvider.
 *
 * Robolectric has no PDF engine (`PdfDocument` needs the platform's native Skia PDF backend), so the
 * page goes through [RecordingPages]: the same drawing on a bitmap, written to the file. The real
 * `PdfDocumentPages` is checked on a phone (see the task notes).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReceiptPdfWriterTest {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val pages = RecordingPages()
    private val writer = ReceiptPdfWriter(context).also { it.pages = pages }
    private val paymentId = "01929a3e-5b10-7c4e-8a06-000000000001"

    /** Draws the page on a white bitmap and writes a stand-in file starting with `%PDF-`. */
    private class RecordingPages : PdfPages {
        val bitmaps = mutableListOf<Bitmap>()

        override fun write(
            width: Int,
            height: Int,
            out: OutputStream,
            draw: (Canvas) -> Unit,
        ) {
            val bitmap = createBitmap(width, height, Bitmap.Config.ARGB_8888)
            draw(Canvas(bitmap))
            bitmaps += bitmap
            out.write("%PDF-test $width x $height".toByteArray())
        }
    }

    private fun write(
        receipt: ReceiptModel,
        now: Long = System.currentTimeMillis(),
    ): File = await { writer.write(paymentId, receipt, ReceiptLanguage.Hindi, now) }

    private fun Bitmap.inkRows(): Int =
        (0 until height).count { y -> (0 until width).any { x -> getPixel(x, y) != Color.WHITE } }

    @Test
    fun `provisional PDF first, then the permanent one replaces it`() {
        val provisional = write(provisionalReceipt())
        assertEquals("Receipt-P-K7Q-0012.pdf", provisional.name)
        assertEquals(File(context.cacheDir, "receipts/$paymentId"), provisional.parentFile)
        assertTrue(provisional.readText().startsWith("%PDF-"))

        val permanent = write(permanentReceipt())
        assertEquals("Receipt-R-2610-00045.pdf", permanent.name)
        assertFalse("the provisional PDF is deleted after sync", provisional.exists())
        assertEquals(listOf(permanent.name), permanent.parentFile!!.list()!!.toList())

        // Receipt-wide pages, as tall as the receipt; the permanent one has more lines (bills, balance, footer).
        val (first, second) = pages.bitmaps
        assertEquals(ReceiptPdfWriter.WIDTH, first.width)
        assertEquals(ReceiptPdfWriter.WIDTH, second.width)
        assertTrue("${second.height} > ${first.height}", second.height > first.height)
        assertTrue("the page has the receipt drawn on it", first.inkRows() > first.height / 4)
        assertEquals("white page", Color.WHITE, second.getPixel(0, 0))
    }

    @Test
    fun `old receipt PDFs are cleaned up`() {
        val old = File(context.cacheDir, "receipts/old-payment").apply { mkdirs() }
        File(old, "Receipt-R-1.pdf").writeText("x")
        old.setLastModified(1_000)
        write(provisionalReceipt(), now = ReceiptPdfWriter.MAX_AGE_MILLIS + 10_000)
        assertFalse(old.exists())
    }

    @Test
    fun `the PDF is shared as a content uri of this app's FileProvider`() {
        resetFileProviderRoots()
        val uri = writer.uriFor(write(provisionalReceipt()))
        assertEquals("content", uri.scheme)
        assertEquals(context.packageName + ".receipts", uri.authority)
        assertTrue(uri.path!!.endsWith("/$paymentId/Receipt-P-K7Q-0012.pdf"))
    }
}
