package com.cablebilling.lineman.feature.today

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.FakeTime
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.db.inMemoryDatabase
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverStatus
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.di.NetworkModule
import com.cablebilling.lineman.feature.today.TodayFixtures.DATE
import com.cablebilling.lineman.feature.today.TodayFixtures.OTHER_USER
import com.cablebilling.lineman.feature.today.TodayFixtures.payment
import com.cablebilling.lineman.feature.today.TodayFixtures.userId
import kotlinx.coroutines.flow.first
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The Today data and the cash handover against MockWebServer with a fake office that applies T-062's
 * rules ([FakeHandoverOffice]): the day from the contract fixture, a handover saved offline and sent once
 * when the internet is back, a timeout after the office saved it (resent: a duplicate, never a second
 * handover), 409 HANDOVER_ALREADY_ACCEPTED, sent back → handed over again → accepted, a refusal that
 * needs a new handover, and another lineman's handover never sent with this sign-in.
 */
@RunWith(AndroidJUnit4::class)
class TodayRepositoryTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private val db: CableDatabase = inMemoryDatabase()
    private val time = FakeTime()
    private val json = NetworkModule.provideJson()
    private val office = FakeHandoverOffice()
    private val sends = RecordingSendTrigger()
    private lateinit var network: TestNetwork
    private lateinit var repository: TodayRepository

    /** What `/collections/…` answers (default: the fake office; set to an offline answer to cut the network). */
    @Volatile
    private var collectionsAnswer: (RecordedRequest) -> MockResponse = office::handle

    private val routes =
        Routes { request ->
            when {
                request.apiPath.startsWith("/collections/$DATE") -> collectionsAnswer(request)
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.store.signIn(RosterFixtures.login) }
        repository = TodayRepository(db, network.mobileApi, network.errors, network.store, time, json, sends)
        office.payments += FakeHandoverOffice.fixturePayments()
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
        db.close()
    }

    private fun offline() {
        collectionsAnswer =
            { MockResponse.Builder().onResponseStart(mockwebserver3.SocketEffect.CloseSocket()).build() }
    }

    private fun online() {
        collectionsAnswer = office::handle
    }

    private fun day(): DayInputs = await { repository.observeDay(userId, DATE).first() }

    private fun request(
        id: String,
        handed: Long,
        reason: DiscrepancyReason? = null,
        unsyncedCount: Long = 0,
        unsyncedCash: Long = 0,
    ) = HandoverRequest(id, handed, reason, null, unsyncedCount, unsyncedCash)

    private fun posts() = routes.requestsTo("/handover")

    @Test
    fun `the office's day - totals, list, stored for later, and the phone's payments of that day only`() {
        await {
            db.paymentDao().insert(
                payment("01929b11-2c3d-7e4f-9a05-000000000001", 50_000, state = PaymentState.SENT_TO_OFFICE),
            )
            db.paymentDao().insert(payment("p-on-phone", 10_000))
            db.paymentDao().insert(payment("held", 90_000, collectorId = OTHER_USER))
        }
        val result = await { repository.refresh(DATE) } as RefreshResult.Refreshed
        assertEquals(MethodTotals(cashPaise = 70_000, upiPaise = 45_000, count = 3), result.day.totals)

        val inputs = day()
        assertEquals(
            listOf("p-on-phone", "01929b11-2c3d-7e4f-9a05-000000000001").toSet(),
            inputs.payments
                .map {
                    it.id
                }.toSet(),
        )
        val summary = summarizeDay(userId, DATE, inputs.payments, inputs.office)
        assertEquals(MethodTotals(cashPaise = 80_000, upiPaise = 45_000, count = 4), summary.day)

        // A new app run: only the stored totals (no list) — shown apart, the day counted on the phone.
        val later = TodayRepository(db, network.mobileApi, network.errors, network.store, time, json, sends)
        val stored = await { later.observeDay(userId, DATE).first() }.office!!
        assertEquals(MethodTotals(cashPaise = 70_000, upiPaise = 45_000, count = 3), stored.totals)
        assertNull(stored.payments)
        assertEquals(HandoverStatus.OPEN, stored.status)
    }

    @Test
    fun `offline - saved on the phone, sent once when the internet is back, then cleared`() {
        offline()
        val queued =
            await { repository.queueHandover(DATE, request(ID_1, 80_000, DiscrepancyReason.PENDING_SYNC, 1, 10_000)) }
        assertEquals(QueueResult.Queued(isNew = true), queued)
        assertEquals(1, sends.requests)
        assertEquals(QueuedHandoverState.WAITING, day().queued!!.state)
        assertNull(day().office) // nothing from the office yet: no made-up totals

        val first = await { repository.sendQueued() }
        assertTrue(first is HandoverSendResult.RetryLater && first.failure is ApiFailure.Offline)
        assertEquals(1, day().queued!!.attemptCount)
        assertEquals("offline", day().queued!!.lastErrorCode)
        assertTrue(office.received.isEmpty())

        online()
        assertEquals(HandoverSendResult.Done(sent = 1, refused = 0), await { repository.sendQueued() })
        assertEquals(1, office.received.size)
        assertEquals(request(ID_1, 80_000, DiscrepancyReason.PENDING_SYNC, 1, 10_000), office.received.single())
        val after = day()
        assertNull(after.queued)
        assertEquals(HandoverStatus.SUBMITTED, after.office!!.status)
        assertEquals(10_000L, after.office.handover!!.discrepancyPaise)

        // Nothing left: another send sends nothing (the cut attempt + the one that went through).
        assertEquals(HandoverSendResult.Done(0, 0), await { repository.sendQueued() })
        assertEquals(2, posts().size)
        assertEquals(1, office.received.size)
    }

    @Test
    fun `timeout after the office saved it - resent with the same id and body, one handover at the office`() {
        await { repository.queueHandover(DATE, request(ID_1, 70_000)) }
        office.dropAnswers = 1
        val lost = await { repository.sendQueued() }
        assertTrue(lost is HandoverSendResult.RetryLater)
        assertEquals(1, office.submissions.size) // the office has it, the phone does not know
        assertEquals(QueuedHandoverState.WAITING, day().queued!!.state)

        assertEquals(HandoverSendResult.Done(1, 0), await { repository.sendQueued() })
        assertEquals(2, office.received.size)
        assertEquals(office.received[0], office.received[1])
        assertEquals(1, office.submissions.size)
        assertNull(day().queued)
        assertEquals(ID_1, day().office!!.handover!!.submissionId)
    }

    @Test
    fun `429 and 5xx keep it waiting, a double tap saves it once, a lost answer is also cleared by the day`() {
        await { repository.queueHandover(DATE, request(ID_1, 70_000)) }
        assertEquals(QueueResult.Queued(isNew = false), await { repository.queueHandover(DATE, request(ID_1, 70_000)) })
        office.failNext += listOf(FakeHandoverOffice.HTTP_TOO_MANY, 503)
        assertTrue(await { repository.sendQueued() } is HandoverSendResult.RetryLater)
        assertTrue(await { repository.sendQueued() } is HandoverSendResult.RetryLater)
        assertEquals(2, day().queued!!.attemptCount)
        assertEquals("server:INTERNAL", day().queued!!.lastErrorCode)

        // The answer is lost, then the office's day shows the submission: the phone knows it arrived.
        office.dropAnswers = 1
        await { repository.sendQueued() }
        await { repository.refresh(DATE) }
        assertNull(day().queued)
        assertEquals(1, office.submissions.size)
    }

    @Test
    fun `409 already accepted - refused for good, not resent, and the day shows accepted`() {
        office.payments.clear()
        await { repository.queueHandover(DATE, request(ID_1, 0)) }
        await { repository.sendQueued() }
        office.accept()
        // Offline the lineman hands over again (the phone does not know the office accepted).
        offline()
        await { repository.queueHandover(DATE, request(ID_2, 5_000, DiscrepancyReason.EXTRA)) }
        online()
        val result = await { repository.sendQueued() }
        assertEquals(HandoverSendResult.Done(0, 1), result)
        val inputs = day()
        assertEquals(QueuedHandoverState.REFUSED, inputs.queued!!.state)
        assertEquals("server:HANDOVER_ALREADY_ACCEPTED", inputs.queued.lastErrorCode)
        assertEquals(HandoverStatus.ACCEPTED, inputs.office!!.status)
        assertTrue(HandoverView.of(inputs.office, inputs.queued, false) is HandoverView.Accepted)

        // Never resent; and the phone now refuses a new handover itself.
        await { repository.sendQueued() }
        assertEquals(1, office.received.count { it.submissionId == ID_2 })
        assertEquals(
            QueueResult.AlreadyAccepted,
            await {
                repository.queueHandover(DATE, request(ID_3, 5_000, DiscrepancyReason.EXTRA))
            },
        )
    }

    @Test
    fun `sent back with a note, handed over again, then accepted`() {
        await { repository.queueHandover(DATE, request(ID_1, 60_000, DiscrepancyReason.SHORT)) }
        await { repository.sendQueued() }
        office.sendBack("Count again")
        await { repository.refresh(DATE) }
        var inputs = day()
        val back = HandoverView.of(inputs.office, inputs.queued, false)
        assertTrue(back is HandoverView.SentBack)
        assertEquals("Count again", (back as HandoverView.SentBack).handover.reviewNote)
        assertEquals(-10_000L, back.handover.discrepancyPaise)

        await { repository.queueHandover(DATE, request(ID_2, 70_000)) }
        assertEquals(HandoverView.OnPhone(70_000, false), day().let { HandoverView.of(it.office, it.queued, false) })
        await { repository.sendQueued() }
        office.accept()
        await { repository.refresh(DATE) }
        inputs = day()
        val accepted = HandoverView.of(inputs.office, inputs.queued, false) as HandoverView.Accepted
        assertEquals(ID_2, accepted.handover.submissionId)
        assertEquals(0L, accepted.handover.discrepancyPaise)
        assertEquals(2, office.submissions.size)
    }

    @Test
    fun `the office's total differs (VALIDATION) - refused, not resent, hand over again`() {
        // The phone thought ₹700 was all; the office has ₹800 (a payment from another phone).
        office.payments += TodayFixtures.officePayment("other-phone", 10_000)
        await { repository.queueHandover(DATE, request(ID_1, 70_000)) }
        assertEquals(HandoverSendResult.Done(0, 1), await { repository.sendQueued() })
        assertEquals("server:VALIDATION", day().queued!!.lastErrorCode)
        await { repository.sendQueued() }
        assertEquals(1, posts().size)
        assertTrue(day().let { HandoverView.of(it.office, it.queued, false) } is HandoverView.Refused)

        await { repository.queueHandover(DATE, request(ID_2, 80_000)) }
        assertEquals(HandoverSendResult.Done(1, 0), await { repository.sendQueued() })
        assertNull(day().queued)
    }

    @Test
    fun `another lineman's saved handover is never sent with this sign-in`() {
        await { repository.queueHandover(DATE, request(ID_1, 70_000)) }
        await {
            network.store.signIn(
                RosterFixtures.login.copy(user = RosterFixtures.login.user.copy(id = OTHER_USER)),
            )
        }
        assertEquals(HandoverSendResult.Done(0, 0), await { repository.sendQueued() })
        assertTrue(office.received.isEmpty())
        // Still there for its lineman.
        assertEquals(ID_1, await { repository.observeDay(userId, DATE).first() }.queued!!.submissionId)
    }

    @Test
    fun `the contract's own handover example is answered and stored as the office said`() {
        val example = Fixtures.decode(HandoverRequest.serializer(), "submitHandover.request.json")
        collectionsAnswer = { request ->
            if (request.method == "POST") Fixtures.response("submitHandover.response.json") else office.handle(request)
        }
        await { repository.queueHandover(DATE, example) }
        assertEquals(HandoverSendResult.Done(1, 0), await { repository.sendQueued() })
        val handover = day().office!!.handover!!
        assertEquals(70_000L, handover.cashExpectedPaise)
        assertEquals(10_000L, handover.discrepancyPaise)
        assertEquals(DiscrepancyReason.PENDING_SYNC, handover.discrepancyReason)
        assertEquals(PaymentMethod.UPI, day().office!!.payments!![1].method)
    }

    @Test
    fun `a slow day check and a handover - the newer answer is the one kept`() {
        await { repository.queueHandover(DATE, request(ID_1, 70_000)) }
        // A day check starts first; the office reads the day (no handover yet), then its answer is slow.
        val read = CountDownLatch(1)
        val release = CountDownLatch(1)
        collectionsAnswer = { recorded ->
            if (recorded.method == "GET") {
                val stale = office.handle(recorded)
                read.countDown()
                release.await(WAIT_SECONDS, TimeUnit.SECONDS)
                stale
            } else {
                office.handle(recorded)
            }
        }
        val threads = Executors.newFixedThreadPool(2)
        val pending = threads.submit<RefreshResult> { await { repository.refresh(DATE) } }
        assertTrue(read.await(WAIT_SECONDS, TimeUnit.SECONDS))
        // Meanwhile the lineman's handover is sent: it waits for the slow answer, then goes through.
        val send = threads.submit<HandoverSendResult> { await { repository.sendQueued() } }
        release.countDown()
        pending.get(WAIT_SECONDS, TimeUnit.SECONDS)
        assertEquals(HandoverSendResult.Done(1, 0), send.get(WAIT_SECONDS, TimeUnit.SECONDS))
        threads.shutdown()

        val inputs = day()
        assertEquals(HandoverStatus.SUBMITTED, inputs.office!!.status)
        assertEquals(ID_1, inputs.office.handover!!.submissionId)
        assertNull(inputs.queued)
        val stored = await { db.collectionDayDao().get(userId, DATE) }!!
        assertEquals(HandoverStatus.SUBMITTED.wire, stored.status)
    }

    private class RecordingSendTrigger : HandoverSendTrigger {
        @Volatile
        var requests = 0

        override fun requestSend() {
            requests++
        }
    }

    private companion object {
        const val ID_1 = "0192ab00-0000-7000-8000-000000000001"
        const val ID_2 = "0192ab00-0000-7000-8000-000000000002"
        const val ID_3 = "0192ab00-0000-7000-8000-000000000003"
        const val WAIT_SECONDS = 10L
    }
}
