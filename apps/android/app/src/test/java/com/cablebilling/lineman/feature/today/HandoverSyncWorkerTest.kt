package com.cablebilling.lineman.feature.today

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
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.feature.today.TodayFixtures.DATE
import com.cablebilling.lineman.feature.today.TodayFixtures.userId
import kotlinx.coroutines.flow.first
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The WorkManager side of the handover: what [HandoverSyncWorker] returns, the unique work
 * [HandoverSyncScheduler] enqueues, and **process death**: a handover saved offline survives the app
 * being killed (Room on disk) and the next "process" sends it exactly once; killed after the office saved
 * it but before the phone stored the answer → resent, a duplicate, still one handover.
 */
@RunWith(AndroidJUnit4::class)
class HandoverSyncWorkerTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val time = FakeTime()
    private val json = NetworkModule.provideJson()
    private val office = FakeHandoverOffice()
    private val paymentOffice = FakePaymentServer()
    private lateinit var dbFile: File

    /** The current "process". */
    private lateinit var db: CableDatabase
    private lateinit var network: TestNetwork
    private lateinit var repository: TodayRepository
    private lateinit var paymentSync: PaymentSync
    private val paymentsFirst = PaymentsFirst { paymentSync.run() }

    @Volatile
    private var answer: (RecordedRequest) -> MockResponse = office::handle

    private val routes =
        Routes { request ->
            when {
                request.apiPath == "/payments:batch" -> postPayments(request)
                request.apiPath.startsWith("/collections/") -> answer(request)
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
                    HandoverSyncWorker::class.java.name -> {
                        HandoverSyncWorker(
                            appContext,
                            workerParameters,
                            repository,
                            paymentsFirst,
                        )
                    }

                    else -> {
                        null
                    }
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
        await { network.store.signIn(RosterFixtures.login) }
        office.payments += FakeHandoverOffice.fixturePayments()
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    private fun startProcess(net: TestNetwork) {
        network = net
        db =
            Room
                .databaseBuilder(context, CableDatabase::class.java, dbFile.absolutePath)
                .apply { CableMigrations.ALL.forEach { addMigrations(it) } }
                .build()
        repository = TodayRepository(db, network.mobileApi, network.errors, network.store, time, json) { }
        paymentSync = PaymentSync(db, network.mobileApi, network.errors, network.store, time, json)
    }

    /** The payment push reaches the same office: what it posts is in the office's day (cash expected). */
    private fun postPayments(request: RecordedRequest): MockResponse {
        if (answer === cut) return cut(request)
        val response = paymentOffice.handle(request)
        json.decodeFromString(PaymentBatchRequest.serializer(), request.bodyText).payments.forEach { item ->
            if (office.payments.none { it.paymentId == item.id }) {
                office.payments += TodayFixtures.officePayment(item.id, item.amountPaise, item.method)
            }
        }
        return response
    }

    private fun killProcess() {
        db.close()
        network.close()
    }

    private fun restart() {
        killProcess()
        startProcess(network.restart())
    }

    private fun runWorker(): ListenableWorker.Result =
        await {
            TestListenableWorkerBuilder<HandoverSyncWorker>(context)
                .setWorkerFactory(factory)
                .build()
                .doWork()
        }

    private fun queue(id: String = ID) =
        await {
            repository.queueHandover(DATE, HandoverRequest(id, 80_000, DiscrepancyReason.PENDING_SYNC, null, 1, 10_000))
        }

    private fun queued() = await { repository.observeDay(userId, DATE).first() }.queued

    private val cut: (RecordedRequest) -> MockResponse = {
        MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()
    }

    @Test
    fun `kill the app right after saving the handover offline - sent once after restart`() {
        answer = cut
        assertEquals(QueueResult.Queued(isNew = true), queue())
        assertEquals(ListenableWorker.Result.retry(), runWorker()) // no internet: tried again later, never dropped

        restart()
        answer = office::handle
        assertEquals(ID, queued()!!.submissionId) // still on the phone after the "process" died
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertEquals(1, office.received.size)
        assertNull(queued())

        restart()
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertEquals(1, office.received.size)
    }

    @Test
    fun `killed after the office saved it but before the phone stored the answer - one handover`() {
        queue()
        office.dropAnswers = 1
        assertEquals(ListenableWorker.Result.retry(), runWorker())
        assertEquals(1, office.submissions.size)

        restart()
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertEquals(2, office.received.size)
        assertEquals(office.received[0], office.received[1])
        assertEquals(1, office.submissions.size)
        assertNull(queued())
    }

    @Test
    fun `app too old stops this run and keeps the handover, signed out is not an error`() {
        queue()
        answer = { Fixtures.response("error.APP_TOO_OLD.json") }
        assertEquals(ListenableWorker.Result.failure(), runWorker())
        assertEquals(ID, queued()!!.submissionId)

        await { network.store.end(SignOutReason.SIGNED_OUT) }
        assertEquals(ListenableWorker.Result.success(), runWorker())
        await { network.store.signIn(RosterFixtures.login) }
        answer = office::handle
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertEquals(1, office.submissions.size)
    }

    @Test
    fun `the send is one unique work that needs a network, with exponential backoff, waiting at most once`() {
        val scheduler = HandoverSyncScheduler(context, { repository }, paymentsFirst)
        assertTrue(await { scheduler.enqueue() })
        val work = workManager.getWorkInfosForUniqueWork(HandoverSyncScheduler.WORK).get(WAIT_SECONDS, TimeUnit.SECONDS)
        val info = work.single()
        assertEquals(NetworkType.CONNECTED, info.constraints.requiredNetworkType)
        assertTrue(HandoverSyncScheduler.TAG in info.tags)
        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertEquals(BackoffPolicy.EXPONENTIAL, HandoverSyncScheduler.request().workSpec.backoffPolicy)
        assertEquals(TimeUnit.SECONDS.toMillis(30), HandoverSyncScheduler.request().workSpec.backoffDelayDuration)
        // Waiting for the network: a second request adds nothing.
        assertTrue(!await { scheduler.enqueue() })
    }

    @Test
    fun `the lineman's payments on the phone go to the office first, so its expected cash counts them`() {
        time.now += 1_000
        await { PaymentRepository(db, network.store, time, RecordingPushTrigger()).save(PaymentFixtures.draft(10_000)) }
        queue() // 800 rupees: the office's 700 + the 100 still on the phone
        assertEquals(ListenableWorker.Result.success(), runWorker())

        val paths = routes.requests.map { it.apiPath }
        assertTrue(paths.indexOf("/payments:batch") < paths.indexOfFirst { it.endsWith("/handover") })
        val handover = await { repository.observeDay(userId, DATE).first() }.office!!.handover!!
        assertEquals(80_000L, handover.cashExpectedPaise)
        assertEquals(0L, handover.discrepancyPaise)
        assertNull(handover.discrepancyReason) // the office dropped pending_sync: nothing differs any more
    }

    @Test
    fun `nothing to hand over - no payment push is started for it`() {
        time.now += 1_000
        await { PaymentRepository(db, network.store, time, RecordingPushTrigger()).save(PaymentFixtures.draft(10_000)) }
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertTrue(routes.requestsTo("/payments:batch").isEmpty())
    }

    private companion object {
        const val ID = "0192ab00-0000-7000-8000-000000000001"
        const val WAIT_SECONDS = 5L
    }
}
