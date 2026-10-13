package com.cablebilling.lineman.data.sync

import android.content.Context
import android.util.Log
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.work.BackoffPolicy
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerFactory
import androidx.work.WorkerParameters
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.CableMigrations
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.di.NetworkModule
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The WorkManager side of the push: what [PaymentSyncWorker] returns for each outcome (and the roster
 * pull after a push), the unique work [PaymentSyncScheduler] enqueues, and **process death right after
 * Save**: the app is "killed" by closing the Room database and every object holding state, and a new
 * "process" (new database, network, session store, sync, scheduler on the same files) finds the
 * payment and sends it exactly once.
 */
@RunWith(AndroidJUnit4::class)
class PaymentSyncWorkerTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val time = FakeTime()
    private val json = NetworkModule.provideJson()
    private val office = FakePaymentServer()
    private lateinit var dbFile: File

    /** The current "process". */
    private lateinit var db: CableDatabase
    private lateinit var network: TestNetwork
    private lateinit var sync: PaymentSync
    private lateinit var roster: RosterSyncScheduler

    @Volatile
    private var batchAnswer: (RecordedRequest) -> MockResponse = office::handle

    private val routes =
        Routes { request ->
            when (request.apiPath) {
                "/payments:batch" -> batchAnswer(request)
                "/sync/customers" -> Fixtures.response("syncCustomers.response.empty.json")
                "/app/config" -> Fixtures.response("getAppConfig.response.json")
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }

    private val factory =
        object : WorkerFactory() {
            override fun createWorker(
                appContext: Context,
                workerClassName: String,
                workerParameters: WorkerParameters,
            ): ListenableWorker? =
                when (workerClassName) {
                    PaymentSyncWorker::class.java.name -> PaymentSyncWorker(appContext, workerParameters, sync, roster)
                    else -> null // the roster pull itself is RosterSyncWorkerTest's job
                }
        }

    private lateinit var workManager: WorkManager

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        dbFile = File(folder.root, "cable.db")
        val config =
            Configuration
                .Builder()
                .setMinimumLoggingLevel(Log.DEBUG)
                .setExecutor(SynchronousExecutor())
                .setWorkerFactory(factory)
                .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
        workManager = WorkManager.getInstance(context)
        startProcess(TestNetwork(server, File(folder.root, "net").apply { mkdirs() }))
        await { network.store.signIn(PaymentFixtures.login) }
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    /** A new "app process" on the same files: database, session storage, network stack, sync objects. */
    private fun startProcess(net: TestNetwork) {
        network = net
        db = fileDatabase()
        sync = PaymentSync(db, network.mobileApi, network.errors, network.store, time, json)
        val rosterSync = RosterSync(network.mobileApi, network.errors, network.store, RosterStore(db, time))
        roster = RosterSyncScheduler(context, { rosterSync }, network.store)
    }

    private fun fileDatabase(): CableDatabase =
        Room
            .databaseBuilder(context, CableDatabase::class.java, dbFile.absolutePath)
            .apply { CableMigrations.ALL.forEach { addMigrations(it) } }
            .build()

    /** Kills the "process": nothing in memory survives, only the files. */
    private fun killProcess() {
        db.close()
        network.close()
    }

    private fun scheduler() = PaymentSyncScheduler(context, db, network.store, { sync }, roster)

    private fun save(): String {
        time.now += 1_000
        val result =
            await { PaymentRepository(db, network.store, time, RecordingPushTrigger()).save(PaymentFixtures.draft()) }
        return (result as SaveResult.Saved).paymentId
    }

    private fun runWorker(attempt: Int = 0): ListenableWorker.Result =
        await {
            TestListenableWorkerBuilder<PaymentSyncWorker>(context)
                .setRunAttemptCount(attempt)
                .setWorkerFactory(factory)
                .build()
                .doWork()
        }

    private fun pushWork(): List<WorkInfo> =
        workManager.getWorkInfosForUniqueWork(PaymentSyncScheduler.WORK).get(WAIT_SECONDS, TimeUnit.SECONDS)

    private fun rosterPullRequested(): Boolean =
        workManager
            .getWorkInfosForUniqueWork(
                RosterSyncScheduler.NOW_WORK,
            ).get(WAIT_SECONDS, TimeUnit.SECONDS)
            .isNotEmpty()

    /** The network comes back: every waiting push runs until none is waiting, running or blocked. */
    private fun networkBack() {
        repeat(MAX_RUNS) {
            waitFor { pushWork().none { it.state == WorkInfo.State.RUNNING } }
            val waiting = pushWork().filter { it.state == WorkInfo.State.ENQUEUED }
            if (waiting.isEmpty() && pushWork().none { it.state == WorkInfo.State.BLOCKED }) return
            waiting.forEach { WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(it.id) }
            val ids = waiting.map { it.id }.toSet()
            waitFor {
                pushWork().filter { it.id in ids }.all {
                    it.state.isFinished ||
                        (it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount > 0)
                }
            }
        }
    }

    @Test
    fun `a push that posts succeeds and asks for a roster pull`() {
        val id = save()

        assertEquals(ListenableWorker.Result.success(), runWorker())

        assertEquals(PaymentState.SENT_TO_OFFICE, await { db.paymentDao().get(id) }!!.state)
        assertTrue(rosterPullRequested())
    }

    @Test
    fun `nothing to send is a success without a roster pull`() {
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertFalse(rosterPullRequested())
        assertEquals(0, office.batches.size)
    }

    @Test
    fun `no internet or a server problem retries with backoff and never gives up`() {
        save()
        batchAnswer = { MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build() }
        assertEquals(ListenableWorker.Result.retry(), runWorker())
        // Unlike the roster pull there is no attempt limit: a payment is never given up (BR-11).
        assertEquals(ListenableWorker.Result.retry(), runWorker(attempt = 100))
        batchAnswer = { Fixtures.response("error.INTERNAL.json") }
        assertEquals(ListenableWorker.Result.retry(), runWorker(attempt = 3))
        assertFalse(rosterPullRequested())
    }

    @Test
    fun `app too old or signed out ends this run, the payment stays for the next trigger`() {
        val id = save()
        batchAnswer = { Fixtures.response("error.APP_TOO_OLD.json") }
        assertEquals(ListenableWorker.Result.failure(), runWorker())

        await { network.store.end(SignOutReason.PHONE_SIGNED_OUT) }
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertEquals(PaymentState.SAVED_ON_PHONE, await { db.paymentDao().get(id) }!!.state)
    }

    @Test
    fun `the push is one unique work that needs a network, with exponential backoff, and waits at most once`() {
        val scheduler = scheduler()
        save()

        assertTrue(await { scheduler.enqueue() })
        // More saves while it waits for the network: no second waiting push.
        assertFalse(await { scheduler.enqueue() })
        // requestPush (after each save) enqueues in the background; whenever it runs, it finds the waiting push.
        scheduler.requestPush()
        scheduler.requestPush()
        assertFalse(await { scheduler.enqueue() })

        val work = pushWork()
        assertEquals(1, work.size)
        val info = work.single()
        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertEquals(NetworkType.CONNECTED, info.constraints.requiredNetworkType)
        assertTrue(PaymentSyncScheduler.TAG in info.tags)
        val request = PaymentSyncScheduler.request()
        assertEquals(BackoffPolicy.EXPONENTIAL, request.workSpec.backoffPolicy)
        assertEquals(
            TimeUnit.SECONDS.toMillis(PaymentSyncScheduler.BACKOFF_SECONDS),
            request.workSpec.backoffDelayDuration,
        )
        assertEquals(0, office.batches.size)

        networkBack()

        assertEquals(1, office.postedCount)
        assertEquals(WorkInfo.State.SUCCEEDED, pushWork().last().state)
        // After a finished push, a new save starts a new run.
        val next = save()
        assertTrue(await { scheduler.enqueue() })
        networkBack()
        assertEquals(PaymentState.SENT_TO_OFFICE, await { db.paymentDao().get(next) }!!.state)
        assertEquals(2, office.postedCount)
    }

    @Test
    fun `sign-in and app start push the signed-in lineman's own payments only`() {
        val scheduler = scheduler()
        // Only another lineman's payment on the phone: nothing to push for this sign-in.
        await { network.store.end(SignOutReason.SIGNED_OUT) }
        await { network.store.signIn(PaymentFixtures.otherLogin) }
        save()
        await { network.store.end(SignOutReason.SIGNED_OUT) }
        await { network.store.signIn(PaymentFixtures.login) }

        assertFalse(await { scheduler.pushIfOwnPayments(PaymentFixtures.login.user.id) })
        assertTrue(pushWork().isEmpty())

        // Suresh saves one: the push sends his, not Mohan's.
        save()
        assertTrue(await { scheduler.pushIfOwnPayments(PaymentFixtures.login.user.id) })
        networkBack()
        assertEquals(1, office.postedCount)
        assertEquals(PaymentFixtures.login.user.id, office.received.single().collectorId)
    }

    @Test
    fun `kill the app right after Save - the payment is there after restart and syncs once`() {
        // Process 1: the lineman taps Save; the app is killed before any push ran.
        val id = save()
        killProcess()

        // Process 2: a fresh start on the same files (the stored sign-in is read again).
        startProcess(network.restart())
        val row = await { db.paymentDao().get(id) }!!
        assertEquals(PaymentState.SAVED_ON_PHONE, row.state)
        assertEquals("P-K7Q-0001", row.provisionalRef)
        val scheduler = scheduler()
        scheduler.start() // CableApplication.onCreate
        waitFor { pushWork().isNotEmpty() }
        networkBack()

        assertEquals(1, office.postedCount)
        assertEquals(1, office.received.size)
        assertEquals(PaymentState.SENT_TO_OFFICE, await { db.paymentDao().get(id) }!!.state)
        assertEquals(office.receiptOf(id), await { db.paymentDao().get(id) }!!.receiptNumber)

        // Another app open: nothing left, nothing sent again.
        killProcess()
        startProcess(network.restart())
        assertFalse(await { scheduler().pushIfOwnPayments(PaymentFixtures.login.user.id) })
        networkBack()
        assertEquals(1, office.received.size)
        assertEquals(1, office.postedCount)
    }

    @Test
    fun `killed after the office saved the batch but before the phone stored the answer - sent once`() {
        val id = save()
        office.dropAnswers = 1
        assertEquals(ListenableWorker.Result.retry(), runWorker())
        assertEquals(1, office.postedCount)
        killProcess()

        startProcess(network.restart())
        scheduler().start()
        waitFor { pushWork().isNotEmpty() }
        networkBack()

        val row = await { db.paymentDao().get(id) }!!
        assertEquals(PaymentState.SENT_TO_OFFICE, row.state)
        assertEquals(office.receiptOf(id), row.receiptNumber)
        assertEquals(1, office.postedCount)
        assertEquals(2, office.received.size) // sent twice, saved once (the second answer was "duplicate")
    }

    private fun waitFor(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + TimeUnit.SECONDS.toMillis(WAIT_SECONDS)
        while (!condition()) {
            assertTrue("timed out", System.currentTimeMillis() < deadline)
            Thread.sleep(POLL_MS)
        }
    }

    private companion object {
        const val WAIT_SECONDS = 20L
        const val POLL_MS = 50L
        const val MAX_RUNS = 10
    }
}
