package com.cablebilling.lineman.printing.transport

import com.cablebilling.lineman.printing.PRINTER_ADDRESS
import com.cablebilling.lineman.printing.bytes
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The SPP transport with fake sockets (no Bluetooth here, real threads and clocks): timeouts close
 * the socket and become [PrinterTimeoutException]; refusals fall back to the insecure socket once.
 */
class SppTransportTest {
    private val shortTimeouts = PrinterTimeouts(connectMillis = 200, writeMillis = 200, statusMillis = 100)

    /** A socket whose connect / write can hang until it is closed, like a real BluetoothSocket. */
    private class FakeSocket(
        val connectHangs: Boolean = false,
        val connectFails: Boolean = false,
        val writeHangs: Boolean = false,
        answer: ByteArray = ByteArray(0),
    ) : SppSocket {
        private val closedLatch = CountDownLatch(1)
        val written = ByteArrayOutputStream()
        val closed: Boolean get() = closedLatch.count == 0L

        override fun connect() {
            if (connectFails) throw IOException("refused")
            if (connectHangs) hangUntilClosed()
        }

        override val input: InputStream = ByteArrayInputStream(answer)
        override val output: OutputStream =
            object : OutputStream() {
                override fun write(b: Int) {
                    if (writeHangs) hangUntilClosed()
                    written.write(b)
                }

                override fun write(
                    b: ByteArray,
                    off: Int,
                    len: Int,
                ) {
                    if (writeHangs) hangUntilClosed()
                    written.write(b, off, len)
                }
            }

        private fun hangUntilClosed() {
            check(closedLatch.await(10, TimeUnit.SECONDS)) { "never closed" }
            throw IOException("socket closed")
        }

        override fun close() = closedLatch.countDown()
    }

    private class Sockets(
        vararg sockets: FakeSocket,
    ) : SppSocketFactory {
        val queue = ArrayDeque(sockets.toList())
        val requests = mutableListOf<Pair<String, Boolean>>()

        override fun create(
            address: String,
            secure: Boolean,
        ): SppSocket {
            requests += address to secure
            return queue.removeFirstOrNull() ?: throw IOException("no socket")
        }
    }

    @Test(timeout = 10_000)
    fun writesReachTheSocketAndStatusIsRead() =
        runBlocking {
            val socket = FakeSocket(answer = bytes(0x12))
            val sockets = Sockets(socket)
            val link = SppTransport(sockets).connect(PRINTER_ADDRESS, shortTimeouts)
            link.write(bytes(0x1B, 0x40))
            link.write(bytes(0x10, 0x04, 0x04))
            assertEquals(0x12, link.readByte(100))
            // Nothing more to read: null after the wait, no blocking read.
            assertNull(link.readByte(50))
            link.close()
            assertArrayEquals(bytes(0x1B, 0x40, 0x10, 0x04, 0x04), socket.written.toByteArray())
            assertTrue(socket.closed)
            assertEquals(listOf(PRINTER_ADDRESS to true), sockets.requests)
        }

    @Test(timeout = 10_000)
    fun aHangingConnectTimesOutAndClosesTheSocket() =
        runBlocking {
            val socket = FakeSocket(connectHangs = true)
            val started = System.nanoTime()
            try {
                SppTransport(Sockets(socket)).connect(PRINTER_ADDRESS, shortTimeouts)
                fail("expected a timeout")
            } catch (e: PrinterTimeoutException) {
                assertEquals("connect", e.stage)
            }
            val tookMillis = (System.nanoTime() - started) / 1_000_000
            assertTrue("took $tookMillis ms", tookMillis in 150..5_000)
            assertTrue(socket.closed)
        }

    @Test(timeout = 10_000)
    fun aRefusedSecureSocketFallsBackToInsecureOnce() =
        runBlocking {
            val insecure = FakeSocket()
            val sockets = Sockets(FakeSocket(connectFails = true), insecure)
            SppTransport(sockets).connect(PRINTER_ADDRESS, shortTimeouts).write(bytes(0x1B, 0x40))
            assertEquals(listOf(PRINTER_ADDRESS to true, PRINTER_ADDRESS to false), sockets.requests)
            assertArrayEquals(bytes(0x1B, 0x40), insecure.written.toByteArray())
        }

    @Test(timeout = 10_000)
    fun bothRefusedIsUnreachable() =
        runBlocking {
            val first = FakeSocket(connectFails = true)
            val second = FakeSocket(connectFails = true)
            try {
                SppTransport(Sockets(first, second)).connect(PRINTER_ADDRESS, shortTimeouts)
                fail("expected unreachable")
            } catch (e: PrinterUnreachableException) {
                assertEquals(1, e.suppressed.size)
            }
            assertTrue(first.closed && second.closed)
            // No socket at all (bad address, Bluetooth gone) is unreachable too.
            try {
                SppTransport(Sockets()).connect(PRINTER_ADDRESS, shortTimeouts)
                fail("expected unreachable")
            } catch (_: PrinterUnreachableException) {
                // expected
            }
        }

    @Test(timeout = 10_000)
    fun aHangingWriteTimesOut() =
        runBlocking {
            val socket = FakeSocket(writeHangs = true)
            val link = SppTransport(Sockets(socket)).connect(PRINTER_ADDRESS, shortTimeouts)
            try {
                link.write(bytes(0x1B, 0x40))
                fail("expected a timeout")
            } catch (e: PrinterTimeoutException) {
                assertEquals("write", e.stage)
            }
            assertTrue(socket.closed)
        }

    @Test
    fun usesTheSerialPortProfile() {
        assertEquals(UUID.fromString("00001101-0000-1000-8000-00805f9b34fb"), SppTransport.SPP_UUID)
    }
}
