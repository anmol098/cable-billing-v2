package com.cablebilling.lineman.data.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.network.generated.PaymentOutcome
import com.cablebilling.lineman.data.payments.FakePaymentServer
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.data.payments.PaymentReceipts
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.payments.PaymentRules
import com.cablebilling.lineman.data.payments.RecordingPushTrigger
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.di.NetworkModule
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
import java.time.Instant

/**
 * The push (`POST /payments:batch`) against MockWebServer: the contract fixtures, a server with the
 * real idempotency rules ([FakePaymentServer]) and injected faults — an answer lost after the server
 * committed, 5xx, partial outcomes, `retry_later`, APP_TOO_OLD, signed out — plus the shared-phone
 * hold (PLAN §9.2). Nothing is ever deleted and nothing is counted twice.
 */
@RunWith(AndroidJUnit4::class)
class PaymentSyncTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val db: CableDatabase = inMemoryDatabase()
    private val time = FakeTime()
    private val json = NetworkModule.provideJson()
    private val office = FakePaymentServer()
    private lateinit var network: TestNetwork
    private lateinit var sync: PaymentSync
    private lateinit var repository: PaymentRepository

    /** What `POST /payments:batch` answers (default: the fake office). */
    @Volatile
    private var batchAnswer: (RecordedRequest) -> MockResponse = office::handle

    /** What `POST /auth/refresh` answers. */
    @Volatile
    private var refreshAnswer: (RecordedRequest) -> MockResponse = { Fixtures.response("refreshTokens.response.json") }

    private val routes =
        Routes { request ->
            when (request.apiPath) {
                "/payments:batch" -> batchAnswer(request)
                "/auth/refresh" -> refreshAnswer(request)
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }

    private val dao get() = db.paymentDao()
    private val userId get() = PaymentFixtures.login.user.id

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(PaymentFixtures.login) }
        sync = PaymentSync(db, network.mobileApi, network.errors, network.store, time, json)
        repository = PaymentRepository(db, network.store, time, RecordingPushTrigger())
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    private fun save(
        amountPaise: Long = 50_000,
        method: PaymentMethod = PaymentMethod.CASH,
        upiReference: String? = null,
    ): String {
        time.now += 1_000 // payments a second apart
        val result = await { repository.save(PaymentFixtures.draft(amountPaise, method, upiReference)) }
        return (result as SaveResult.Saved).paymentId
    }

    private fun row(id: String): PaymentEntity = await { dao.get(id) }!!

    private fun run(): PaymentSyncResult = await { sync.run() }

    private fun batchRequests() = routes.requestsTo("/payments:batch")

    /** The five payments of `postPaymentBatch.request.json`, saved on the phone as they would have been. */
    private fun insertFixturePayments(): PaymentBatchRequest {
        val request = Fixtures.decode(PaymentBatchRequest.serializer(), "postPaymentBatch.request.json")
        await {
            request.payments.forEach { item ->
                val at = Instant.parse(item.recordedAt).toEpochMilli()
                dao.insert(
                    PaymentEntity(
                        id = item.id,
                        customerId = item.customerId,
                        customerCode = "C",
                        customerName = "N",
                        amountPaise = item.amountPaise,
                        method = item.method,
                        upiReference = item.upiReference,
                        notes = item.notes,
                        recordedAt = at,
                        businessDate = PaymentRules.businessDate(at),
                        provisionalRef = item.provisionalRef,
                        collectorId = item.collectorId,
                        deviceId = item.deviceId,
                    ),
                )
            }
        }
        return request
    }

    @Test
    fun `the contract fixtures - request body and every outcome mapped to its state`() {
        val request = insertFixturePayments()
        batchAnswer = { Fixtures.response("postPaymentBatch.response.json") }

        val result = run()

        // The body is exactly the contract's example (absent = null on the wire).
        val sent = json.parseToJsonElement(batchRequests().single().bodyText)
        val expected = json.parseToJsonElement(Fixtures.text("postPaymentBatch.request.json"))
        assertEquals(Fixtures.withoutNulls(expected), Fixtures.withoutNulls(sent))

        val rows = request.payments.map { row(it.id) }
        val (posted, duplicate, review) = rows
        val rejected = rows[3]
        val retry = rows[4]
        assertEquals(PaymentState.SENT_TO_OFFICE, posted.state)
        assertEquals("R-2610-00045", posted.receiptNumber)
        assertEquals("P-K7Q-0012", posted.provisionalRef)
        assertEquals(Instant.parse("2026-10-13T11:29:58Z").toEpochMilli(), posted.postedAt)
        assertEquals("2026-10-13", posted.postedBusinessDate)
        assertEquals(40_000L, posted.balanceAfterPaise)
        assertEquals(0L, posted.creditAfterPaise)
        assertEquals(
            listOf(0L, 40_000L),
            PaymentReceipts.decodeAllocations(json, posted.allocationsJson).map {
                it.outstandingAfterPaise
            },
        )
        assertNull(posted.reviewReason)
        assertEquals(PaymentState.SENT_TO_OFFICE, duplicate.state)
        assertEquals("R-2610-00044", duplicate.receiptNumber)
        assertEquals(PaymentState.SENT_TO_OFFICE, review.state)
        assertEquals("customer_inactive", review.reviewReason)
        assertEquals(PaymentState.NEEDS_OFFICE_HELP, rejected.state)
        assertEquals("ID_REUSED_WITH_DIFFERENT_DATA", rejected.lastErrorCode)
        assertNull(rejected.receiptNumber)
        assertEquals(PaymentState.SAVED_ON_PHONE, retry.state)
        assertEquals("INTERNAL", retry.lastErrorCode)
        request.payments.forEach { assertEquals(1, row(it.id).attemptCount) }
        assertEquals(PaymentSyncResult.RetryLater(sent = 3, failure = null), result)
        assertEquals(PushStatus.Failed, sync.status.value)

        // The retry sends only the one still on the phone; the others never move again.
        batchAnswer = office::handle
        assertEquals(PaymentSyncResult.Done(sent = 1, needsHelp = 0), run())
        assertEquals(listOf(request.payments[4].id), office.received.map { it.id })
        assertEquals(PaymentState.NEEDS_OFFICE_HELP, row(rejected.id).state)
        assertEquals("R-2610-00045", row(posted.id).receiptNumber)
    }

    @Test
    fun `saved payments go oldest first in batches of 50 and all reach the office once`() {
        val ids = (1..120).map { save(amountPaise = it * 100L) }

        val result = run()

        assertEquals(PaymentSyncResult.Done(sent = 120, needsHelp = 0), result)
        assertEquals(listOf(50, 50, 20), office.batches)
        assertEquals(ids, office.received.map { it.id })
        assertEquals(120, office.postedCount)
        ids.forEach { id ->
            val row = row(id)
            assertEquals(PaymentState.SENT_TO_OFFICE, row.state)
            assertEquals(office.receiptOf(id), row.receiptNumber)
        }
        assertEquals(PushStatus.Finished, sync.status.value)
        // Nothing left: the next run sends nothing.
        assertEquals(PaymentSyncResult.Done(sent = 0, needsHelp = 0), run())
        assertEquals(3, batchRequests().size)
    }

    @Test
    fun `the answer is lost after the office saved the batch - the retry gets duplicates, nothing counted twice`() {
        val ids = (1..3).map { save() }
        office.dropAnswers = 1

        val first = run()

        assertTrue(first.toString(), first is PaymentSyncResult.RetryLater && first.failure is ApiFailure.Offline)
        assertEquals(PushStatus.NoInternet, sync.status.value)
        assertEquals(3, office.postedCount) // the office already has them …
        ids.forEach { id ->
            assertEquals(PaymentState.SAVED_ON_PHONE, row(id).state) // … the phone does not know yet
            assertEquals("offline", row(id).lastErrorCode)
        }

        val second = run()

        assertEquals(PaymentSyncResult.Done(sent = 3, needsHelp = 0), second)
        assertEquals(3, office.postedCount)
        assertEquals(6, office.received.size)
        assertEquals(ids + ids, office.received.map { it.id })
        // The retry resent exactly the same items (same ids, same data), so the office answered "duplicate".
        assertEquals(office.received.take(3), office.received.drop(3))
        ids.forEach { id ->
            val row = row(id)
            assertEquals(PaymentState.SENT_TO_OFFICE, row.state)
            assertEquals(office.receiptOf(id), row.receiptNumber)
            assertEquals(2, row.attemptCount)
        }
    }

    @Test
    fun `server errors keep everything on the phone and ask for a retry`() {
        val id = save()
        for (fixture in listOf("error.INTERNAL.json", "error.RATE_LIMITED.json")) {
            batchAnswer = { Fixtures.response(fixture) }
            val result = run()
            assertTrue(result.toString(), result is PaymentSyncResult.RetryLater && result.failure is ApiFailure.Server)
        }
        // A 200 that is not the contract (a captive portal page, a proxy): also retried, never trusted.
        batchAnswer = {
            MockResponse
                .Builder()
                .code(200)
                .body("<html>Login to Wi-Fi</html>")
                .build()
        }
        val garbled = run()
        assertTrue(
            garbled.toString(),
            garbled is PaymentSyncResult.RetryLater && garbled.failure is ApiFailure.Malformed,
        )

        val row = row(id)
        assertEquals(PaymentState.SAVED_ON_PHONE, row.state)
        assertEquals(3, row.attemptCount)
        assertEquals("malformed", row.lastErrorCode)
        assertEquals(0, office.postedCount)

        batchAnswer = office::handle
        assertEquals(PaymentSyncResult.Done(sent = 1, needsHelp = 0), run())
    }

    @Test
    fun `partial outcomes - posted, needs review, rejected and retry later in one batch`() {
        val posted = save()
        val review = save()
        val rejected = save()
        val later = save()
        office.forced[review] = PaymentOutcome.POSTED_NEEDS_REVIEW
        office.forced[rejected] = PaymentOutcome.REJECTED
        office.forced[later] = PaymentOutcome.RETRY_LATER

        assertEquals(PaymentSyncResult.RetryLater(sent = 2, failure = null), run())

        assertEquals(PaymentState.SENT_TO_OFFICE, row(posted).state)
        assertEquals(PaymentState.SENT_TO_OFFICE, row(review).state)
        assertEquals("collector_mismatch", row(review).reviewReason)
        assertEquals(PaymentState.NEEDS_OFFICE_HELP, row(rejected).state)
        assertEquals("CUSTOMER_NOT_FOUND", row(rejected).lastErrorCode)
        assertEquals(PaymentState.SAVED_ON_PHONE, row(later).state)

        // The office is fine again: only the one left is sent; the refused one is never retried.
        office.forced.clear()
        assertEquals(PaymentSyncResult.Done(sent = 1, needsHelp = 0), run())
        assertEquals(listOf(later), office.received.drop(4).map { it.id })
        assertEquals(PaymentState.NEEDS_OFFICE_HELP, row(rejected).state)
    }

    @Test
    fun `a result without its payment or a missing result keeps the payment on the phone`() {
        val first = save()
        val second = save()
        batchAnswer = { request ->
            val sent = json.decodeFromString(PaymentBatchRequest.serializer(), request.bodyText)
            val result =
                """{"id":"${sent.payments[0].id}","outcome":"posted","payment":null,""" +
                    """"review_reason":null,"error":null}"""
            val body = """{"server_time":"2026-10-13T11:30:00.000Z","results":[$result]}"""
            MockResponse
                .Builder()
                .code(200)
                .setHeader("Content-Type", "application/json")
                .body(body)
                .build()
        }

        val result = run()

        assertTrue(result.toString(), result is PaymentSyncResult.RetryLater && result.failure is ApiFailure.Malformed)
        assertEquals(PaymentState.SAVED_ON_PHONE, row(first).state)
        assertEquals(PaymentSync.MALFORMED, row(first).lastErrorCode)
        assertEquals(PaymentState.SAVED_ON_PHONE, row(second).state)
        assertEquals(PaymentSync.NO_RESULT, row(second).lastErrorCode)
    }

    @Test
    fun `APP_TOO_OLD and a refused session stop the push and keep every payment`() {
        val id = save()
        batchAnswer = { Fixtures.response("error.APP_TOO_OLD.json") }
        assertEquals(PaymentSyncResult.Stopped(sent = 0, failure = ApiFailure.AppTooOld), run())
        assertEquals(PaymentState.SAVED_ON_PHONE, row(id).state)
        assertEquals("app_too_old", row(id).lastErrorCode)

        // The access token expired and the refresh is refused (phone signed out by the owner).
        batchAnswer = { Fixtures.response("error.UNAUTHENTICATED.json") }
        refreshAnswer = { Fixtures.response("error.DEVICE_REVOKED.json") }
        val signedOut = run()
        assertTrue(
            signedOut.toString(),
            signedOut is PaymentSyncResult.Stopped && signedOut.failure is ApiFailure.SignedOut,
        )
        assertEquals(PaymentState.SAVED_ON_PHONE, row(id).state)

        // Nobody signed in now: nothing is sent at all.
        val before = batchRequests().size
        assertEquals(PaymentSyncResult.NotSignedIn, run())
        assertEquals(before, batchRequests().size)
        assertEquals(1, await { dao.countWithRefPrefix("P-") })
    }

    @Test
    fun `another lineman on the same phone - their sign-in never sends the first lineman's payments`() {
        val suresh = (1..2).map { save() }
        await { network.store.end(SignOutReason.SIGNED_OUT) }
        await { network.store.signIn(PaymentFixtures.otherLogin) }
        val mohan = save()

        assertEquals(PaymentSyncResult.Done(sent = 1, needsHelp = 0), run())

        assertEquals(listOf(mohan), office.received.map { it.id })
        assertEquals(PaymentFixtures.otherLogin.user.id, office.received.single().collectorId)
        suresh.forEach { id ->
            assertEquals(PaymentState.SAVED_ON_PHONE, row(id).state)
            assertEquals(0, row(id).attemptCount)
        }

        // Suresh signs in again: his own payments go, normally.
        await { network.store.end(SignOutReason.SIGNED_OUT) }
        await { network.store.signIn(PaymentFixtures.login) }
        assertEquals(PaymentSyncResult.Done(sent = 2, needsHelp = 0), run())
        assertEquals(suresh, office.received.drop(1).map { it.id })
        assertEquals(userId, office.received.last().collectorId)
    }

    @Test
    fun `no internet at all - the payment stays and nothing reaches the office`() {
        val id = save()
        batchAnswer = { MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build() }

        val result = run()

        assertTrue(result.toString(), result is PaymentSyncResult.RetryLater && result.failure is ApiFailure.Offline)
        assertEquals(PaymentState.SAVED_ON_PHONE, row(id).state)
        assertEquals(0, office.postedCount)
    }
}
