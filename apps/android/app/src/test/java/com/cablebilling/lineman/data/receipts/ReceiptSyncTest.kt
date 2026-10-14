package com.cablebilling.lineman.data.receipts

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
import com.cablebilling.lineman.data.db.putRoster
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.ReceiptActionOutcome
import com.cablebilling.lineman.data.network.generated.ReceiptActionType
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.di.NetworkModule
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith

/**
 * The receipt outboxes against MockWebServer with the server's rules ([FakeReceiptOffice]): receipt
 * actions (only after their payment reached the office, idempotent, rejected / retry_later, a lost
 * answer, offline, process death), queued links (offline → later, before the payment sync → after)
 * and queued phone changes (offline, 404/501 while the endpoint is missing, VALIDATION, restart).
 */
@RunWith(AndroidJUnit4::class)
class ReceiptSyncTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val server = MockWebServer()
    private val time = FakeTime()
    private val json = NetworkModule.provideJson()
    private val payments = FakePaymentServer()
    private val office = FakeReceiptOffice(payments)

    @Volatile
    private var paymentsOnline = true
    private val routes =
        Routes { request ->
            office.handle(request) ?: when {
                request.apiPath == "/payments:batch" && paymentsOnline -> payments.handle(request)
                request.apiPath == "/payments:batch" -> FakeReceiptOffice.offline()
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }
    private lateinit var app: App

    /** One "process": database, request store, network stack, and the classes under test. */
    private inner class App(
        aead: com.google.crypto.tink.Aead,
    ) {
        val db: CableDatabase =
            Room
                .databaseBuilder(context, CableDatabase::class.java, folder.root.resolve("cable.db").absolutePath)
                .apply { CableMigrations.ALL.forEach { addMigrations(it) } }
                .build()
        val requests = TestRequestStore(folder.root)
        val network = TestNetwork(server, folder.root, aead = aead)
        val trigger = RecordingSyncTrigger()
        val log = testLog(folder.root)
        val recorder = OutboxReceiptActions(db, time, trigger, log)
        val links = ReceiptLinks(db, network.mobileApi, network.errors, requests.store, time, trigger)
        val phoneBook = ReceiptPhoneBook(db, requests.store, network.store, time, trigger)
        val sync = ReceiptSync(db, network.mobileApi, network.errors, network.store, requests.store, links, time, log)
        val repository = PaymentRepository(db, network.store, time, RecordingPushTrigger())
        val push = PaymentSync(db, network.mobileApi, network.errors, network.store, time, json)

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
        await { app.network.store.signIn(PaymentFixtures.login) }
        await { app.db.putRoster(RosterFixtures.login.operator.id, RosterFixtures.page.customers) }
    }

    @After
    fun tearDown() {
        app.close()
        server.close()
    }

    private fun restart() {
        val aead = app.network.aead
        app.close()
        app = App(aead)
    }

    private fun save(): String {
        time.now += 1_000
        return (await { app.repository.save(PaymentFixtures.draft()) } as SaveResult.Saved).paymentId
    }

    private fun record(
        paymentId: String,
        action: ReceiptActionType,
    ): String {
        time.now += 1_000
        await { app.recorder.record(paymentId, action).join() }
        return await { app.db.receiptActionDao().oldestPendingFor(paymentId) }.last().id
    }

    private suspend fun com.cablebilling.lineman.data.db.ReceiptActionDao.oldestPendingFor(paymentId: String) =
        oldestPending(1_000).filter { it.paymentId == paymentId }

    private fun action(id: String) = await { app.db.receiptActionDao().get(id) }!!

    private fun run(): ReceiptSyncResult = await { app.sync.run() }

    private fun pushPayments() = await { app.push.run() }

    @Test
    fun `actions wait for their payment, then go once with honest names only`() {
        val paymentId = save()
        val printed = record(paymentId, ReceiptActionType.PRINTED)
        val opened = record(paymentId, ReceiptActionType.WHATSAPP_OPENED)
        assertTrue("recording asks for a send", app.trigger.requests >= 2)

        // The payment is still on the phone: nothing is sent (the server would answer retry_later).
        assertEquals(ReceiptSyncResult.Done(0), run())
        assertTrue(routes.requestsTo("/receipts/actions:batch").isEmpty())
        assertEquals(OutboxState.PENDING, action(printed).state)

        pushPayments()
        assertEquals(ReceiptSyncResult.Done(0), run())
        assertEquals(OutboxState.RECORDED, action(printed).state)
        assertEquals(OutboxState.RECORDED, action(opened).state)
        assertEquals(listOf(printed, opened), office.actions.keys.toList())

        // The wire body: ids, payment, contract action names, UTC instants.
        val body = Json.parseToJsonElement(routes.requestsTo("/receipts/actions:batch").single().bodyText).jsonObject
        val items = body.getValue("actions").jsonArray.map { it.jsonObject }
        assertEquals(listOf("printed", "whatsapp_opened"), items.map { it.getValue("action").jsonPrimitive.content })
        assertEquals(listOf(paymentId, paymentId), items.map { it.getValue("payment_id").jsonPrimitive.content })
        assertTrue(
            items.all {
                it
                    .getValue("at")
                    .jsonPrimitive.content
                    .endsWith("Z")
            },
        )

        // Nothing left: another run sends nothing.
        run()
        assertEquals(1, routes.requestsTo("/receipts/actions:batch").size)
    }

    @Test
    fun `a lost answer resends the same ids and the office counts them once`() {
        val paymentId = save()
        pushPayments()
        val id = record(paymentId, ReceiptActionType.SMS_OPENED)
        office.dropActionAnswers = 1
        // The office stores the batch, then the answer is lost (OkHttp may resend at once on a
        // dropped pooled connection; either way the phone sends the same ids again).
        run()
        run()
        assertEquals(OutboxState.RECORDED, action(id).state)
        assertTrue(office.actionBatches.size >= 2)
        assertTrue(office.actionBatches.all { it.actions.single().id == id })
        assertEquals(1, office.actions.size)
    }

    @Test
    fun `rejected is kept and never resent, retry_later stays pending`() {
        val paymentId = save()
        pushPayments()
        val bad = record(paymentId, ReceiptActionType.PRINTED)
        val later = record(paymentId, ReceiptActionType.PDF_SHARED)
        office.forced[bad] = ReceiptActionOutcome.REJECTED
        office.forced[later] = ReceiptActionOutcome.RETRY_LATER

        assertTrue(run() is ReceiptSyncResult.RetryLater)
        assertEquals(OutboxState.REJECTED, action(bad).state)
        assertEquals("VALIDATION", action(bad).lastErrorCode)
        assertEquals(OutboxState.PENDING, action(later).state)
        assertEquals("INTERNAL", action(later).lastErrorCode)

        office.forced.clear()
        assertEquals(ReceiptSyncResult.Done(0), run())
        assertEquals(OutboxState.RECORDED, action(later).state)
        assertEquals(OutboxState.REJECTED, action(bad).state)
        assertEquals(
            listOf(later),
            office.actionBatches
                .last()
                .actions
                .map { it.id },
        )
    }

    @Test
    fun `offline keeps every action, and the outbox survives the app being killed`() {
        val paymentId = save()
        pushPayments()
        val id = record(paymentId, ReceiptActionType.PRINT_FAILED)
        office.online = false
        val offline = run()
        assertTrue(offline is ReceiptSyncResult.RetryLater)
        assertEquals("offline", action(id).lastErrorCode)

        restart() // Process death: only the files are left.
        await { app.network.store.load() }
        office.online = true
        assertEquals(ReceiptSyncResult.Done(0), run())
        assertEquals(OutboxState.RECORDED, action(id).state)
        assertEquals(
            "print_failed",
            office.actions
                .getValue(id)
                .action.wire,
        )
    }

    @Test
    fun `printing and sharing never touch the payment`() {
        val paymentId = save()
        val before = await { app.db.paymentDao().get(paymentId) }
        record(paymentId, ReceiptActionType.PRINT_FAILED)
        record(paymentId, ReceiptActionType.WHATSAPP_OPENED)
        run()
        assertEquals(before, await { app.db.paymentDao().get(paymentId) })
    }

    @Test
    fun `a link asked for offline is queued and made after the payment reaches the office`() {
        val paymentId = save()
        // The payment is on the phone: queued at once, without asking the server (it would say 404).
        assertEquals(LinkState.Queued, await { app.links.request(paymentId) })
        assertTrue(office.linkCalls.isEmpty())
        assertEquals(ReceiptSyncResult.Done(0), run())
        assertTrue(office.linkCalls.isEmpty())

        // Internet back: the push sends the payment, then the receipt sync makes the link.
        pushPayments()
        assertEquals(ReceiptSyncResult.Done(0), run())
        val receipt = await { app.db.paymentDao().get(paymentId) }!!.receiptNumber!!
        val ready = await { app.links.request(paymentId) } as LinkState.Ready
        assertEquals("https://cablebilling.example/r/token1", ready.url)
        assertEquals(receipt, ready.receiptNumber)
        // Reused: no second link (the server allows only 20 per receipt).
        await { app.links.request(paymentId) }
        assertEquals(1, office.linkCalls.size)
        assertTrue(await { app.requests.store.current() }.links.isEmpty())
    }

    @Test
    fun `a link for a payment at the office comes at once online, and is queued offline`() {
        val paymentId = save()
        pushPayments()
        office.online = false
        assertEquals(LinkState.Queued, await { app.links.request(paymentId) })
        assertTrue(run() is ReceiptSyncResult.RetryLater)
        assertEquals("offline", await { app.requests.store.current() }.links.single().lastError)

        restart()
        await { app.network.store.load() }
        office.online = true
        assertEquals(ReceiptSyncResult.Done(0), run())
        assertTrue(await { app.links.request(paymentId) } is LinkState.Ready)
    }

    @Test
    fun `a link expiring within a day is not reused`() {
        val paymentId = save()
        pushPayments()
        assertTrue(await { app.links.request(paymentId) } is LinkState.Ready)
        time.now = java.time.Instant
            .parse(FakeReceiptOffice.LINK_EXPIRES)
            .toEpochMilli() - 60_000
        assertTrue(await { app.links.request(paymentId) } is LinkState.Ready)
        assertEquals(2, office.linkCalls.size)
    }

    @Test
    fun `a phone change goes to the office when online and survives a restart`() {
        val ramesh = RosterFixtures.ramesh
        assertEquals("9876543210", await { app.phoneBook.phoneFor(ramesh.id) }.phone)
        // Same number: nothing to send.
        assertFalse(await { app.phoneBook.confirm(ramesh.id, "9876543210") })

        office.online = false
        assertTrue(await { app.phoneBook.confirm(ramesh.id, "9123456780") })
        assertEquals(CustomerPhone("9123456780", changePending = true), await { app.phoneBook.phoneFor(ramesh.id) })
        assertTrue(run() is ReceiptSyncResult.RetryLater)

        restart()
        await { app.network.store.load() }
        office.online = true
        val result = run()
        assertEquals(ReceiptSyncResult.Done(1), result)
        assertEquals(ramesh.id to "9123456780", office.phoneCalls.last())
        val body = Json.parseToJsonElement(routes.requestsTo("/phone").last().bodyText).jsonObject
        assertEquals("9123456780", body.getValue("phone").jsonPrimitive.content)
        // The office has it; the roster on the phone is older, so the new number still shows.
        assertEquals(CustomerPhone("9123456780", changePending = false), await { app.phoneBook.phoneFor(ramesh.id) })
        // Not sent again (the offline attempt never reached the office).
        run()
        assertEquals(1, office.phoneCalls.size)
    }

    @Test
    fun `a missing phone endpoint keeps the change without backoff, VALIDATION drops it`() {
        val ramesh = RosterFixtures.ramesh
        office.phoneAnswer = { Fixtures.response("error.NOT_FOUND.json") }
        await { app.phoneBook.confirm(ramesh.id, "9123456780") }
        assertEquals(ReceiptSyncResult.Done(0), run())
        office.phoneAnswer = {
            MockResponse
                .Builder()
                .code(501)
                .body("not implemented")
                .build()
        }
        assertEquals(ReceiptSyncResult.Done(0), run())
        val kept = await { app.requests.store.current() }.phones.single()
        assertNull(kept.sentAt)
        assertEquals(2, kept.attempts)
        assertEquals("9123456780", await { app.phoneBook.phoneFor(ramesh.id) }.phone)

        office.phoneAnswer = { Fixtures.response("error.VALIDATION.json") }
        run()
        assertTrue(await { app.requests.store.current() }.phones.isEmpty())
    }

    @Test
    fun `another lineman's queued work waits for its lineman`() {
        val paymentId = save()
        pushPayments()
        val id = record(paymentId, ReceiptActionType.PRINTED)
        await { app.phoneBook.confirm(RosterFixtures.ramesh.id, "9123456780") }
        await { app.network.store.end(com.cablebilling.lineman.data.auth.SignOutReason.SIGNED_OUT) }
        await { app.network.store.signIn(PaymentFixtures.otherLogin) }
        assertEquals(ReceiptSyncResult.Done(0), run())
        assertEquals(OutboxState.PENDING, action(id).state)
        assertTrue(office.phoneCalls.isEmpty())
        assertEquals(PaymentState.SENT_TO_OFFICE, await { app.db.paymentDao().get(paymentId) }!!.state)
    }
}
