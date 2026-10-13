package com.cablebilling.lineman.feature.printer

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.R
import com.cablebilling.lineman.printing.PrintResult
import com.cablebilling.lineman.printing.PrinterSettings
import com.cablebilling.lineman.printing.ReceiptPrinter
import com.cablebilling.lineman.printing.SavedPrinter
import com.cablebilling.lineman.printing.bluetooth.BluetoothPrinters
import com.cablebilling.lineman.printing.bluetooth.PrinterDevice
import com.cablebilling.lineman.printing.escpos.PrinterProfile
import com.cablebilling.lineman.voice.VoiceLines
import com.cablebilling.lineman.voice.say
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * Printer setup (PLAN §11.8): permission → Bluetooth on → pick a paired printer or find and pair a
 * new one → test print. Picking a printer remembers it and prints the test page at once, so one tap
 * shows whether Hindi prints. Results are shown and spoken.
 */
@HiltViewModel
class PrinterSetupViewModel
    @Inject
    constructor(
        private val bluetooth: BluetoothPrinters,
        private val settings: PrinterSettings,
        private val printer: ReceiptPrinter,
        private val speaker: Speaker,
        private val voiceLines: VoiceLines,
    ) : ViewModel() {
        private val mutableState = MutableStateFlow(PrinterSetupUiState())
        val state: StateFlow<PrinterSetupUiState> = mutableState.asStateFlow()

        private var findJob: Job? = null

        init {
            refresh()
            viewModelScope.launch {
                settings.printer.collect { saved -> mutableState.update { it.copy(saved = saved) } }
            }
        }

        /** Re-reads Bluetooth, permissions and paired devices (screen resumed, permission answered). */
        fun refresh() {
            mutableState.update {
                val canPrint = bluetooth.canPrint()
                it.copy(
                    bluetooth = bluetooth.availability(),
                    canPrint = canPrint,
                    canFind = bluetooth.canFind(),
                    permissionBlocked = it.permissionBlocked && !canPrint,
                    paired = bluetooth.paired(),
                )
            }
        }

        /**
         * The system permission dialog answered. [canAskAgain] is false when Android will not show
         * the dialog again (denied twice / "don't ask again"): then only the settings screen helps.
         */
        fun onPermissionResult(
            granted: Boolean,
            canAskAgain: Boolean,
        ) {
            val wasExplainingFinding = mutableState.value.explainFinding
            mutableState.update { it.copy(permissionBlocked = !granted && !canAskAgain, explainFinding = false) }
            refresh()
            if (granted && wasExplainingFinding) find()
        }

        /** "Find printer": search, or explain the permission first. */
        fun find() {
            val current = mutableState.value
            if (current.busy || current.finding) return
            // Asked live: the permission may have been taken away in the phone's settings.
            if (!bluetooth.canFind()) {
                mutableState.update { it.copy(canFind = false, explainFinding = true) }
                return
            }
            mutableState.update { it.copy(finding = true, found = emptyList(), foundNone = false, pairFailed = false) }
            findJob =
                viewModelScope.launch {
                    try {
                        bluetooth.find().collect { device -> mutableState.update { it.withFound(device) } }
                    } finally {
                        mutableState.update { it.copy(finding = false, foundNone = it.found.isEmpty()) }
                    }
                }
        }

        fun dismissFindExplainer() = mutableState.update { it.copy(explainFinding = false) }

        /** A paired printer was tapped: remember it and print the test page. */
        fun choose(device: PrinterDevice) {
            if (mutableState.value.busy) return
            stopFinding()
            viewModelScope.launch { useAndTest(device) }
        }

        /** A found (not yet paired) printer was tapped: pair, then as [choose]. */
        fun pairAndChoose(device: PrinterDevice) {
            if (mutableState.value.busy) return
            stopFinding()
            mutableState.update { it.copy(pairing = device.address, pairFailed = false) }
            viewModelScope.launch {
                val paired = bluetooth.pair(device.address)
                mutableState.update {
                    it.copy(
                        pairing = null,
                        pairFailed = !paired,
                        paired = bluetooth.paired(),
                        found =
                            if (paired) {
                                it.found.filterNot { found ->
                                    found.address == device.address
                                }
                            } else {
                                it.found
                            },
                    )
                }
                if (paired) {
                    useAndTest(
                        device,
                    )
                } else {
                    speaker.say(voiceLines.line(R.string.mobile_printer_setup_pair_failed))
                }
            }
        }

        /** "Test print" on the remembered printer. */
        fun testPrint() {
            val saved = mutableState.value.saved ?: return
            if (mutableState.value.busy) return
            viewModelScope.launch { runTest(saved) }
        }

        private suspend fun useAndTest(device: PrinterDevice) {
            val previous = mutableState.value.saved
            val chosen =
                SavedPrinter(
                    address = device.address,
                    name = device.name,
                    // Keep a profile set for this same printer earlier.
                    profile = previous?.takeIf { it.address == device.address }?.profile ?: PrinterProfile.Default,
                )
            settings.save(chosen)
            mutableState.update { it.copy(saved = chosen) }
            runTest(chosen)
        }

        private suspend fun runTest(target: SavedPrinter) {
            mutableState.update { it.copy(test = TestPrint.Printing) }
            val result = printer.printTestPage(target)
            val test =
                when (result) {
                    PrintResult.Printed -> TestPrint.Printed
                    is PrintResult.Failed -> TestPrint.Failed(result.problem)
                }
            mutableState.update { it.copy(test = test) }
            refresh()
            val message =
                when (result) {
                    PrintResult.Printed -> R.string.mobile_printer_setup_printed
                    is PrintResult.Failed -> result.problem.message
                }
            speaker.say(voiceLines.line(message))
        }

        private fun stopFinding() {
            findJob?.cancel()
            findJob = null
            bluetooth.stopFinding()
        }
    }
