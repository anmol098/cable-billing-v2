package com.cablebilling.lineman.printing.bluetooth

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import com.cablebilling.lineman.printing.transport.SppSocket
import com.cablebilling.lineman.printing.transport.SppSocketFactory
import com.cablebilling.lineman.printing.transport.SppTransport
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * RFCOMM sockets to a printer's Serial Port Profile service, for [SppTransport]. Callers check the
 * Bluetooth permission first (`BluetoothReceiptPrinter`); a SecurityException is reported there.
 */
class AndroidSppSockets(
    context: Context,
) : SppSocketFactory {
    private val context: Context = context.applicationContext ?: context

    @SuppressLint("MissingPermission")
    override fun create(
        address: String,
        secure: Boolean,
    ): SppSocket {
        val adapter =
            context.getSystemService(BluetoothManager::class.java)?.adapter ?: throw IOException("no Bluetooth")
        if (!BluetoothAdapter.checkBluetoothAddress(address)) throw IOException("bad address")
        val device = adapter.getRemoteDevice(address)
        val socket =
            if (secure) {
                device.createRfcommSocketToServiceRecord(SppTransport.SPP_UUID)
            } else {
                device.createInsecureRfcommSocketToServiceRecord(SppTransport.SPP_UUID)
            }
        return AndroidSppSocket(socket)
    }

    private class AndroidSppSocket(
        private val socket: BluetoothSocket,
    ) : SppSocket {
        @SuppressLint("MissingPermission")
        override fun connect() = socket.connect()

        override val input: InputStream get() = socket.inputStream
        override val output: OutputStream get() = socket.outputStream

        override fun close() = socket.close()
    }
}
