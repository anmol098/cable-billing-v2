package com.cablebilling.lineman.feature.printer

import com.cablebilling.lineman.printing.PrintProblem
import com.cablebilling.lineman.printing.SavedPrinter
import com.cablebilling.lineman.printing.bluetooth.BluetoothAvailability
import com.cablebilling.lineman.printing.bluetooth.PrinterDevice

/** Everything the printer setup screen shows. */
data class PrinterSetupUiState(
    val bluetooth: BluetoothAvailability = BluetoothAvailability.On,
    /** Permission to print to a paired printer (API 31+ "Nearby devices"; always true below). */
    val canPrint: Boolean = false,
    /** Permission to find new printers (API 31+ "Nearby devices", API 26–30 location). */
    val canFind: Boolean = false,
    /** The lineman said no and Android will not ask again: only the settings screen can fix it. */
    val permissionBlocked: Boolean = false,
    /** "Find printer" was tapped without the finding permission: explain before asking (API 26–30: location). */
    val explainFinding: Boolean = false,
    val saved: SavedPrinter? = null,
    val paired: List<PrinterDevice> = emptyList(),
    val found: List<PrinterDevice> = emptyList(),
    val finding: Boolean = false,
    /** A search ended without finding a new device. */
    val foundNone: Boolean = false,
    /** Address being paired right now. */
    val pairing: String? = null,
    val pairFailed: Boolean = false,
    val test: TestPrint = TestPrint.Idle,
) {
    /** One job at a time (PLAN §2.2): what the screen is about right now. */
    val step: PrinterSetupStep
        get() =
            when {
                bluetooth == BluetoothAvailability.Missing -> PrinterSetupStep.NoBluetooth
                !canPrint -> PrinterSetupStep.NeedsPermission
                bluetooth == BluetoothAvailability.Off -> PrinterSetupStep.BluetoothOff
                else -> PrinterSetupStep.Choose
            }

    /** Busy with the printer: buttons wait. */
    val busy: Boolean get() = pairing != null || test == TestPrint.Printing

    /** Adds a device found by the search, once, unless it is already paired; printers first. */
    fun withFound(device: PrinterDevice): PrinterSetupUiState {
        val known = paired.any { it.address == device.address } || found.any { it.address == device.address }
        return if (known) this else copy(found = (found + device).sortedByDescending { it.looksLikePrinter })
    }
}

enum class PrinterSetupStep {
    /** The phone has no Bluetooth: nothing to do. */
    NoBluetooth,

    /** Explain, then ask for the Bluetooth permission. */
    NeedsPermission,

    /** Ask to switch Bluetooth on. */
    BluetoothOff,

    /** Pick, find or test a printer. */
    Choose,
}

/** The test print's state. */
sealed interface TestPrint {
    data object Idle : TestPrint

    data object Printing : TestPrint

    data object Printed : TestPrint

    data class Failed(
        val problem: PrintProblem,
    ) : TestPrint
}
