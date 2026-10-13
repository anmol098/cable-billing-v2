package com.cablebilling.lineman.printing

import androidx.annotation.StringRes
import com.cablebilling.lineman.R

/**
 * Outcome of one print. Printing never throws into the caller (RULE-18: a failed print cannot touch
 * the saved payment); every failure is a [PrintProblem] with a message to show and speak.
 */
sealed interface PrintResult {
    /**
     * Every byte reached the printer's Bluetooth link. We cannot see the paper, so the UI says "the
     * printer got it, check the paper" rather than claiming a perfect print.
     */
    data object Printed : PrintResult

    data class Failed(
        val problem: PrintProblem,
    ) : PrintResult
}

/** Why a print failed, with the words to show (icon: `ic_cb_danger`; voice: the same text). */
enum class PrintProblem(
    @param:StringRes val message: Int,
    /** True if the lineman fixes it in printer setup (choose / pair a printer, allow Bluetooth). */
    val needsSetup: Boolean,
) {
    /** The phone has no Bluetooth at all. */
    NoBluetooth(R.string.mobile_printer_error_no_bluetooth, needsSetup = false),

    /** Bluetooth is switched off. */
    BluetoothOff(R.string.mobile_printer_error_bluetooth_off, needsSetup = true),

    /** The Bluetooth ("Nearby devices") permission is not granted. */
    PermissionDenied(R.string.mobile_printer_error_permission, needsSetup = true),

    /** No printer chosen yet. */
    NoPrinterChosen(R.string.mobile_printer_error_no_printer, needsSetup = true),

    /** The chosen printer is no longer paired with this phone. */
    NotPaired(R.string.mobile_printer_error_not_paired, needsSetup = true),

    /** Could not connect: printer off, out of range, or busy with another phone. */
    Unreachable(R.string.mobile_printer_error_unreachable, needsSetup = false),

    /** The printer stopped answering (connect or write took too long). */
    Timeout(R.string.mobile_printer_error_timeout, needsSetup = false),

    /** The printer reported "paper end" (only printers that answer `DLE EOT 4`). */
    NoPaper(R.string.mobile_printer_error_no_paper, needsSetup = false),

    /** The link broke in the middle of the print. */
    ConnectionLost(R.string.mobile_printer_error_connection_lost, needsSetup = false),

    /** Anything else (a bug or an odd phone): never thrown, reported here. */
    Failed(R.string.mobile_printer_error_failed, needsSetup = false),
}
