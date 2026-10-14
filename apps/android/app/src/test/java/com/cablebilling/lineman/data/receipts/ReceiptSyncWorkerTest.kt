package com.cablebilling.lineman.data.receipts

import android.content.Context
import android.util.Log
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
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.db.putRoster
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.sync.RosterSync
import com.cablebilling.lineman.data.sync.RosterSyncScheduler
import mockwebserver3.MockWebServer
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

/** The receipt sync as WorkManager runs it: results, the roster pull after a phone change, unique work. */
@RunWith(AndroidJUnit4::class)
class ReceiptSyncWorkerTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val db = inMemoryDatabase()
    private val time = FakeTime()
    private val office = FakeReceiptOffice(FakePaymentServer())
    private val routes =
        Routes { request ->
            office.handle(request) ?: when (request.apiPath) {
                "/sync/customers" -> Fixtures.response("syncCustomers.response.empty.json")
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }
    private lateinit var network: TestNetwork
    private lateinit var requests: TestRequestStore
    private lateinit var sync: ReceiptSync
    private lateinit var roster: RosterSyncScheduler
    private lateinit var phoneBook: ReceiptPhoneBook
    private lateinit var workManager: WorkManager

    private val factory =
        object : WorkerFactory() {
            override fun createWorker(
                appContext: Context,
                workerClassName: String,
                workerParameters: WorkerParameters,
            ): ListenableWorker? =
                if (workerClassName == ReceiptSyncWorker::class.java.name) {
                    ReceiptSyncWorker(appContext, workerParameters, sync, roster)
                } else {
                    null
                }
        }

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        val config =
            Configuration
                .Builder()
                .setMinimumLoggingLevel(Log.DEBUG)
                .setExecutor(SynchronousExecutor())
                .setWorkerFactory(factory)
                .build()
        WorkManagerTestInitHelper.initializeTestWorkManager(context, config)
        workManager = WorkManager.getInstance(context)
        network = TestNetwork(server, File(folder.root, "net").apply { mkdirs() })
        requests = TestRequestStore(folder.root)
        await { network.store.signIn(PaymentFixtures.login) }
        await { db.putRoster(RosterFixtures.login.operator.id, RosterFixtures.page.customers) }
        val trigger = RecordingSyncTrigger()
        val links = ReceiptLinks(db, network.mobileApi, network.errors, requests.store, time, trigger)
        sync =
            ReceiptSync(
                db,
                network.mobileApi,
                network.errors,
                network.store,
                requests.store,
                links,
                time,
                testLog(folder.root),
            )
        val rosterSync = RosterSync(network.mobileApi, network.errors, network.store, RosterStore(db, time))
        roster = RosterSyncScheduler(context, { rosterSync }, network.store)
        phoneBook = ReceiptPhoneBook(db, requests.store, network.store, time, trigger)
    }

    @After
    fun tearDown() {
        requests.close()
        network.close()
        server.close()
        db.close()
    }

    private fun runWorker(): ListenableWorker.Result =
        await {
            TestListenableWorkerBuilder<ReceiptSyncWorker>(context)
                .setWorkerFactory(factory)
                .build()
                .doWork()
        }

    private fun rosterPullRequested(): Boolean =
        workManager
            .getWorkInfosForUniqueWork(
                RosterSyncScheduler.NOW_WORK,
            ).get(WAIT_SECONDS, TimeUnit.SECONDS)
            .isNotEmpty()

    @Test
    fun `a phone change the office took succeeds and pulls the roster`() {
        await { phoneBook.confirm(RosterFixtures.ramesh.id, "9123456780") }
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertTrue(rosterPullRequested())
    }

    @Test
    fun `nothing queued is a success without a roster pull`() {
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertFalse(rosterPullRequested())
    }

    @Test
    fun `offline retries, app too old fails, signed out succeeds - the change stays queued`() {
        await { phoneBook.confirm(RosterFixtures.ramesh.id, "9123456780") }
        office.online = false
        assertEquals(ListenableWorker.Result.retry(), runWorker())
        office.online = true
        office.phoneAnswer = { Fixtures.response("error.APP_TOO_OLD.json") }
        assertEquals(ListenableWorker.Result.failure(), runWorker())
        await { network.store.end(com.cablebilling.lineman.data.auth.SignOutReason.SIGNED_OUT) }
        assertEquals(ListenableWorker.Result.success(), runWorker())
        assertEquals("9123456780", await { requests.store.current() }.phones.single().phone)
    }

    @Test
    fun `one unique work that needs a network, with exponential backoff, waiting at most once`() {
        val scheduler = ReceiptSyncScheduler(context, db, network.store) { sync }
        assertFalse("nothing queued: no run", await { scheduler.syncIfWork() })
        await { phoneBook.confirm(RosterFixtures.ramesh.id, "9123456780") }
        assertTrue(await { scheduler.syncIfWork() })
        assertFalse(await { scheduler.enqueue() })

        val info =
            workManager
                .getWorkInfosForUniqueWork(
                    ReceiptSyncScheduler.WORK,
                ).get(WAIT_SECONDS, TimeUnit.SECONDS)
                .single()
        assertEquals(WorkInfo.State.ENQUEUED, info.state)
        assertEquals(NetworkType.CONNECTED, info.constraints.requiredNetworkType)
        assertTrue(ReceiptSyncScheduler.TAG in info.tags)
        val request = ReceiptSyncScheduler.request()
        assertEquals(BackoffPolicy.EXPONENTIAL, request.workSpec.backoffPolicy)
        assertEquals(
            TimeUnit.SECONDS.toMillis(ReceiptSyncScheduler.BACKOFF_SECONDS),
            request.workSpec.backoffDelayDuration,
        )
    }

    private companion object {
        const val WAIT_SECONDS = 10L
    }
}
