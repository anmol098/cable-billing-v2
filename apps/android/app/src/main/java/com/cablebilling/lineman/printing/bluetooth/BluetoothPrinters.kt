package com.cablebilling.lineman.printing.bluetooth

import kotlinx.coroutines.flow.Flow

/** Whether the phone can use Bluetooth right now. */
enum class BluetoothAvailability {
    /** The phone has no Bluetooth. */
    Missing,

    /** Bluetooth is switched off. */
    Off,
    On,
}

/** A Bluetooth device shown in printer setup. */
data class PrinterDevice(
    /** MAC address, the key we store. */
    val address: String,
    /** Name the device reports, or its address when it has none. */
    val name: String,
    /** Reports the "imaging" device class or a printer-like name; listed first. */
    val looksLikePrinter: Boolean,
)

/** What the phone's Bluetooth offers to printer setup and printing. Fake it in tests. */
interface BluetoothPrinters {
    fun availability(): BluetoothAvailability

    /** Runtime permission to print to a paired printer ([PrinterPermissions.forPrinting]). */
    fun canPrint(): Boolean

    /** Runtime permission to find and pair new printers ([PrinterPermissions.forFinding]). */
    fun canFind(): Boolean

    /** Paired devices, likely printers first. Empty without permission or with Bluetooth off. */
    fun paired(): List<PrinterDevice>

    fun isPaired(address: String): Boolean

    /**
     * Searches for nearby devices (about 12 s) and emits each one found; completes when the search
     * ends. Cancelling the collector stops the search. Emits nothing without permission.
     */
    fun find(): Flow<PrinterDevice>

    /** Stops a search (a running search slows down connecting). */
    fun stopFinding()

    /**
     * Pairs with [address]; the phone may show its PIN dialog (cheap printers use 0000 or 1234).
     * True once paired, false if pairing failed or was refused.
     */
    suspend fun pair(address: String): Boolean
}
