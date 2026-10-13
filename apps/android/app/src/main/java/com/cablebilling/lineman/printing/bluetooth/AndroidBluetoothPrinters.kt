package com.cablebilling.lineman.printing.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.withTimeoutOrNull

/**
 * [BluetoothPrinters] on the phone's Bluetooth adapter. Every call that needs a runtime permission
 * checks it first and returns an empty / false answer without it (hence the MissingPermission
 * suppressions); a SecurityException is still caught, as phones differ.
 */
class AndroidBluetoothPrinters(
    context: Context,
) : BluetoothPrinters {
    private val context: Context = context.applicationContext ?: context

    private val adapter: BluetoothAdapter?
        get() = context.getSystemService(BluetoothManager::class.java)?.adapter

    override fun availability(): BluetoothAvailability {
        val adapter = adapter ?: return BluetoothAvailability.Missing
        return if (adapter.isEnabled) BluetoothAvailability.On else BluetoothAvailability.Off
    }

    override fun canPrint(): Boolean = PrinterPermissions.granted(context, PrinterPermissions.forPrinting())

    override fun canFind(): Boolean = PrinterPermissions.granted(context, PrinterPermissions.forFinding())

    @SuppressLint("MissingPermission")
    override fun paired(): List<PrinterDevice> {
        val adapter = adapter
        if (adapter == null || !canPrint() || !adapter.isEnabled) return emptyList()
        return try {
            adapter.bondedDevices
                .orEmpty()
                .map { it.toPrinterDevice() }
                .sortedWith(PRINTERS_FIRST)
        } catch (_: SecurityException) {
            emptyList()
        }
    }

    @SuppressLint("MissingPermission")
    override fun isPaired(address: String): Boolean {
        val adapter = adapter
        if (adapter == null || !canPrint() || !BluetoothAdapter.checkBluetoothAddress(address)) return false
        return try {
            adapter.bondedDevices.orEmpty().any { it.address == address }
        } catch (_: SecurityException) {
            false
        }
    }

    @SuppressLint("MissingPermission")
    override fun find(): Flow<PrinterDevice> {
        val adapter = adapter
        if (adapter == null || !canFind() || !adapter.isEnabled) return emptyFlow()
        return callbackFlow {
            val receiver =
                object : BroadcastReceiver() {
                    override fun onReceive(
                        context: Context,
                        intent: Intent,
                    ) {
                        when (intent.action) {
                            BluetoothDevice.ACTION_FOUND -> {
                                intent.device()?.let { trySend(it.toPrinterDevice()) }
                            }

                            BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> {
                                close()
                            }
                        }
                    }
                }
            val filter =
                IntentFilter().apply {
                    addAction(BluetoothDevice.ACTION_FOUND)
                    addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
                }
            ContextCompat.registerReceiver(context, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
            val started =
                try {
                    adapter.cancelDiscovery()
                    adapter.startDiscovery()
                } catch (_: SecurityException) {
                    false
                }
            if (!started) close()
            awaitClose {
                context.unregisterReceiver(receiver)
                stopFinding()
            }
        }
    }

    @SuppressLint("MissingPermission")
    override fun stopFinding() {
        val adapter = adapter
        if (adapter == null || !canFind()) return
        try {
            adapter.cancelDiscovery()
        } catch (_: SecurityException) {
            // Permission withdrawn meanwhile: nothing is searching then.
        }
    }

    @SuppressLint("MissingPermission")
    override suspend fun pair(address: String): Boolean {
        val adapter = adapter
        if (adapter == null || !canFind() || !BluetoothAdapter.checkBluetoothAddress(address)) return false
        // Listen before asking, so a fast answer is not missed.
        val states = Channel<Int>(Channel.UNLIMITED)
        val receiver =
            object : BroadcastReceiver() {
                override fun onReceive(
                    context: Context,
                    intent: Intent,
                ) {
                    if (intent.device()?.address != address) return
                    states.trySend(intent.getIntExtra(BluetoothDevice.EXTRA_BOND_STATE, BluetoothDevice.ERROR))
                }
            }
        ContextCompat.registerReceiver(
            context,
            receiver,
            IntentFilter(BluetoothDevice.ACTION_BOND_STATE_CHANGED),
            ContextCompat.RECEIVER_EXPORTED,
        )
        return try {
            val device = adapter.getRemoteDevice(address)
            when {
                device.bondState == BluetoothDevice.BOND_BONDED -> true
                !startBond(device) -> device.bondState == BluetoothDevice.BOND_BONDED
                else -> withTimeoutOrNull(PAIR_TIMEOUT_MILLIS) { awaitBond(states) } ?: false
            }
        } catch (_: SecurityException) {
            false
        } finally {
            context.unregisterReceiver(receiver)
            states.close()
        }
    }

    @SuppressLint("MissingPermission")
    private fun startBond(device: BluetoothDevice): Boolean {
        stopFinding()
        return device.createBond()
    }

    /** Waits until the bond state settles: bonded (true) or back to none (false). */
    private suspend fun awaitBond(states: Channel<Int>): Boolean {
        while (true) {
            when (states.receive()) {
                BluetoothDevice.BOND_BONDED -> return true
                BluetoothDevice.BOND_NONE -> return false
            }
        }
    }

    companion object {
        /** The PIN dialog waits for the lineman; give up after a minute. */
        private const val PAIR_TIMEOUT_MILLIS = 60_000L

        private val PRINTERS_FIRST =
            compareByDescending<PrinterDevice> { it.looksLikePrinter }.thenBy { it.name.lowercase() }
    }
}

/** Names cheap printers report: "Printer001", "MTP-II", "RPP02N", "POS-58", "BlueTooth Printer". */
private val PRINTER_NAME = Regex("print|pos|mtp|rpp|thermal|receipt|58mm|80mm", RegexOption.IGNORE_CASE)

@SuppressLint("MissingPermission")
private fun BluetoothDevice.toPrinterDevice(): PrinterDevice {
    val name = name?.takeIf { it.isNotBlank() }
    val imaging = bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.IMAGING
    return PrinterDevice(
        address = address,
        name = name ?: address,
        looksLikePrinter = imaging || (name != null && PRINTER_NAME.containsMatchIn(name)),
    )
}

private fun Intent.device(): BluetoothDevice? =
    IntentCompat.getParcelableExtra(this, BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
