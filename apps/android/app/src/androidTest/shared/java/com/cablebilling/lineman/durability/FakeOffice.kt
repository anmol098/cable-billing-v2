package com.cablebilling.lineman.durability

import com.cablebilling.lineman.data.network.generated.Allocation
import com.cablebilling.lineman.data.network.generated.BillKind
import com.cablebilling.lineman.data.network.generated.ItemError
import com.cablebilling.lineman.data.network.generated.PaymentBatchItem
import com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
import com.cablebilling.lineman.data.network.generated.PaymentBatchResponse
import com.cablebilling.lineman.data.network.generated.PaymentBatchResult
import com.cablebilling.lineman.data.network.generated.PaymentOutcome
import com.cablebilling.lineman.data.network.generated.PostedPayment
import com.cablebilling.lineman.di.NetworkModule
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import java.util.Collections

/**
 * The office as the phone sees it through `POST /payments:batch`, with the server's rules (T-046 /
 * T-061): idempotent on the payment id (same id and data → `duplicate` with the first answer; same id,
 * other data → `rejected` ID_REUSED_WITH_DIFFERENT_DATA), one receipt number per payment, results in
 * request order. Faults:
 * - [airplaneMode]: no request reaches the office (the connection is cut before it is read), like a
 *   phone in airplane mode or on Wi-Fi without internet;
 * - [loseAnswers]: the office saves each batch, then the answer is lost (timeout, tower handover);
 * - [failNext]: answer HTTP 503 without saving anything.
 *
 * Every other path answers 404 NOT_FOUND (the roster pull and app config are not part of this suite).
 */
class FakeOffice : Dispatcher() {
    private val json = NetworkModule.provideJson()
    private val stored = Collections.synchronizedMap(LinkedHashMap<String, Pair<PaymentBatchItem, PostedPayment>>())

    @Volatile
    var airplaneMode = false

    @Volatile
    var failNext = 0

    /** Requests that never reached the office because of [airplaneMode]. */
    @Volatile
    var unreachable = 0
        private set

    /** Size of every batch the office read, in order (including repeats and dropped answers). */
    val batches: MutableList<Int> = Collections.synchronizedList(mutableListOf())

    /** Every item the office read, in order, including repeats. */
    val received: MutableList<PaymentBatchItem> = Collections.synchronizedList(mutableListOf())

    /** Payments the office saved, each once (the money the office counts). */
    fun posted(): List<PaymentBatchItem> = synchronized(stored) { stored.values.map { it.first } }

    fun receiptOf(id: String): String? = stored[id]?.second?.receiptNumber

    /** Items answered ID_REUSED_WITH_DIFFERENT_DATA. Must stay 0: the phone never changes a payment it sent. */
    @Volatile
    var reusedIds = 0
        private set

    /**
     * Logins of linemen the office switched off. Their access token is refused (401) and the refresh
     * answers 403 ACCOUNT_DISABLED, as the server does after T-032 revokes a deactivated lineman's tokens.
     */
    val disabledLogins: MutableSet<String> = Collections.synchronizedSet(mutableSetOf())

    /**
     * From this batch on (1-based, counting every batch read) the office saves each batch and the answer
     * is lost. Lasts until [answerAgain]: OkHttp itself may resend a request whose connection broke
     * (once, on a reused connection), and that answer must be lost too for the phone to see a failure.
     */
    @Volatile
    var loseAnswersFromBatch = NEVER

    /** Every answer from now on is lost after the office saved the batch (see [loseAnswersFromBatch]). */
    fun loseAnswers() {
        loseAnswersFromBatch = batches.size + 1
    }

    fun answerAgain() {
        loseAnswersFromBatch = NEVER
    }

    override fun dispatch(request: RecordedRequest): MockResponse {
        if (airplaneMode) {
            unreachable++
            return cut()
        }
        val path = request.url.encodedPath.removePrefix(API_PREFIX)
        return when {
            path == "/auth/refresh" && disabledLogins.any { "refresh-$it" in request.body?.utf8().orEmpty() } -> {
                error(HTTP_FORBIDDEN, "ACCOUNT_DISABLED")
            }

            path != "/payments:batch" -> {
                error(HTTP_NOT_FOUND, "NOT_FOUND")
            }

            disabledLogins.any { request.headers["Authorization"] == "Bearer access-$it" } -> {
                error(HTTP_UNAUTHORIZED, "UNAUTHENTICATED")
            }

            failNext > 0 -> {
                failNext--
                error(HTTP_UNAVAILABLE, "INTERNAL")
            }

            else -> {
                postBatch(request)
            }
        }
    }

    private fun postBatch(request: RecordedRequest): MockResponse {
        val batch = json.decodeFromString(PaymentBatchRequest.serializer(), request.body?.utf8().orEmpty())
        batches += batch.payments.size
        received += batch.payments
        val results = batch.payments.map(::answer)
        if (batches.size >= loseAnswersFromBatch) return cut()
        return ok(json.encodeToString(PaymentBatchResponse.serializer(), PaymentBatchResponse(SERVER_TIME, results)))
    }

    private fun answer(item: PaymentBatchItem): PaymentBatchResult {
        val earlier = stored[item.id]
        return when {
            earlier == null -> {
                post(item)
            }

            earlier.first == item -> {
                PaymentBatchResult(item.id, PaymentOutcome.DUPLICATE, payment = earlier.second)
            }

            else -> {
                reusedIds++
                PaymentBatchResult(
                    item.id,
                    PaymentOutcome.REJECTED,
                    error = ItemError("ID_REUSED_WITH_DIFFERENT_DATA", "different data"),
                )
            }
        }
    }

    private fun post(item: PaymentBatchItem): PaymentBatchResult =
        synchronized(stored) {
            val posted =
                PostedPayment(
                    id = item.id,
                    customerId = item.customerId,
                    amountPaise = item.amountPaise,
                    method = item.method,
                    receiptNumber = "R-2610-%05d".format(stored.size + 1),
                    provisionalRef = item.provisionalRef,
                    recordedAt = item.recordedAt,
                    postedAt = SERVER_TIME,
                    businessDate = DurabilityFixtures.DAY,
                    allocations =
                        listOf(
                            Allocation(
                                invoiceId = "01929a3e-5b10-7c4e-8a04-000000000001",
                                invoiceNumber = "INV-2609-00098",
                                kind = BillKind.REGULAR,
                                period = "2026-09-01",
                                amountPaise = item.amountPaise,
                                outstandingAfterPaise = 0,
                            ),
                        ),
                    creditAddedPaise = 0,
                    balanceAfterPaise = 0,
                    creditAfterPaise = 0,
                )
            stored[item.id] = item to posted
            PaymentBatchResult(item.id, PaymentOutcome.POSTED, payment = posted)
        }

    private fun cut(): MockResponse = MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()

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
        const val API_PREFIX = "/api/mobile/v1"

        /** 17:00 India time: the evening the phone gets internet back. */
        const val SERVER_TIME = "2026-10-13T11:30:00.000Z"
        private const val NEVER = Int.MAX_VALUE
        private const val HTTP_OK = 200
        private const val HTTP_UNAUTHORIZED = 401
        private const val HTTP_FORBIDDEN = 403
        private const val HTTP_NOT_FOUND = 404
        private const val HTTP_UNAVAILABLE = 503
    }
}
