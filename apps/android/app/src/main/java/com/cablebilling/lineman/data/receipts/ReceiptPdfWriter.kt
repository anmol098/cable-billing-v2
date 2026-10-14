package com.cablebilling.lineman.data.receipts

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfDocument
import android.net.Uri
import androidx.core.content.FileProvider
import androidx.core.graphics.createBitmap
import com.cablebilling.lineman.printing.escpos.PrinterProfile
import com.cablebilling.lineman.printing.receipt.ReceiptContent
import com.cablebilling.lineman.printing.receipt.ReceiptDocument
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import com.cablebilling.lineman.printing.receipt.ReceiptModel
import com.cablebilling.lineman.printing.receipt.ReceiptStrings
import com.cablebilling.lineman.printing.render.ReceiptFonts
import com.cablebilling.lineman.printing.render.ReceiptRenderer
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.OutputStream
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The receipt as a PDF, made on the phone with [PdfDocument] (PLAN §11.7), so it works offline. It is
 * the printed receipt's layout (T-068's [ReceiptContent] + [ReceiptRenderer], same fonts, Hindi
 * shaped by Android), on one page as wide as a 58 mm receipt in printer dots (1 PDF unit = 1 dot) and
 * as tall as the receipt.
 *
 * A payment only on the phone gets its provisional `P-…` number and the "temporary" note; once the
 * office answered, the next PDF has the permanent `R-…` number, bills and balance. Each call writes a
 * fresh file from the current [ReceiptModel] into `cache/receipts/<paymentId>/Receipt-<number>.pdf`
 * and deletes that payment's older files (so the provisional PDF is gone after sync). Files older
 * than [MAX_AGE_MILLIS] are cleaned up. Shared through [FileProvider] (`res/xml/file_paths.xml`).
 */
@Singleton
class ReceiptPdfWriter
    @Inject
    constructor(
        @param:ApplicationContext private val context: Context,
    ) {
        /** Writes the page; [PdfDocumentPages] in the app (tests swap it: Robolectric has no PDF engine). */
        internal var pages: PdfPages = PdfDocumentPages

        private val fonts by lazy { ReceiptFonts.load(context) }

        /** Writes the PDF for [receipt] of [paymentId] and returns the file. Throws IOException on a disk problem. */
        suspend fun write(
            paymentId: String,
            receipt: ReceiptModel,
            language: ReceiptLanguage = ReceiptLanguage.current(),
            now: Long = System.currentTimeMillis(),
        ): File =
            withContext(Dispatchers.IO) {
                val root = File(context.cacheDir, DIR)
                cleanUp(root, now)
                val dir = File(root, safeName(paymentId))
                dir.deleteRecursively()
                if (!dir.mkdirs() && !dir.isDirectory) throw IOException("cannot create receipt folder")
                val file = File(dir, fileName(receipt))
                val document = ReceiptContent.receipt(receipt, ReceiptStrings.load(context, language))
                writePdf(document, file)
                file
            }

        /** A `content://` uri other apps may read once granted (the PDF share intent grants it). */
        fun uriFor(file: File): Uri = FileProvider.getUriForFile(context, authority(context), file)

        private fun writePdf(
            document: ReceiptDocument,
            file: File,
        ) {
            val renderer = ReceiptRenderer(fonts)
            // Measure first (drawing on a 1×1 bitmap costs nothing), then draw on a page that tall.
            val height = renderer.draw(Canvas(createBitmap(1, 1)), document, WIDTH)
            file.outputStream().use { out ->
                pages.write(WIDTH, height.coerceAtLeast(1), out) { canvas ->
                    canvas.drawColor(Color.WHITE)
                    renderer.draw(canvas, document, WIDTH)
                }
            }
        }

        private fun cleanUp(
            root: File,
            now: Long,
        ) {
            root.listFiles()?.filter { now - it.lastModified() > MAX_AGE_MILLIS }?.forEach { it.deleteRecursively() }
        }

        companion object {
            /** Folder under the app's cache dir (must match `res/xml/file_paths.xml`). */
            const val DIR = "receipts"

            /** Page width: the printer receipt's width in dots (58 mm). */
            val WIDTH: Int = PrinterProfile.Generic58.widthDots

            /** Older PDFs are deleted (they can always be made again). */
            const val MAX_AGE_MILLIS: Long = 7L * 24 * 60 * 60 * 1000

            /** `<applicationId>.receipts` (AndroidManifest `provider`). */
            fun authority(context: Context): String = context.packageName + ".receipts"

            /** `Receipt-R-2610-00045.pdf` / `Receipt-P-K7Q-0012.pdf`: the name the customer sees. */
            fun fileName(receipt: ReceiptModel): String = "Receipt-${safeName(receipt.number.text)}.pdf"

            private fun safeName(text: String): String = text.replace(Regex("[^A-Za-z0-9-]"), "_")
        }
    }

/** Writes one PDF page of [width] × [height] units, drawn by `draw`, to `out`. */
internal fun interface PdfPages {
    fun write(
        width: Int,
        height: Int,
        out: OutputStream,
        draw: (Canvas) -> Unit,
    )
}

/** [PdfPages] with Android's [PdfDocument] (vector text, fonts embedded by the platform). */
internal object PdfDocumentPages : PdfPages {
    override fun write(
        width: Int,
        height: Int,
        out: OutputStream,
        draw: (Canvas) -> Unit,
    ) {
        val pdf = PdfDocument()
        try {
            val page = pdf.startPage(PdfDocument.PageInfo.Builder(width, height, 1).create())
            draw(page.canvas)
            pdf.finishPage(page)
            pdf.writeTo(out)
        } finally {
            pdf.close()
        }
    }
}
