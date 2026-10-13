package com.cablebilling.lineman.printing

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.printing.bluetooth.BluetoothAvailability
import com.cablebilling.lineman.printing.escpos.PrinterProfile
import com.cablebilling.lineman.printing.receipt.ReceiptDocument
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import com.cablebilling.lineman.printing.receipt.ReceiptLine
import com.cablebilling.lineman.printing.transport.PrinterTimeoutException
import com.cablebilling.lineman.printing.transport.PrinterUnreachableException
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import java.io.IOException
import java.time.Clock
import java.time.ZoneOffset

/**
 * The print pipeline with a fake Bluetooth stack and a tiny fake picture: exact bytes on the wire,
 * and every failure becomes a typed [PrintResult] instead of an exception (RULE-18).
 */
@RunWith(AndroidJUnit4::class)
class BluetoothReceiptPrinterTest {
    private val bluetooth = FakeBluetoothPrinters()
    private val settings = FakePrinterSettings(SAVED_PRINTER)
    private val transport = FakeTransport()
    private val documents = mutableListOf<ReceiptDocument>()
    private var rasterizer: Rasterizer =
        Rasterizer { document, width ->
            documents += document
            assertEquals(PrinterProfile.Generic58.widthDots, width)
            mono("#........#", "##########", ".#.#.#.#..")
        }

    private fun TestScope.printer() =
        BluetoothReceiptPrinter(
            context = RuntimeEnvironment.getApplication(),
            bluetooth = bluetooth,
            settings = settings,
            transport = transport,
            clock = Clock.fixed(RECORDED_AT, ZoneOffset.UTC),
            renderDispatcher = StandardTestDispatcher(testScheduler),
            rasterizer = { document, width -> rasterizer.rasterize(document, width) },
        )

    private suspend fun printReceipt(printer: BluetoothReceiptPrinter) =
        printer.print(permanentReceipt(), ReceiptLanguage.English)

    @Test
    fun printsResetPaperCheckRasterAndFeed() =
        runTest {
            val result = printReceipt(printer())
            assertEquals(PrintResult.Printed, result)
            assertEquals(listOf(PRINTER_ADDRESS), transport.connects)
            assertEquals(
                listOf(
                    "1B 40",
                    "10 04 04",
                    "1D 76 30 00 02 00 03 00 80 40 FF C0 55 00",
                    "1B 64 04",
                ),
                transport.link.writes.map { it.hex() },
            )
            assertTrue(transport.link.closed)
            // A running search is stopped before connecting.
            assertTrue(bluetooth.stopFindingCalls > 0)
            // The receipt was laid out in the asked language.
            assertTrue(ReceiptLine.Field("Customer", "Ramesh Kumar") in documents.single().lines)
        }

    @Test
    fun cutterProfileCutsAfterFeeding() =
        runTest {
            settings.state.value = SAVED_PRINTER.copy(profile = PrinterProfile.Generic58Cutter)
            assertEquals(PrintResult.Printed, printReceipt(printer()))
            assertEquals(
                "1B 64 03 1D 56 42 00",
                transport.link.writes
                    .last()
                    .hex(),
            )
        }

    @Test
    fun paperOutStopsBeforeThePicture() =
        runTest {
            transport.link = FakeLink(answers = ArrayDeque(listOf(0x72)))
            assertEquals(PrintResult.Failed(PrintProblem.NoPaper), printReceipt(printer()))
            assertEquals(listOf("1B 40", "10 04 04"), transport.link.writes.map { it.hex() })
            assertTrue(transport.link.closed)
        }

    @Test
    fun paperPresentOrNoAnswerPrints() =
        runTest {
            transport.link = FakeLink(answers = ArrayDeque(listOf(0x12)))
            assertEquals(PrintResult.Printed, printReceipt(printer()))
            transport.link = FakeLink(answers = ArrayDeque(listOf(0x10)))
            assertEquals(PrintResult.Printed, printReceipt(printer()))
        }

    @Test
    fun phoneProblemsAreFoundBeforeConnecting() =
        runTest {
            val cases =
                listOf(
                    { bluetooth.availability = BluetoothAvailability.Missing } to PrintProblem.NoBluetooth,
                    { bluetooth.canPrint = false } to PrintProblem.PermissionDenied,
                    { bluetooth.availability = BluetoothAvailability.Off } to PrintProblem.BluetoothOff,
                    { settings.state.value = null } to PrintProblem.NoPrinterChosen,
                    { bluetooth.pairedDevices = emptyList() } to PrintProblem.NotPaired,
                )
            cases.forEach { (setUp, problem) ->
                bluetooth.availability = BluetoothAvailability.On
                bluetooth.canPrint = true
                bluetooth.pairedDevices = listOf(PRINTER_DEVICE)
                settings.state.value = SAVED_PRINTER
                setUp()
                assertEquals(problem.name, PrintResult.Failed(problem), printReceipt(printer()))
            }
            assertTrue(transport.connects.isEmpty())
            assertTrue(PrintProblem.NoPrinterChosen.needsSetup)
            assertTrue(PrintProblem.NotPaired.needsSetup)
        }

    @Test
    fun linkProblemsAreTypedResults() =
        runTest {
            transport.connectFailure = PrinterTimeoutException("connect")
            assertEquals(PrintResult.Failed(PrintProblem.Timeout), printReceipt(printer()))
            transport.connectFailure = PrinterUnreachableException(IOException("refused"))
            assertEquals(PrintResult.Failed(PrintProblem.Unreachable), printReceipt(printer()))
            transport.connectFailure = SecurityException("BLUETOOTH_CONNECT")
            assertEquals(PrintResult.Failed(PrintProblem.PermissionDenied), printReceipt(printer()))
            transport.connectFailure = null

            transport.link = FakeLink(failOnWrite = 2)
            assertEquals(PrintResult.Failed(PrintProblem.ConnectionLost), printReceipt(printer()))
            assertTrue(transport.link.closed)

            transport.link = FakeLink(failOnWrite = 3, failure = { PrinterTimeoutException("write") })
            assertEquals(PrintResult.Failed(PrintProblem.Timeout), printReceipt(printer()))
            assertTrue(transport.link.closed)
        }

    @Test
    fun bugsAndLowMemoryNeverEscape() =
        runTest {
            rasterizer = Rasterizer { _, _ -> throw IllegalStateException("bug") }
            assertEquals(PrintResult.Failed(PrintProblem.Failed), printReceipt(printer()))
            rasterizer = Rasterizer { _, _ -> throw OutOfMemoryError("huge bitmap") }
            assertEquals(PrintResult.Failed(PrintProblem.Failed), printReceipt(printer()))
            transport.connectFailure = RuntimeException("odd phone")
            rasterizer = Rasterizer { _, _ -> mono("#") }
            assertEquals(PrintResult.Failed(PrintProblem.Failed), printReceipt(printer()))
        }

    @Test
    fun testPageGoesToTheGivenPrinterWithItsName() =
        runTest {
            val other = SavedPrinter("AA:BB:CC:DD:EE:FF", "RPP02N")
            bluetooth.pairedDevices = listOf(PRINTER_DEVICE, PRINTER_DEVICE.copy(address = other.address))
            assertEquals(PrintResult.Printed, printer().printTestPage(other, ReceiptLanguage.Hindi))
            assertEquals(listOf(other.address), transport.connects)
            val lines = documents.single().lines
            assertTrue(ReceiptLine.Field("प्रिंटर", "RPP02N") in lines)
            assertTrue(ReceiptLine.Field("तारीख", "12 अक्टू 2026, 4:05 PM") in lines)
        }

    @Test
    fun everyProblemHasWordsInBothLanguages() {
        val app = RuntimeEnvironment.getApplication()
        listOf("en", "hi").forEach { tag ->
            val config = android.content.res.Configuration(app.resources.configuration)
            config.setLocale(java.util.Locale.forLanguageTag(tag))
            val resources = app.createConfigurationContext(config).resources
            PrintProblem.entries.forEach { problem ->
                assertTrue("${problem.name} $tag", resources.getString(problem.message).isNotBlank())
            }
            if (tag ==
                "hi"
            ) {
                assertEquals("प्रिंटर में कागज़ नहीं है", resources.getString(PrintProblem.NoPaper.message))
            }
        }
    }
}
