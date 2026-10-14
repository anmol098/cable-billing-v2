package com.cablebilling.lineman.durability

import android.content.Context
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import com.cablebilling.lineman.data.sync.PaymentSyncScheduler
import com.cablebilling.lineman.data.sync.PaymentSyncWorker
import org.junit.Assert.assertTrue
import java.util.concurrent.TimeUnit

/**
 * WorkManager for the durability suite, driven by its test driver. Its queue lives outside the app
 * "process" objects, exactly like WorkManager's own database on a phone: a request enqueued before
 * [Phone.kill] or a reboot is still there afterwards, and its worker is built from the process that is
 * running when it starts ([phone]). The network is the driver's "constraints met"; whether the office
 * answers is [FakeOffice]'s business (Wi-Fi without internet = constraints met, office unreachable).
 */
class PushWork(
    private val context: Context,
    private val phone: () -> Phone,
) {
    private val factory =
        object : WorkerFactory() {
            override fun createWorker(
                appContext: Context,
                workerClassName: String,
                workerParameters: WorkerParameters,
            ): ListenableWorker? {
                // Only the payment push; the roster pull a posted push asks for is not part of this suite.
                if (workerClassName != PaymentSyncWorker::class.java.name) return null
                val process = phone().process
                return PaymentSyncWorker(appContext, workerParameters, process.sync, process.roster)
            }
        }

    /**
     * A new, empty WorkManager. At the start of a test; again only to simulate a phone that lost its
     * scheduled jobs (force stop, some OEM "cleaners"): nothing queued before survives that.
     */
    fun install() {
        val config =
            Configuration
                .Builder()
                .setMinimumLoggingLevel(Log.INFO)
                .setExecutor(SynchronousExecutor())
                .setWorkerFactory(factory)
                .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
    }

    private val workManager: WorkManager get() = WorkManager.getInstance(context)

    /** The unique push work (`payment-sync`): every run in its chain. */
    fun runs(): List<WorkInfo> =
        workManager.getWorkInfosForUniqueWork(PaymentSyncScheduler.WORK).get(WAIT_SECONDS, TimeUnit.SECONDS)

    /** Runs waiting for a network (or for their backoff). */
    fun waiting(): List<WorkInfo> = runs().filter { it.state == WorkInfo.State.ENQUEUED }

    /** True when a push run is queued for later (enqueued or blocked behind another). */
    fun isQueued(): Boolean = runs().any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }

    /** Waits until the save's push request (asked for in the background) is in WorkManager's queue. */
    fun awaitQueued() = waitFor("a push run to be queued") { isQueued() }

    /**
     * The phone sees a network once: every waiting run starts and ends (sent, or retry with backoff
     * when the office could not be reached). It does not loop: see [networkBack].
     */
    fun networkBlip() {
        waitFor("running pushes to end") { runs().none { it.state == WorkInfo.State.RUNNING } }
        val waiting = waiting()
        val attempts = waiting.associate { it.id to it.runAttemptCount }
        waiting.forEach { driver().setAllConstraintsMet(it.id) }
        waitFor("the push to run") {
            runs().filter { it.id in attempts }.all { info ->
                info.state.isFinished ||
                    (info.state == WorkInfo.State.ENQUEUED && info.runAttemptCount > attempts.getValue(info.id))
            }
        }
    }

    /** The network is back for good: runs start until nothing is waiting, running or blocked. */
    fun networkBack() {
        repeat(MAX_ROUNDS) {
            waitFor("running pushes to end") { runs().none { it.state == WorkInfo.State.RUNNING } }
            if (!isQueued()) return
            networkBlip()
        }
        throw AssertionError("the push was still queued after $MAX_ROUNDS network rounds: ${runs()}")
    }

    /** Calls [PaymentSyncScheduler.start] on the main thread, as CableApplication.onCreate does. */
    fun appStart(process: PhoneProcess) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync { process.scheduler.start() }
    }

    private fun driver() = checkNotNull(WorkManagerTestInitHelper.getTestDriver(context))

    companion object {
        private const val WAIT_SECONDS = 20L
        private const val POLL_MS = 25L
        private const val MAX_ROUNDS = 10

        /** Polls [condition] (no fixed sleeps in the tests); fails after 20 s. */
        fun waitFor(
            what: String,
            condition: () -> Boolean,
        ) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(WAIT_SECONDS)
            while (!condition()) {
                assertTrue("timed out waiting for $what", System.nanoTime() < deadline)
                Thread.sleep(POLL_MS)
            }
        }
    }
}
