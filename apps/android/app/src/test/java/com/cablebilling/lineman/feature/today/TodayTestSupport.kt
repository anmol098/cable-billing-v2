package com.cablebilling.lineman.feature.today

import com.cablebilling.lineman.data.auth.Session
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.CollectionDay
import com.cablebilling.lineman.data.network.generated.CollectionDayResponse
import com.cablebilling.lineman.data.network.generated.DayPayment
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.data.network.generated.Handover
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverResponse
import com.cablebilling.lineman.data.network.generated.HandoverStatus
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.payments.PaymentRules
import com.cablebilling.lineman.di.NetworkModule
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import java.time.Instant
import java.util.Collections

/** The fixture lineman (Suresh) and another lineman of the same operator. */
object TodayFixtures {
    val userId: String get() = RosterFixtures.login.user.id
    const val OTHER_USER = "01929a3e-5b10-7c4e-8a01-000000000009"

    /** `2026-10-13T11:30:00Z` = 17:00 India time on 13 Oct. */
    const val DATE = "2026-10-13"

    val session: Session
        get() = Session(RosterFixtures.login.user, RosterFixtures.login.operator, RosterFixtures.login.device)

    /** A payment on the phone, taken at [recordedAt] (its business date is the India-time day of that). */
    fun payment(
        id: String,
        amountPaise: Long,
        method: PaymentMethod = PaymentMethod.CASH,
        state: PaymentState = PaymentState.SAVED_ON_PHONE,
        recordedAt: Long = Instant.parse("2026-10-13T05:00:00Z").toEpochMilli(),
        collectorId: String = userId,
    ): PaymentEntity =
        PaymentEntity(
            id = id,
            customerId = RosterFixtures.ramesh.id,
            customerCode = "1045",
            customerName = "Ramesh Kumar",
            amountPaise = amountPaise,
            method = method,
            upiReference = null,
            notes = null,
            recordedAt = recordedAt,
            businessDate = PaymentRules.businessDate(recordedAt),
            provisionalRef = "P-K7Q-%04d".format(id.hashCode().mod(MAX_REF)),
            collectorId = collectorId,
            deviceId = RosterFixtures.login.device.id,
            state = state,
            receiptNumber = if (state == PaymentState.SENT_TO_OFFICE) "R-2610-${id.takeLast(5)}" else null,
        )

    /** A payment as the office lists it for the day. */
    fun officePayment(
        id: String,
        amountPaise: Long,
        method: PaymentMethod = PaymentMethod.CASH,
        reversed: Boolean = false,
    ): DayPayment =
        DayPayment(
            paymentId = id,
            customerId = RosterFixtures.ramesh.id,
            customerCode = "1045",
            customerName = "Ramesh Kumar",
            amountPaise = amountPaise,
            method = method,
            recordedAt = "2026-10-13T05:00:00.000Z",
            postedAt = "2026-10-13T05:00:02.000Z",
            receiptNumber = "R-2610-${id.takeLast(5)}",
            provisionalRef = null,
            reversed = reversed,
        )

    /** The office's day built from its payment list (totals leave out cancelled payments, UPI apart). */
    fun officeDay(
        payments: List<DayPayment>,
        status: HandoverStatus = HandoverStatus.OPEN,
        handover: Handover? = null,
        fresh: Boolean = true,
    ): OfficeDay {
        val counted = payments.filterNot { it.reversed }
        return OfficeDay(
            businessDate = DATE,
            totals =
                MethodTotals(
                    cashPaise = counted.filter { it.method == PaymentMethod.CASH }.sumOf { it.amountPaise },
                    upiPaise = counted.filter { it.method == PaymentMethod.UPI }.sumOf { it.amountPaise },
                    count = counted.size,
                ),
            status = status,
            handover = handover,
            payments = if (fresh) payments else null,
            serverTime = Instant.parse("2026-10-13T11:30:00Z").toEpochMilli(),
        )
    }

    private const val MAX_REF = 10_000
}

/**
 * A stand-in for T-061/T-062's `GET /collections/{date}` and `POST /collections/{date}/handover` with the
 * real rules: expected cash = cash of the office's payments not cancelled (UPI never), discrepancy =
 * handed − expected computed here, a reason required when it is not zero, idempotent on `submission_id`
 * (same body → the current day; another body → 409 ID_REUSED_WITH_DIFFERENT_DATA), a new submission
 * after acceptance → 409 HANDOVER_ALREADY_ACCEPTED. Faults: [dropAnswers] (commit, then cut the
 * connection), [failNext] (answer an HTTP status without doing anything).
 */
class FakeHandoverOffice {
    private val json = NetworkModule.provideJson()

    /** The office's payments for the day (add to simulate a payment push, set reversed to cancel one). */
    val payments: MutableList<DayPayment> = Collections.synchronizedList(mutableListOf())

    /** Every submission the office received and stored (each id once). */
    val submissions: MutableMap<String, HandoverRequest> = Collections.synchronizedMap(LinkedHashMap())

    /** Every POST body received, including repeats. */
    val received: MutableList<HandoverRequest> = Collections.synchronizedList(mutableListOf())

    @Volatile
    var status: HandoverStatus = HandoverStatus.OPEN

    @Volatile
    var handover: Handover? = null

    @Volatile
    var dropAnswers = 0

    /** HTTP statuses to answer the next POSTs with, doing nothing (e.g. 503, 429). */
    val failNext: MutableList<Int> = Collections.synchronizedList(mutableListOf())

    @Volatile
    var gets = 0

    fun handle(request: RecordedRequest): MockResponse =
        if (request.method == "POST") submit(request) else day().also { gets++ }

    /** The office accepts the latest handover (final). */
    fun accept() {
        status = HandoverStatus.ACCEPTED
        handover = handover?.copy(reviewedAt = REVIEWED_AT)
    }

    /** The office sends the latest handover back with [note]. */
    fun sendBack(note: String) {
        status = HandoverStatus.RETURNED
        handover = handover?.copy(reviewedAt = REVIEWED_AT, reviewNote = note)
    }

    private fun cash(): Long =
        payments.filter { !it.reversed && it.method == PaymentMethod.CASH }.sumOf { it.amountPaise }

    private fun collectionDay(): CollectionDay {
        val counted = payments.filterNot { it.reversed }
        return CollectionDay(
            businessDate = TodayFixtures.DATE,
            cashTotalPaise = cash(),
            upiTotalPaise = counted.filter { it.method == PaymentMethod.UPI }.sumOf { it.amountPaise },
            paymentCount = counted.size.toLong(),
            status = status,
            handover = handover,
            payments = payments.toList(),
        )
    }

    private fun day(): MockResponse =
        ok(json.encodeToString(CollectionDayResponse.serializer(), CollectionDayResponse(SERVER_TIME, collectionDay())))

    private fun submit(recorded: RecordedRequest): MockResponse {
        val failure = failNext.removeFirstOrNull()
        val answer =
            if (failure != null) {
                error(failure, if (failure == HTTP_TOO_MANY) "RATE_LIMITED" else "INTERNAL")
            } else {
                val request = json.decodeFromString(HandoverRequest.serializer(), recorded.bodyText)
                received += request
                decide(request)
            }
        val drop = failure == null && answer.code == HTTP_OK && dropAnswers > 0
        if (drop) dropAnswers--
        return if (drop) MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build() else answer
    }

    /** T-062's rules for one submission (stores it when it is new and valid). */
    private fun decide(request: HandoverRequest): MockResponse {
        val earlier = submissions[request.submissionId]
        val discrepancy = request.cashHandedOverPaise - cash()
        return when {
            earlier != null && earlier != request -> {
                error(HTTP_CONFLICT, "ID_REUSED_WITH_DIFFERENT_DATA")
            }

            earlier != null -> {
                day()
            }

            status == HandoverStatus.ACCEPTED -> {
                error(HTTP_CONFLICT, "HANDOVER_ALREADY_ACCEPTED")
            }

            discrepancy != 0L && request.discrepancyReason == null -> {
                error(HTTP_BAD_REQUEST, "VALIDATION")
            }

            else -> {
                store(request, discrepancy)
                ok(json.encodeToString(HandoverResponse.serializer(), HandoverResponse(SERVER_TIME, collectionDay())))
            }
        }
    }

    private fun store(
        request: HandoverRequest,
        discrepancy: Long,
    ) {
        submissions[request.submissionId] = request
        status = HandoverStatus.SUBMITTED
        handover =
            Handover(
                submissionId = request.submissionId,
                cashExpectedPaise = cash(),
                cashHandedOverPaise = request.cashHandedOverPaise,
                discrepancyPaise = discrepancy,
                discrepancyReason = request.discrepancyReason.takeIf { discrepancy != 0L },
                note = request.note,
                unsyncedPaymentCount = request.unsyncedPaymentCount,
                unsyncedCashPaise = request.unsyncedCashPaise,
                submittedAt = SERVER_TIME,
                reviewedAt = null,
                reviewNote = null,
            )
    }

    private fun ok(body: String): MockResponse =
        MockResponse
            .Builder()
            .code(HTTP_OK)
            .setHeader("Content-Type", "application/json")
            .body(body)
            .build()

    private fun error(
        status: Int,
        code: String,
    ): MockResponse =
        MockResponse
            .Builder()
            .code(status)
            .setHeader("Content-Type", "application/json")
            .body("""{"server_time":"$SERVER_TIME","error":{"code":"$code","message":"test","request_id":"req_1"}}""")
            .build()

    companion object {
        const val SERVER_TIME = "2026-10-13T11:30:00.000Z"
        const val REVIEWED_AT = "2026-10-13T12:40:00.000Z"
        private const val HTTP_OK = 200
        private const val HTTP_BAD_REQUEST = 400
        private const val HTTP_CONFLICT = 409
        const val HTTP_TOO_MANY = 429

        /** The day of `getCollectionDay.response.json`: ₹500 + ₹200 cash, ₹450 UPI. */
        fun fixturePayments(): List<DayPayment> =
            Fixtures
                .decode(CollectionDayResponse.serializer(), "getCollectionDay.response.json")
                .session.payments
    }
}

/** [TodayData] for ViewModel tests: flows the test sets, and a record of what was asked. */
class FakeTodayData(
    var now: Long = Instant.parse("2026-10-13T11:30:00Z").toEpochMilli(),
) : TodayData {
    val sessionState = MutableStateFlow<SessionState>(SessionState.SignedIn(TodayFixtures.session))
    val payments = MutableStateFlow<List<PaymentEntity>>(emptyList())
    val office = MutableStateFlow<OfficeDay?>(null)
    val queued = MutableStateFlow<QueuedHandover?>(null)
    val sending = MutableStateFlow(false)
    var refreshResult: RefreshResult =
        RefreshResult.Failed(
            com.cablebilling.lineman.data.network.ApiFailure
                .Offline(java.io.IOException("offline")),
        )
    var queueResult: QueueResult = QueueResult.Queued(isNew = true)
    val refreshes: MutableList<String> = mutableListOf()
    val queuedRequests: MutableList<Pair<String, HandoverRequest>> = mutableListOf()
    val daysAsked: MutableList<Pair<String, String>> = mutableListOf()
    var sends = 0
    private var ids = 0

    override fun session(): Flow<SessionState> = sessionState

    override fun day(
        collectorId: String,
        businessDate: String,
    ): Flow<DayInputs> {
        daysAsked += collectorId to businessDate
        return kotlinx.coroutines.flow.combine(payments, office, queued, sending) { p, o, q, s ->
            // Everything on the phone, unfiltered: the Today summary must leave out other linemen and days itself.
            DayInputs(p, o, q, s)
        }
    }

    override suspend fun refresh(businessDate: String): RefreshResult {
        refreshes += businessDate
        return refreshResult
    }

    override suspend fun queueHandover(
        businessDate: String,
        request: HandoverRequest,
    ): QueueResult {
        queuedRequests += businessDate to request
        return queueResult
    }

    override fun sendNow() {
        sends++
    }

    override fun newSubmissionId(): String = "0192ab00-0000-7000-8000-%012d".format(++ids)

    override fun nowMillis(): Long = now
}

/** The reasons a test can expect, by sign. */
val SHORT_REASONS = listOf(DiscrepancyReason.SHORT, DiscrepancyReason.PENDING_SYNC, DiscrepancyReason.OTHER)
