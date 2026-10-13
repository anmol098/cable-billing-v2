package com.cablebilling.lineman.printing

import com.cablebilling.lineman.printing.bluetooth.BluetoothAvailability
import com.cablebilling.lineman.printing.bluetooth.BluetoothPrinters
import com.cablebilling.lineman.printing.bluetooth.PrinterDevice
import com.cablebilling.lineman.printing.receipt.ReceiptBalance
import com.cablebilling.lineman.printing.receipt.ReceiptBill
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import com.cablebilling.lineman.printing.receipt.ReceiptMethod
import com.cablebilling.lineman.printing.receipt.ReceiptModel
import com.cablebilling.lineman.printing.receipt.ReceiptNumber
import com.cablebilling.lineman.printing.render.MonoBitmap
import com.cablebilling.lineman.printing.transport.PrinterLink
import com.cablebilling.lineman.printing.transport.PrinterTimeouts
import com.cablebilling.lineman.printing.transport.PrinterTransport
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.takeWhile
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.YearMonth

/** Test image: rows of `#` (black) and `.` (white). */
fun mono(vararg rows: String): MonoBitmap {
    val width = rows.first().length
    require(rows.all { it.length == width })
    val dots = BooleanArray(width * rows.size) { i -> rows[i / width][i % width] == '#' }
    return MonoBitmap(width, rows.size, dots)
}

fun bytes(vararg values: Int): ByteArray = ByteArray(values.size) { values[it].toByte() }

fun ByteArray.hex(): String = joinToString(" ") { "%02X".format(it) }

const val PRINTER_ADDRESS = "00:11:22:33:44:55"
val PRINTER_DEVICE = PrinterDevice(PRINTER_ADDRESS, "MTP-II", looksLikePrinter = true)
val SAVED_PRINTER = SavedPrinter(PRINTER_ADDRESS, "MTP-II")

/** 12 Oct 2026, 4:05 PM in India. */
val RECORDED_AT: Instant = Instant.parse("2026-10-12T10:35:00Z")

/** A posted (permanent) UPI receipt with every optional part. */
fun permanentReceipt() =
    ReceiptModel(
        operatorName = "Shree Ganesh Cable Network",
        operatorPhone = "9800000001",
        number = ReceiptNumber.Permanent("R-2610-00045"),
        recordedAt = RECORDED_AT,
        customerName = "Ramesh Kumar",
        customerCode = "C-0045",
        amountPaise = 50_000,
        method = ReceiptMethod.Upi,
        upiReference = "UTR 4521 8890",
        linemanName = "Suresh",
        bills = listOf(ReceiptBill(YearMonth.of(2026, 10), 0), ReceiptBill(YearMonth.of(2026, 11), 5_000)),
        balanceAfter = ReceiptBalance.Due(5_000),
        footer = "Thank you. Call us for any problem.",
    )

/** A cash receipt still on the phone: provisional number, no bill split or balance yet. */
fun provisionalReceipt() =
    ReceiptModel(
        operatorName = "श्री गणेश केबल",
        operatorPhone = null,
        number = ReceiptNumber.Provisional("P-K7Q-0012"),
        recordedAt = RECORDED_AT,
        customerName = "रमेश कुमार",
        customerCode = "C-0045",
        amountPaise = 12_345_600,
        method = ReceiptMethod.Cash,
        linemanName = "सुरेश",
    )

/** In-memory [PrinterSettings]. */
class FakePrinterSettings(
    initial: SavedPrinter? = null,
) : PrinterSettings {
    val state = MutableStateFlow(initial)
    override val printer: Flow<SavedPrinter?> = state

    override suspend fun save(printer: SavedPrinter) {
        state.value = printer
    }

    override suspend fun forget() {
        state.value = null
    }
}

/** Scriptable [BluetoothPrinters]. */
class FakeBluetoothPrinters(
    var availability: BluetoothAvailability = BluetoothAvailability.On,
    var canPrint: Boolean = true,
    var canFind: Boolean = true,
    var pairedDevices: List<PrinterDevice> = listOf(PRINTER_DEVICE),
    var pairResult: Boolean = true,
) : BluetoothPrinters {
    var stopFindingCalls = 0
    val pairRequests = mutableListOf<String>()

    /** Devices "found" by [find]: emit them, then [finishFinding]. */
    private val discoveries = MutableSharedFlow<PrinterDevice?>(replay = 16)

    suspend fun discover(device: PrinterDevice) = discoveries.emit(device)

    suspend fun finishFinding() = discoveries.emit(null)

    override fun availability() = availability

    override fun canPrint() = canPrint

    override fun canFind() = canFind

    override fun paired() = if (canPrint && availability == BluetoothAvailability.On) pairedDevices else emptyList()

    override fun isPaired(address: String) = pairedDevices.any { it.address == address }

    @Suppress("UNCHECKED_CAST")
    override fun find(): Flow<PrinterDevice> =
        discoveries.asSharedFlow().takeWhile { it != null } as Flow<PrinterDevice>

    override fun stopFinding() {
        stopFindingCalls++
    }

    override suspend fun pair(address: String): Boolean {
        pairRequests += address
        if (pairResult) {
            val found = PrinterDevice(address, "RPP02N", looksLikePrinter = true)
            pairedDevices = pairedDevices + found
        }
        return pairResult
    }
}

/** A [PrinterLink] that records what is written and answers reads from [answers]. */
class FakeLink(
    private val answers: ArrayDeque<Int> = ArrayDeque(),
    private val failOnWrite: Int? = null,
    private val failure: () -> Throwable = { java.io.IOException("link lost") },
) : PrinterLink {
    val writes = mutableListOf<ByteArray>()
    var closed = false

    val written: ByteArray get() = ByteArrayOutputStream().apply { writes.forEach { write(it) } }.toByteArray()

    override suspend fun write(bytes: ByteArray) {
        if (failOnWrite == writes.size) throw failure()
        writes += bytes.copyOf()
    }

    override suspend fun readByte(timeoutMillis: Long): Int? = answers.removeFirstOrNull()

    override fun close() {
        closed = true
    }
}

/** A [PrinterTransport] handing out [link], or throwing [connectFailure]. */
class FakeTransport(
    var link: FakeLink = FakeLink(),
    var connectFailure: Throwable? = null,
) : PrinterTransport {
    val connects = mutableListOf<String>()

    override suspend fun connect(
        address: String,
        timeouts: PrinterTimeouts,
    ): PrinterLink {
        connects += address
        connectFailure?.let { throw it }
        return link
    }
}

/** A [ReceiptPrinter] answering [next]; records test-page calls. */
class FakeReceiptPrinter(
    var next: PrintResult = PrintResult.Printed,
) : ReceiptPrinter {
    val testPages = mutableListOf<SavedPrinter?>()
    val receipts = mutableListOf<ReceiptModel>()

    override suspend fun print(
        receipt: ReceiptModel,
        language: ReceiptLanguage,
    ): PrintResult {
        receipts += receipt
        return next
    }

    override suspend fun printTestPage(
        printer: SavedPrinter?,
        language: ReceiptLanguage,
    ): PrintResult {
        testPages += printer
        return next
    }
}
