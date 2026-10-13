package com.cablebilling.lineman.printing

import android.content.Context
import com.cablebilling.lineman.printing.bluetooth.BluetoothAvailability
import com.cablebilling.lineman.printing.bluetooth.BluetoothPrinters
import com.cablebilling.lineman.printing.escpos.EscPos
import com.cablebilling.lineman.printing.escpos.EscPosRasterEncoder
import com.cablebilling.lineman.printing.escpos.PaperStatus
import com.cablebilling.lineman.printing.escpos.PrintJob
import com.cablebilling.lineman.printing.receipt.ReceiptContent
import com.cablebilling.lineman.printing.receipt.ReceiptDocument
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import com.cablebilling.lineman.printing.receipt.ReceiptModel
import com.cablebilling.lineman.printing.receipt.ReceiptStrings
import com.cablebilling.lineman.printing.render.MonoBitmap
import com.cablebilling.lineman.printing.render.ReceiptFonts
import com.cablebilling.lineman.printing.render.ReceiptRenderer
import com.cablebilling.lineman.printing.transport.PrinterTimeoutException
import com.cablebilling.lineman.printing.transport.PrinterTimeouts
import com.cablebilling.lineman.printing.transport.PrinterTransport
import com.cablebilling.lineman.printing.transport.PrinterUnreachableException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.time.Clock

/**
 * Prints receipts on the Bluetooth printer chosen in setup (FR-018). Inject this interface (Hilt
 * binds [BluetoothReceiptPrinter]).
 *
 * Both calls suspend until the print is done or failed, never throw (apart from coroutine
 * cancellation) and never touch payments (RULE-18): the caller records `printed` / `print_failed`
 * and shows [PrintProblem.message] with a "Try again" button.
 */
interface ReceiptPrinter {
    /** Prints [receipt] in [language] on the chosen printer. */
    suspend fun print(
        receipt: ReceiptModel,
        language: ReceiptLanguage = ReceiptLanguage.current(),
    ): PrintResult

    /** Prints the test page on [printer] (setup), or on the chosen printer when null. */
    suspend fun printTestPage(
        printer: SavedPrinter? = null,
        language: ReceiptLanguage = ReceiptLanguage.current(),
    ): PrintResult
}

/** Turns a document into printer dots [widthDots] wide. */
fun interface Rasterizer {
    fun rasterize(
        document: ReceiptDocument,
        widthDots: Int,
    ): MonoBitmap
}

/**
 * The real [ReceiptPrinter]: checks Bluetooth, permission and pairing, draws the receipt
 * ([ReceiptRenderer]), encodes it ([EscPosRasterEncoder]) with the printer's profile and sends it
 * over [transport]. One print at a time.
 */
class BluetoothReceiptPrinter(
    private val context: Context,
    private val bluetooth: BluetoothPrinters,
    private val settings: PrinterSettings,
    private val transport: PrinterTransport,
    private val timeouts: PrinterTimeouts = PrinterTimeouts(),
    private val clock: Clock = Clock.systemUTC(),
    private val renderDispatcher: CoroutineDispatcher = Dispatchers.Default,
    private val rasterizer: Rasterizer = defaultRasterizer(context),
) : ReceiptPrinter {
    private val lock = Mutex()

    override suspend fun print(
        receipt: ReceiptModel,
        language: ReceiptLanguage,
    ): PrintResult = printDocument(target = null, language) { strings, _ -> ReceiptContent.receipt(receipt, strings) }

    override suspend fun printTestPage(
        printer: SavedPrinter?,
        language: ReceiptLanguage,
    ): PrintResult =
        printDocument(target = printer, language) { strings, chosen ->
            ReceiptContent.testPage(chosen.name, clock.instant(), strings)
        }

    @Suppress("TooGenericExceptionCaught") // The point: nothing may escape into payment code.
    private suspend fun printDocument(
        target: SavedPrinter?,
        language: ReceiptLanguage,
        build: (ReceiptStrings, SavedPrinter) -> ReceiptDocument,
    ): PrintResult =
        lock.withLock {
            try {
                readinessProblem()?.let { return@withLock PrintResult.Failed(it) }
                val printer =
                    target ?: settings.printer.first()
                        ?: return@withLock PrintResult.Failed(PrintProblem.NoPrinterChosen)
                if (!bluetooth.isPaired(printer.address)) return@withLock PrintResult.Failed(PrintProblem.NotPaired)
                val job =
                    withContext(renderDispatcher) {
                        val document = build(ReceiptStrings.load(context, language), printer)
                        val dots = rasterizer.rasterize(document, printer.profile.widthDots)
                        EscPosRasterEncoder.encode(dots, printer.profile)
                    }
                // A running search makes connecting slow or fail.
                bluetooth.stopFinding()
                send(printer, job)
            } catch (e: CancellationException) {
                throw e
            } catch (_: PrinterTimeoutException) {
                PrintResult.Failed(PrintProblem.Timeout)
            } catch (_: PrinterUnreachableException) {
                PrintResult.Failed(PrintProblem.Unreachable)
            } catch (_: IOException) {
                PrintResult.Failed(PrintProblem.ConnectionLost)
            } catch (_: SecurityException) {
                PrintResult.Failed(PrintProblem.PermissionDenied)
            } catch (_: Exception) {
                PrintResult.Failed(PrintProblem.Failed)
            } catch (_: OutOfMemoryError) {
                // A huge receipt bitmap on a low-memory phone: report it, keep the app alive.
                PrintResult.Failed(PrintProblem.Failed)
            }
        }

    private fun readinessProblem(): PrintProblem? =
        when {
            bluetooth.availability() == BluetoothAvailability.Missing -> PrintProblem.NoBluetooth
            !bluetooth.canPrint() -> PrintProblem.PermissionDenied
            bluetooth.availability() == BluetoothAvailability.Off -> PrintProblem.BluetoothOff
            else -> null
        }

    private suspend fun send(
        printer: SavedPrinter,
        job: PrintJob,
    ): PrintResult {
        val profile = printer.profile
        transport.connect(printer.address, timeouts).use { link ->
            link.write(job.start)
            if (profile.checksPaper) {
                link.write(EscPos.PAPER_STATUS_REQUEST)
                val answer = link.readByte(timeouts.statusMillis)
                if (answer != null && EscPos.paperStatus(answer) == PaperStatus.Out) {
                    return PrintResult.Failed(PrintProblem.NoPaper)
                }
            }
            job.chunks.forEach { chunk ->
                link.write(chunk)
                delay(profile.chunkPauseMillis)
            }
            link.write(job.end)
            // Closing at once can drop the last bytes still in the phone's Bluetooth buffer.
            delay(profile.drainMillis)
        }
        return PrintResult.Printed
    }

    companion object {
        /** Draws with the bundled fonts and thresholds to black and white. */
        fun defaultRasterizer(context: Context): Rasterizer {
            val renderer by lazy { ReceiptRenderer(ReceiptFonts.load(context)) }
            return Rasterizer { document, width ->
                val bitmap = renderer.render(document, width)
                try {
                    MonoBitmap.from(bitmap)
                } finally {
                    bitmap.recycle()
                }
            }
        }
    }
}
