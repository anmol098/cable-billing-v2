package com.cablebilling.lineman.data.payments

import com.cablebilling.lineman.data.db.RosterFixtures
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.Allocation
import com.cablebilling.lineman.data.network.generated.BillKind
import com.cablebilling.lineman.data.network.generated.ItemError
import com.cablebilling.lineman.data.network.generated.LoginResponse
import com.cablebilling.lineman.data.network.generated.PaymentBatchItem
import com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
import com.cablebilling.lineman.data.network.generated.PaymentBatchResponse
import com.cablebilling.lineman.data.network.generated.PaymentBatchResult
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.network.generated.PaymentOutcome
import com.cablebilling.lineman.data.network.generated.PostedPayment
import com.cablebilling.lineman.data.network.generated.ReviewReason
import com.cablebilling.lineman.data.network.generated.UserInfo
import com.cablebilling.lineman.di.NetworkModule
import mockwebserver3.MockResponse
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import java.util.Collections

/**
 * A stand-in for the server's `POST /payments:batch` with the real semantics (T-046 / T-061):
 * idempotent on the payment id (same id + same data → `duplicate` with the stored result; same id +
 * different data → `rejected` ID_REUSED_WITH_DIFFERENT_DATA), one receipt number per posted payment,
 * results in request order. Faults are injected per test: drop the answer after the server committed
 * ([dropAnswers]), or force an outcome for one payment ([forced]).
 */
class FakePaymentServer {
    private val json = NetworkModule.provideJson()
    private val stored = Collections.synchronizedMap(LinkedHashMap<String, Pair<PaymentBatchItem, PostedPayment>>())

    /** Number of items per batch request received, in order. */
    val batches: MutableList<Int> = Collections.synchronizedList(mutableListOf())

    /** Every item received (incl. repeats). */
    val received: MutableList<PaymentBatchItem> = Collections.synchronizedList(mutableListOf())

    /** Outcome to give a payment id instead of posting it (`rejected`, `retry_later`, `posted_needs_review`). */
    val forced: MutableMap<String, PaymentOutcome> = Collections.synchronizedMap(mutableMapOf())

    /** Answer the next N batch requests by committing them and then cutting the connection (a timeout). */
    @Volatile
    var dropAnswers = 0

    @Volatile
    private var nextReceipt = 45

    /** Payments the server saved (each counted once, however often it was sent). */
    val postedCount: Int get() = stored.size

    fun postedIds(): Set<String> = synchronized(stored) { stored.keys.toSet() }

    fun receiptOf(id: String): String? = stored[id]?.second?.receiptNumber

    fun handle(request: RecordedRequest): MockResponse {
        val batch = json.decodeFromString(PaymentBatchRequest.serializer(), request.bodyText)
        batches += batch.payments.size
        received += batch.payments
        val results = batch.payments.map(::answer)
        if (dropAnswers > 0) {
            dropAnswers--
            return MockResponse.Builder().onResponseStart(SocketEffect.CloseSocket()).build()
        }
        val body = json.encodeToString(PaymentBatchResponse.serializer(), PaymentBatchResponse(SERVER_TIME, results))
        return MockResponse
            .Builder()
            .code(HTTP_OK)
            .setHeader("Content-Type", "application/json")
            .body(body)
            .build()
    }

    private fun answer(item: PaymentBatchItem): PaymentBatchResult {
        stored[item.id]?.let { (first, posted) ->
            return if (first.copy(collectorId = item.collectorId, deviceId = item.deviceId) == item) {
                PaymentBatchResult(id = item.id, outcome = PaymentOutcome.DUPLICATE, payment = posted)
            } else {
                rejected(item.id, "ID_REUSED_WITH_DIFFERENT_DATA")
            }
        }
        return when (forced[item.id]) {
            PaymentOutcome.REJECTED -> {
                rejected(item.id, "CUSTOMER_NOT_FOUND")
            }

            PaymentOutcome.RETRY_LATER -> {
                PaymentBatchResult(
                    item.id,
                    PaymentOutcome.RETRY_LATER,
                    error = ItemError("INTERNAL", "busy"),
                )
            }

            PaymentOutcome.POSTED_NEEDS_REVIEW -> {
                post(
                    item,
                    PaymentOutcome.POSTED_NEEDS_REVIEW,
                    ReviewReason.COLLECTOR_MISMATCH,
                )
            }

            else -> {
                post(item, PaymentOutcome.POSTED, null)
            }
        }
    }

    private fun post(
        item: PaymentBatchItem,
        outcome: PaymentOutcome,
        review: ReviewReason?,
    ): PaymentBatchResult {
        val posted =
            PostedPayment(
                id = item.id,
                customerId = item.customerId,
                amountPaise = item.amountPaise,
                method = item.method,
                receiptNumber = "R-2610-%05d".format(nextReceipt++),
                provisionalRef = item.provisionalRef,
                recordedAt = item.recordedAt,
                postedAt = POSTED_AT,
                businessDate = "2026-10-13",
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
        return PaymentBatchResult(id = item.id, outcome = outcome, payment = posted, reviewReason = review)
    }

    private fun rejected(
        id: String,
        code: String,
    ) = PaymentBatchResult(id = id, outcome = PaymentOutcome.REJECTED, error = ItemError(code, "refused"))

    companion object {
        const val SERVER_TIME = "2026-10-13T11:30:00.000Z"
        const val POSTED_AT = "2026-10-13T11:29:58.000Z"
        private const val HTTP_OK = 200
    }
}

/** Drafts and sign-ins for payment tests. */
object PaymentFixtures {
    /** The fixture lineman (Suresh, device K7Q). */
    val login: LoginResponse get() = RosterFixtures.login

    /** Another lineman of the same operator, signing in on the same phone (PLAN §9.2). */
    val otherLogin: LoginResponse
        get() =
            login.copy(
                user = UserInfo("01929a3e-5b10-7c4e-8a01-000000000009", "Mohan Lal", "9876509999", login.user.language),
            )

    private var counter = 0L

    /** A draft for Ramesh (or [customerId]) with a fresh UUIDv7. */
    fun draft(
        amountPaise: Long = 50_000,
        method: PaymentMethod = PaymentMethod.CASH,
        upiReference: String? = null,
        customerId: String = RosterFixtures.ramesh.id,
        id: String = UuidV7.generate(BASE_MILLIS + counter++),
    ): PaymentDraft =
        PaymentDraft(
            id = id,
            customerId = customerId,
            customerCode = "1045",
            customerName = "Ramesh Kumar",
            amountPaise = amountPaise,
            method = method,
            upiReference = upiReference,
        )

    private const val BASE_MILLIS = 1_791_000_000_000L
}

/** Records push requests; checks the payment was already committed when the push was asked for. */
class RecordingPushTrigger(
    private val onRequest: () -> Unit = {},
) : PaymentPushTrigger {
    @Volatile
    var requests = 0

    override fun requestPush() {
        requests++
        onRequest()
    }
}
