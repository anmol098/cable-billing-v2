package com.cablebilling.lineman.data.sync

import android.content.Context
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.SocketEffect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

/**
 * The WorkManager side: what [RosterSyncWorker] returns for each outcome, and the work
 * [RosterSyncScheduler] enqueues (unique, network constraint, 30-minute period), run end to end
 * with WorkManager's test driver.
 */
@RunWith(AndroidJUnit4::class)
class RosterSyncWorkerTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val db: CableDatabase = inMemoryDatabase()
    private lateinit var network: TestNetwork
    private lateinit var sync: RosterSync

    /** What `GET /sync/customers` answers. */
    @Volatile
    private var syncAnswer: () -> MockResponse = { Fixtures.response("syncCustomers.response.json") }

    private val routes =
        Routes { request ->
            when (request.apiPath) {
                "/sync/customers" -> syncAnswer()
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
            ): ListenableWorker = RosterSyncWorker(appContext, workerParameters, sync, network.appConfig)
        }

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(RosterFixtures.login) }
        sync = RosterSync(network.mobileApi, network.errors, network.store, RosterStore(db, FakeTime()))
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    private fun runWorker(attempt: Int = 0): ListenableWorker.Result =
        await {
            TestListenableWorkerBuilder<RosterSyncWorker>(context)
                .setRunAttemptCount(attempt)
                .setWorkerFactory(factory)
                .build()
                .doWork()
        }

    @Test
    fun `a successful sync succeeds and refreshes the app config`() {
        assertEquals(ListenableWorker.Result.success(), runWorker())

        assertEquals(1, routes.requestsTo("/sync/customers").size)
        assertEquals(1, routes.requestsTo("/app/config").size)
        assertEquals(2, await { db.customerDao().count() })
    }

    @Test
    fun `no network or a server hiccup retries with backoff, up to a limit`() {
        syncAnswer = { MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build() }
        assertEquals(ListenableWorker.Result.retry(), runWorker())
        assertEquals(ListenableWorker.Result.failure(), runWorker(attempt = RosterSyncWorker.MAX_ATTEMPTS - 1))

        syncAnswer = { Fixtures.response("error.INTERNAL.json") }
        assertEquals(ListenableWorker.Result.retry(), runWorker())
        syncAnswer = { Fixtures.response("error.RATE_LIMITED.json") }
        assertEquals(ListenableWorker.Result.retry(), runWorker())
        assertEquals(0, routes.requestsTo("/app/config").size)
    }

    @Test
    fun `a refusal that retrying cannot fix fails until the next trigger`() {
        syncAnswer = { Fixtures.response("error.FORBIDDEN.json") }
        assertEquals(ListenableWorker.Result.failure(), runWorker())
    }

    @Test
    fun `nobody signed in is not a failure`() {
        await { network.store.end(com.cablebilling.lineman.data.auth.SignOutReason.SIGNED_OUT) }
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertEquals(0, routes.requestsTo("/sync/customers").size)
    }

    @Test
    fun `the scheduler enqueues one unique pull and a 30-minute periodic pull, both needing a network`() {
        val workManager = testWorkManager()
        val scheduler = RosterSyncScheduler(context, { sync }, network.store)

        scheduler.requestNow()
        scheduler.requestNow()
        scheduler.schedulePeriodic()
        scheduler.schedulePeriodic()

        val now =
            workManager
                .getWorkInfosForUniqueWork(
                    RosterSyncScheduler.NOW_WORK,
                ).get(WAIT_SECONDS, TimeUnit.SECONDS)
        assertEquals(1, now.size)
        assertEquals(WorkInfo.State.ENQUEUED, now.single().state)
        assertEquals(NetworkType.CONNECTED, now.single().constraints.requiredNetworkType)
        val periodic =
            workManager.getWorkInfosForUniqueWork(RosterSyncScheduler.PERIODIC_WORK).get(WAIT_SECONDS, TimeUnit.SECONDS)
        assertEquals(1, periodic.size)
        assertEquals(TimeUnit.MINUTES.toMillis(30), periodic.single().periodicityInfo?.repeatIntervalMillis)
        assertEquals(NetworkType.CONNECTED, periodic.single().constraints.requiredNetworkType)
        assertEquals(0, routes.requestsTo("/sync/customers").size)

        // The network comes back: the pull runs and the roster is on the phone.
        WorkManagerTestInitHelper.getTestDriver(context)!!.setAllConstraintsMet(now.single().id)
        waitFor { workManager.getWorkInfoById(now.single().id).get()?.state == WorkInfo.State.SUCCEEDED }
        assertEquals(2, await { db.customerDao().count() })
    }

    @Test
    fun `start schedules the pulls for a signed-in lineman`() {
        val workManager = testWorkManager()
        val scheduler = RosterSyncScheduler(context, { sync }, network.store)

        scheduler.start()

        waitFor {
            workManager.getWorkInfosForUniqueWork(RosterSyncScheduler.NOW_WORK).get().isNotEmpty() &&
                workManager.getWorkInfosForUniqueWork(RosterSyncScheduler.PERIODIC_WORK).get().isNotEmpty()
        }
    }

    private fun testWorkManager(): WorkManager {
        val config =
            Configuration
                .Builder()
                .setMinimumLoggingLevel(Log.DEBUG)
                .setExecutor(SynchronousExecutor())
                .setWorkerFactory(factory)
                .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
        return WorkManager.getInstance(context)
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
        const val POLL_MS = 20L
    }
}
