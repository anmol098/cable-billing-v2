package com.cablebilling.lineman.printing.transport

import java.io.Closeable
import java.io.IOException

/**
 * A byte pipe to a printer. The real one is Bluetooth RFCOMM/SPP ([SppTransport]); tests use a
 * fake. Failures are exceptions here and become typed results in
 * [com.cablebilling.lineman.printing.BluetoothReceiptPrinter], which never lets them out.
 */
interface PrinterTransport {
    /**
     * Opens a link to the printer at [address] (Bluetooth MAC). Throws [PrinterTimeoutException]
     * when the printer does not answer in time and [PrinterUnreachableException] when it refuses or
     * is off / out of range.
     */
    suspend fun connect(
        address: String,
        timeouts: PrinterTimeouts,
    ): PrinterLink
}

/** An open link. Close it when done (also after a failure). */
interface PrinterLink : Closeable {
    /** Writes all of [bytes]; [PrinterTimeoutException] if the printer stops taking data. */
    suspend fun write(bytes: ByteArray)

    /** One byte from the printer, or null if nothing arrives within [timeoutMillis]. */
    suspend fun readByte(timeoutMillis: Long): Int?
}

/** Time limits for one print. Defaults are for SPP printers; check them on real printers (H-05). */
data class PrinterTimeouts(
    /** Bluetooth connect: a printer that is on and paired answers in 1–3 s. */
    val connectMillis: Long = 8_000,
    /** One chunk write: a printer without paper or with a jam can stop reading. */
    val writeMillis: Long = 10_000,
    /** Answer to the paper-status question; many printers never answer, so keep it short. */
    val statusMillis: Long = 400,
)

/** The printer did not answer within the time limit ([stage]: "connect", "write"). */
class PrinterTimeoutException(
    val stage: String,
    cause: Throwable? = null,
) : IOException("printer timed out during $stage", cause)

/** The printer could not be reached (off, out of range, busy with another phone, refused). */
class PrinterUnreachableException(
    cause: Throwable? = null,
) : IOException("printer not reachable", cause)
