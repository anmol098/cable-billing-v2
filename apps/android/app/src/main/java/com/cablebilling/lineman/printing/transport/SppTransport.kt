package com.cablebilling.lineman.printing.transport

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** A raw RFCOMM socket (Android's BluetoothSocket in the app, a fake in tests). */
interface SppSocket : Closeable {
    /** Blocks until connected; throws IOException on failure or when [close]d meanwhile. */
    fun connect()

    val input: InputStream
    val output: OutputStream
}

/** Creates (but does not connect) a socket to the SPP service of [address]. */
fun interface SppSocketFactory {
    /** [secure] = authenticated link (`createRfcommSocketToServiceRecord`); else the insecure variant. */
    fun create(
        address: String,
        secure: Boolean,
    ): SppSocket
}

/**
 * Bluetooth Serial Port Profile transport (PLAN §11.8). Blocking socket calls run on [io] and are
 * bounded by [PrinterTimeouts]: a watchdog closes the socket when time is up, which makes the
 * blocked call fail, and that failure is reported as [PrinterTimeoutException].
 *
 * Some cheap printers refuse the authenticated socket; then the insecure one is tried once.
 */
class SppTransport(
    private val sockets: SppSocketFactory,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) : PrinterTransport {
    override suspend fun connect(
        address: String,
        timeouts: PrinterTimeouts,
    ): PrinterLink =
        try {
            open(address, secure = true, timeouts)
        } catch (refused: PrinterUnreachableException) {
            try {
                open(address, secure = false, timeouts)
            } catch (again: PrinterUnreachableException) {
                again.addSuppressed(refused)
                throw again
            }
        }

    private suspend fun open(
        address: String,
        secure: Boolean,
        timeouts: PrinterTimeouts,
    ): PrinterLink {
        val socket =
            try {
                withContext(io) { sockets.create(address, secure) }
            } catch (e: IOException) {
                throw PrinterUnreachableException(e)
            }
        try {
            bounded(timeouts.connectMillis, "connect", socket, io) { socket.connect() }
        } catch (e: IOException) {
            socket.closeQuietly()
            throw e.asConnectFailure()
        }
        return SppLink(socket, timeouts, io)
    }

    private class SppLink(
        private val socket: SppSocket,
        private val timeouts: PrinterTimeouts,
        private val io: CoroutineDispatcher,
    ) : PrinterLink {
        override suspend fun write(bytes: ByteArray) {
            bounded(timeouts.writeMillis, "write", socket, io) {
                socket.output.write(bytes)
                socket.output.flush()
            }
        }

        override suspend fun readByte(timeoutMillis: Long): Int? =
            withContext(io) {
                // Poll instead of a blocking read: a Bluetooth read cannot be interrupted.
                var waited = 0L
                while (waited < timeoutMillis) {
                    if (socket.input.available() > 0) return@withContext socket.input.read().takeIf { it >= 0 }
                    delay(POLL_MILLIS)
                    waited += POLL_MILLIS
                }
                null
            }

        override fun close() = socket.closeQuietly()
    }

    companion object {
        /** The well-known Serial Port Profile service UUID that ESC/POS printers offer. */
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

        private const val POLL_MILLIS = 20L

        /**
         * Runs a blocking socket call with a time limit: when [timeoutMillis] passes, [socket] is
         * closed so the call fails, and the failure is reported as [PrinterTimeoutException].
         */
        internal suspend fun <T> bounded(
            timeoutMillis: Long,
            stage: String,
            socket: Closeable,
            io: CoroutineDispatcher,
            block: () -> T,
        ): T =
            coroutineScope {
                val timedOut = AtomicBoolean(false)
                val watchdog =
                    launch(io) {
                        delay(timeoutMillis)
                        timedOut.set(true)
                        socket.closeQuietly()
                    }
                try {
                    withContext(io) { block() }
                } catch (e: IOException) {
                    throw if (timedOut.get()) PrinterTimeoutException(stage, e) else e
                } finally {
                    watchdog.cancel()
                }
            }

        /** A timeout stays a timeout; any other connect failure means the printer is unreachable. */
        private fun IOException.asConnectFailure(): IOException =
            this as? PrinterTimeoutException ?: PrinterUnreachableException(this)

        private fun Closeable.closeQuietly() {
            try {
                close()
            } catch (_: IOException) {
                // Already closed or broken: nothing to do.
            }
        }
    }
}
