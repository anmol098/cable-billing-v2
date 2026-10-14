package com.cablebilling.lineman.durability

import android.content.Context
import androidx.room.Room
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.CableMigrations
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.OutboxState
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.RosterRepository
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverStatus
import com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.network.generated.ReceiptActionType
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentDraft
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.data.payments.UuidV7
import com.cablebilling.lineman.data.receipts.FakeReceiptOffice
import com.cablebilling.lineman.data.receipts.OutboxReceiptActions
import com.cablebilling.lineman.data.receipts.ReceiptLinks
import com.cablebilling.lineman.data.receipts.ReceiptSync
import com.cablebilling.lineman.data.receipts.RecordingSyncTrigger
import com.cablebilling.lineman.data.receipts.TestRequestStore
import com.cablebilling.lineman.data.receipts.testLog
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.data.sync.RosterSync
import com.cablebilling.lineman.data.sync.RosterSyncResult
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.feature.today.FakeHandoverOffice
import com.cablebilling.lineman.feature.today.HandoverSendResult
import com.cablebilling.lineman.feature.today.PaymentsFirst
import com.cablebilling.lineman.feature.today.QueueResult
import com.cablebilling.lineman.feature.today.TodayFixtures
import com.cablebilling.lineman.feature.today.TodayRepository
import com.cablebilling.lineman.feature.today.sendWithPaymentsFirst
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

/**
 * The whole offline field day on Robolectric with every outbox of the app, against the contract
 * fixtures and the fake offices of T-066 / T-069 / T-070 (so it cannot run on a phone; the shared
 * suite in src/androidTest/shared covers the payment queue there):
 *
 * morning roster pull → airplane mode → search still answers → payments (cash and UPI), print results
 * recorded, the cash handover saved → the app killed twice → evening: payments first, then the
 * handover (the office's expected cash already counts them), then the receipt actions; each reaches
 * the office exactly once, and a second evening run sends nothing.
 */
@RunWith(AndroidJUnit4::class)
class FieldDayOfflineTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val time = FakeTime(DurabilityFixtures.MORNING)
    private val json = NetworkModule.provideJson()
    private val payments = FakePaymentServer()
    private val receipts = FakeReceiptOffice(payments)
    private val handovers = FakeHandoverOffice()

    @Volatile
    private var airplaneMode = false

    /** The office stores receipt-action batches but the answers are lost (sticky: OkHttp may resend once). */
    @Volatile
    private var loseActionAnswers = false
    private val routes = Routes(::answer)
    private lateinit var app: App

    /** One app process on the test's files. */
    private inner class App(
        aead: com.google.crypto.tink.Aead,
    ) {
        val db: CableDatabase =
            Room
                .databaseBuilder(context, CableDatabase::class.java, File(folder.root, CableDatabase.NAME).absolutePath)
                .apply { CableMigrations.ALL.forEach { addMigrations(it) } }
                .build()
        val network = TestNetwork(server, folder.root, aead = aead)
        val requests = TestRequestStore(folder.root)
        private val log = testLog(folder.root)
        private val trigger = RecordingSyncTrigger()
        private val rosterStore = RosterStore(db, time)
        val rosterSync = RosterSync(network.mobileApi, network.errors, network.store, rosterStore)
        val roster = RosterRepository(db, rosterStore, network.store, network.mobileApi, network.errors, time)
        val repository = PaymentRepository(db, network.store, time, RecordingPushTrigger())
        val paymentSync = PaymentSync(db, network.mobileApi, network.errors, network.store, time, json)
        val recorder = OutboxReceiptActions(db, time, trigger, log)
        private val links = ReceiptLinks(db, network.mobileApi, network.errors, requests.store, time, trigger)
        val receiptSync =
            ReceiptSync(db, network.mobileApi, network.errors, network.store, requests.store, links, time, log)
        val today = TodayRepository(db, network.mobileApi, network.errors, network.store, time, json) { }
        val paymentsFirst = PaymentsFirst { paymentSync.run() }

        fun close() {
            network.close()
            requests.close()
            db.close()
        }
    }

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        app = App(TestNetwork.testAead())
        await { app.network.store.signIn(RosterFixtures.login) }
    }

    @After
    fun tearDown() {
        app.close()
        server.close()
    }

    private fun answer(request: RecordedRequest): MockResponse {
        val path = request.apiPath
        val receiptAnswer = if (airplaneMode) null else receipts.handle(request)
        return when {
            airplaneMode -> cut()
            receiptAnswer != null && loseActionAnswers && path == "/receipts/actions:batch" -> cut()
            receiptAnswer != null -> receiptAnswer
            path == "/payments:batch" -> postPayments(request)
            path.startsWith("/collections/") -> handovers.handle(request)
            path == "/sync/customers" -> Fixtures.response("syncCustomers.response.json")
            path == "/app/config" -> Fixtures.response("getAppConfig.response.json")
            else -> Fixtures.response("error.NOT_FOUND.json")
        }
    }

    private fun cut(): MockResponse = MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()

    /** The payment office and the collections office are one server: posted payments count in the day. */
    private fun postPayments(request: RecordedRequest): MockResponse {
        val response = payments.handle(request)
        json.decodeFromString(PaymentBatchRequest.serializer(), request.bodyText).payments.forEach { item ->
            if (handovers.payments.none { it.paymentId == item.id }) {
                handovers.payments += TodayFixtures.officePayment(item.id, item.amountPaise, item.method)
            }
        }
        return response
    }

    private fun restart() {
        val aead = app.network.aead
        app.close()
        app = App(aead)
    }

    private fun collect(
        customerCode: String,
        rupees: Long,
        method: PaymentMethod,
    ): String {
        time.advanceMinutes(MINUTES_BETWEEN)
        val customer = await { app.roster.search(customerCode).first() }.first { it.code == customerCode }
        val draft =
            PaymentDraft(
                id = UuidV7.generate(time.now),
                customerId = customer.id,
                customerCode = customer.code,
                customerName = customer.name,
                amountPaise = rupees * DurabilityFixtures.PAISE_PER_RUPEE,
                method = method,
                upiReference = if (method == PaymentMethod.UPI) "412345678901" else null,
            )
        return (await { app.repository.save(draft) } as SaveResult.Saved).paymentId
    }

    @Test
    fun anOfflineDayWithEveryOutbox_reachesTheOfficeOnceInTheEvening() {
        // Morning, at the office: the customer list comes down.
        assertTrue(await { app.rosterSync.run() } is RosterSyncResult.Synced)

        // In the field without internet.
        airplaneMode = true
        val cash1 = collect("1045", 500, PaymentMethod.CASH)
        val cash2 = collect("1046", 200, PaymentMethod.CASH)
        val upi = collect("1045", 450, PaymentMethod.UPI)
        await { app.recorder.record(cash1, ReceiptActionType.PRINTED).join() }
        await { app.recorder.record(cash2, ReceiptActionType.PRINT_FAILED).join() }
        assertTrue(await { app.paymentSync.run() }.sent == 0)
        restart()

        // Evening hand over, still offline: all the cash on the phone (₹700), the office has none of it yet.
        time.advanceMinutes(MINUTES_BETWEEN)
        val handover = HandoverRequest(SUBMISSION, 70_000, DiscrepancyReason.PENDING_SYNC, null, 2, 70_000)
        assertEquals(QueueResult.Queued(isNew = true), await { app.today.queueHandover(TodayFixtures.DATE, handover) })
        restart()

        // Everything is still on the phone after two kills.
        assertEquals(
            3,
            await {
                app.db
                    .paymentDao()
                    .observeSavedOnPhoneCount()
                    .first()
            },
        )
        assertEquals(2, await { app.db.receiptActionDao().countPending() })
        assertEquals(SUBMISSION, queuedSubmission())
        assertTrue(payments.received.isEmpty() && handovers.received.isEmpty() && receipts.actionBatches.isEmpty())

        // Internet is back: what the workers do, in their order.
        airplaneMode = false
        assertTrue(await { sendWithPaymentsFirst(app.today, app.paymentsFirst) } is HandoverSendResult.Done)
        await { app.receiptSync.run() }

        assertEquals(setOf(cash1, cash2, upi), payments.postedIds())
        assertEquals(3, payments.received.size)
        val stored = handovers.submissions.values.single()
        assertEquals(SUBMISSION, stored.submissionId)
        val office = handovers.handover!!
        assertEquals("the office counted the payments before the handover", 70_000L, office.cashExpectedPaise)
        assertEquals(0L, office.discrepancyPaise)
        assertEquals(HandoverStatus.SUBMITTED, handovers.status)
        assertEquals(listOf("printed", "print_failed"), receipts.actions.values.map { it.action.wire })
        val rows = listOf(cash1, cash2, upi).map { await { app.db.paymentDao().get(it) }!! }
        assertTrue(
            rows.all { it.state == PaymentState.SENT_TO_OFFICE && it.receiptNumber == payments.receiptOf(it.id) },
        )
        assertNull(queuedSubmission())
        assertEquals(0, await { app.db.receiptActionDao().countPending() })

        // A second evening run (another trigger, another app start) sends nothing again.
        restart()
        val before = routes.requests.size
        assertEquals(0, await { app.paymentSync.run() }.sent)
        await { sendWithPaymentsFirst(app.today, app.paymentsFirst) }
        await { app.receiptSync.run() }
        assertEquals(3, payments.received.size)
        assertEquals(1, handovers.received.size)
        assertEquals(1, receipts.actionBatches.size)
        assertTrue(routes.requests.drop(before).none { it.apiPath == "/payments:batch" || it.method == "POST" })
    }

    @Test
    fun receiptActionsSurviveKillsAndALostAnswer_recordedOnce() {
        assertTrue(await { app.rosterSync.run() } is RosterSyncResult.Synced)
        val paid = collect("1045", 500, PaymentMethod.CASH)
        await { app.recorder.record(paid, ReceiptActionType.PRINTED).join() }
        await { app.recorder.record(paid, ReceiptActionType.WHATSAPP_OPENED).join() }
        restart()

        await { app.paymentSync.run() }
        loseActionAnswers = true // the office stores them, the answer is lost
        await { app.receiptSync.run() }
        assertEquals(2, receipts.actions.size)
        assertEquals(2, await { app.db.receiptActionDao().countPending() })
        restart()

        loseActionAnswers = false
        await { app.receiptSync.run() }
        assertEquals(2, receipts.actions.size) // the resend was answered "duplicate"
        assertTrue(receipts.actionBatches.size >= 2)
        assertEquals(receipts.actionBatches.first().actions, receipts.actionBatches.last().actions)
        val rows =
            await {
                app.db
                    .receiptActionDao()
                    .observeForPayment(paid)
                    .first()
            }
        assertTrue(rows.all { it.state == OutboxState.RECORDED })
    }

    private fun queuedSubmission(): String? =
        await { app.today.observeDay(TodayFixtures.userId, TodayFixtures.DATE).first() }.queued?.submissionId

    private companion object {
        const val SUBMISSION = "0192ab00-0000-7000-8000-0000000000aa"
        const val MINUTES_BETWEEN = 20L
    }
}
