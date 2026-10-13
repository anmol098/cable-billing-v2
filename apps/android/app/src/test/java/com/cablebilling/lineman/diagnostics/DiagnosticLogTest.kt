package com.cablebilling.lineman.diagnostics

import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.sync.PushStatus
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.IOException
import java.util.concurrent.Executor

/** The diagnostic log: size cap (ring buffer), newest lines kept, no personal data, crash lines. */
class DiagnosticLogTest {
    @get:Rule
    val folder = TemporaryFolder()

    /** Writes at once on the calling thread (the app uses one background thread). */
    private val direct = Executor { it.run() }
    private var now = 1_791_000_000_000L

    private fun log(maxBytes: Int = DiagnosticLog.DEFAULT_MAX_BYTES) =
        DiagnosticLog(folder.root, maxBytes = maxBytes, clock = { now++ }, writer = direct)

    private fun sizeOnDisk(): Long =
        folder.root
            .listFiles()
            .orEmpty()
            .sumOf(File::length)

    @Test
    fun `lines have a UTC time, a level, the event and the detail`() {
        val log = log()
        log.info("app_start", "app=0.1.0 (1)")
        log.warn("payment_push", "status=no_internet")

        assertEquals(
            listOf(
                "2026-10-03T04:00:00.000Z I app_start app=0.1.0 (1)",
                "2026-10-03T04:00:00.001Z W payment_push status=no_internet",
            ),
            log.lines(),
        )
    }

    @Test
    fun `the log never grows past its cap and keeps the newest lines`() {
        val cap = 16_000
        val log = log(maxBytes = cap)
        repeat(2_000) { log.info("payment_push", "n=$it status=finished") }

        assertTrue("on disk: ${sizeOnDisk()}", sizeOnDisk() <= cap)
        val lines = log.lines()
        assertTrue(lines.last().endsWith("n=1999 status=finished"))
        // Oldest first, without gaps inside what is kept.
        val numbers = lines.map { it.substringAfter("n=").substringBefore(' ').toInt() }
        assertEquals((numbers.first()..1999).toList(), numbers)
        assertTrue("kept ${numbers.size} lines", numbers.size > 100)
    }

    @Test
    fun `the log survives a restart of the app`() {
        log().info("app_start", "app=1")
        assertEquals(1, log().lines().size)
    }

    @Test
    fun `personal data never reaches the file, not even from exception messages`() {
        val log = log()
        log.info("event", "customer_name=Ramesh phone=9876543210 token=s3cr3tvalue amount_paise=45000")
        log.error("print_failed", IOException("could not reach 9876543210 for रमेश, Bearer eyJabc.def.ghi"))
        log.crash(IllegalStateException("customer Ramesh Kumar owes ₹450", IOException("token=rt-secret-1")))

        val disk =
            folder.root
                .listFiles()
                .orEmpty()
                .joinToString("\n") { it.readText() }
        for (secret in listOf(
            "Ramesh",
            "9876543210",
            "s3cr3tvalue",
            "45000",
            "रमेश",
            "eyJabc",
            "₹450",
            "owes",
            "rt-secret-1",
        )) {
            assertFalse("'$secret' on disk:\n$disk", disk.contains(secret))
        }
        // The crash keeps what support needs: the exception types and where it happened.
        assertTrue(disk.contains(" E crash java.lang.IllegalStateException"))
        assertTrue(disk.contains("caused by java.io.IOException"))
        assertTrue(disk.contains("at com.cablebilling.lineman.diagnostics.DiagnosticLogTest"))
    }

    @Test
    fun `an event name that is not a code is replaced, and long lines are cut`() {
        val log = log()
        log.info("Ramesh Kumar paid", "x".repeat(5_000))
        val line = log.lines().single()
        assertTrue(line, line.contains(" I event "))
        assertFalse(line.contains("Ramesh"))
        assertEquals(DiagnosticLog.MAX_LINE_CHARS, line.length)
    }

    @Test
    fun `a crash is written before crash() returns, even when the writer never runs`() {
        val stuck = Executor { }
        val log = DiagnosticLog(folder.root, writer = stuck)
        log.info("lost", "")
        log.crash(RuntimeException("boom"))
        assertEquals(1, log.lines().size)
        assertTrue(log.lines().single().contains(" E crash java.lang.RuntimeException at "))
    }

    @Test
    fun `the recorder logs session changes and push results as codes only`() =
        runBlocking {
            val sessions =
                DiagnosticsRecorder
                    .sessionEvents(
                        flowOf(
                            SessionState.Loading,
                            SessionState.SignedOut(null),
                            SessionState.SignedOut(null),
                            SessionState.SignedOut(SignOutReason.PHONE_SIGNED_OUT),
                        ),
                    ).toList()
            assertEquals(
                listOf("session" to "signed_out reason=none", "session" to "signed_out reason=phone_signed_out"),
                sessions,
            )
            val pushes =
                DiagnosticsRecorder
                    .pushEvents(
                        flowOf(
                            PushStatus.Idle,
                            PushStatus.Running,
                            PushStatus.NoInternet,
                            PushStatus.Running,
                            PushStatus.Finished,
                        ),
                    ).toList()
            assertEquals(
                listOf("running", "no_internet", "running", "finished").map { "payment_push" to "status=$it" },
                pushes,
            )
        }
}
