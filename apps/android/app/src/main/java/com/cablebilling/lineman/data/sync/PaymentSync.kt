package com.cablebilling.lineman.data.sync

import androidx.room.withTransaction
import com.cablebilling.lineman.data.auth.Session
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.TimeSource
import com.cablebilling.lineman.data.network.ApiErrorParser
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.MobileApi
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.generated.PaymentBatchItem
import com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
import com.cablebilling.lineman.data.network.generated.PaymentBatchResult
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.data.network.generated.PaymentOutcome
import com.cablebilling.lineman.data.network.generated.PostedPayment
import com.cablebilling.lineman.data.payments.PaymentReceipts
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

/** How one push of the payment queue ended. [sent] payments reached the office in this run. */
sealed interface PaymentSyncResult {
    val sent: Int

    /** Nothing of the signed-in lineman is left on the phone ([needsHelp] were refused by the office). */
    data class Done(
        override val sent: Int,
        val needsHelp: Int,
    ) : PaymentSyncResult

    /**
     * Some payments are still on the phone for a reason that passes by itself: no internet, a timeout,
     * a temporary server problem (429/5xx, `retry_later`), or an answer that could not be read. Try
     * again with backoff.
     */
    data class RetryLater(
        override val sent: Int,
        /** Why the batch failed, or null when the server answered but kept some items for later. */
        val failure: ApiFailure?,
    ) : PaymentSyncResult

    /**
     * Retrying now cannot help: signed out, app too old, or the whole batch refused (403 …). The
     * payments stay on the phone and go with the next trigger (sign-in, update, app open, a new save).
     */
    data class Stopped(
        override val sent: Int,
        val failure: ApiFailure,
    ) : PaymentSyncResult

    /** Nobody is signed in: nothing is sent (the queue waits for its lineman). */
    data object NotSignedIn : PaymentSyncResult {
        override val sent: Int = 0
    }
}

/** What the Waiting screen shows about the push. */
sealed interface PushStatus {
    data object Idle : PushStatus

    /** Sending to the office now. */
    data object Running : PushStatus

    /** The last push finished: everything of this lineman reached the office (or was refused). */
    data object Finished : PushStatus

    /** The last push could not reach the office (no internet or a timeout). */
    data object NoInternet : PushStatus

    /** The last push failed for another reason; it is tried again by itself. */
    data object Failed : PushStatus
}

/**
 * Pushes the payment queue to the office (`POST /payments:batch`, PLAN §10.4, FR-015):
 *
 * - Only the **signed-in lineman's own** payments, oldest first, in batches of [BATCH_SIZE] (the
 *   contract's maximum). Another lineman's payments on a shared phone stay held (PLAN §9.2).
 * - Each item keeps its UUIDv7 id, so sending a batch again after a timeout (the server may already
 *   have posted it) gives `duplicate` outcomes with the stored result, never a second payment.
 * - Outcomes → states: `posted`, `duplicate`, `posted_needs_review` → SENT_TO_OFFICE with the
 *   permanent receipt number linked to the provisional reference (and the review reason kept);
 *   `rejected` → NEEDS_OFFICE_HELP (never retried automatically); `retry_later`, a missing result, or
 *   any failed call → stays SAVED_ON_PHONE.
 * - A row only moves forward from SAVED_ON_PHONE; nothing is ever deleted (BR-11).
 *
 * One run at a time (the worker and "Try now" share it). Tests call [run] directly.
 */
@Singleton
class PaymentSync
    @Inject
    constructor(
        private val db: CableDatabase,
        private val api: MobileApi,
        private val errors: ApiErrorParser,
        private val sessions: SessionStore,
        private val time: TimeSource,
        private val json: Json,
    ) {
        private val mutex = Mutex()
        private val mutableStatus = MutableStateFlow<PushStatus>(PushStatus.Idle)
        private val dao get() = db.paymentDao()

        /** The push as the Waiting screen shows it (this process only). */
        val status: StateFlow<PushStatus> = mutableStatus.asStateFlow()

        suspend fun run(): PaymentSyncResult =
            mutex.withLock {
                mutableStatus.value = PushStatus.Running
                var status: PushStatus = PushStatus.Failed
                try {
                    pushAll().also { status = it.status }
                } finally {
                    mutableStatus.value = status
                }
            }

        private suspend fun pushAll(): PaymentSyncResult {
            val session = (sessions.load() as? SessionState.SignedIn)?.session ?: return PaymentSyncResult.NotSignedIn
            val progress = Progress()
            var outcome: PaymentSyncResult? = null
            var batches = 0
            while (outcome == null) {
                outcome =
                    when {
                        // A very long queue: the next run continues (the worker retries soon, with backoff).
                        batches++ == MAX_BATCHES_PER_RUN -> PaymentSyncResult.RetryLater(progress.sent, null)

                        // Another lineman signed in meanwhile: stop before anything is sent under their sign-in.
                        sessions.session?.user?.id != session.user.id -> PaymentSyncResult.NotSignedIn

                        else -> pushBatch(session, progress)
                    }
            }
            return outcome
        }

        /** What this run has done so far. */
        private class Progress(
            var sent: Int = 0,
            var needsHelp: Int = 0,
        )

        /** Sends the oldest batch; returns how the run ends, or null to go on with the next batch. */
        private suspend fun pushBatch(
            session: Session,
            progress: Progress,
        ): PaymentSyncResult? {
            val batch = dao.oldestSavedOnPhoneFor(session.user.id, BATCH_SIZE)
            if (batch.isEmpty()) return PaymentSyncResult.Done(progress.sent, progress.needsHelp)
            markAttempt(batch)
            val request = PaymentBatchRequest(batch.map { it.toBatchItem() })
            return when (val response = apiCall(errors) { api.postPaymentBatch(request) }) {
                is ApiResult.Success -> {
                    val applied = apply(batch, response.value.results, session)
                    progress.sent += applied.sent
                    progress.needsHelp += applied.needsHelp
                    if (applied.leftOnPhone > 0) PaymentSyncResult.RetryLater(progress.sent, applied.failure) else null
                }

                is ApiResult.Failure -> {
                    val failure = response.failure
                    recordFailure(batch, failure)
                    if (failure.isRetryable || failure is ApiFailure.Malformed) {
                        PaymentSyncResult.RetryLater(progress.sent, failure)
                    } else {
                        PaymentSyncResult.Stopped(progress.sent, failure)
                    }
                }
            }
        }

        private class Applied(
            val sent: Int,
            val needsHelp: Int,
            val leftOnPhone: Int,
            val failure: ApiFailure?,
        )

        /** Stores the per-item outcomes in one transaction. */
        private suspend fun apply(
            batch: List<PaymentEntity>,
            results: List<PaymentBatchResult>,
            session: Session,
        ): Applied =
            db.withTransaction {
                val byId = results.associateBy { it.id.lowercase() }
                val now = time.nowMillis()
                val updated =
                    batch
                        .mapNotNull { sentItem -> dao.get(sentItem.id) }
                        // Only forward from SAVED_ON_PHONE (an older, slower run never undoes a newer answer).
                        .filter { it.state == PaymentState.SAVED_ON_PHONE && it.collectorId == session.user.id }
                        .map { current -> afterResult(current, byId[current.id.lowercase()], now) }
                updated.forEach { dao.update(it) }
                val malformed = updated.any { it.lastErrorCode == MALFORMED }
                Applied(
                    sent = updated.count { it.state == PaymentState.SENT_TO_OFFICE },
                    needsHelp = updated.count { it.state == PaymentState.NEEDS_OFFICE_HELP },
                    leftOnPhone = updated.count { it.state == PaymentState.SAVED_ON_PHONE },
                    failure = if (malformed) ApiFailure.Malformed(IllegalStateException(BAD_RESULT)) else null,
                )
            }

        /** The row after its result: no result → stays (NO_RESULT); an unusable result → stays (MALFORMED). */
        private fun afterResult(
            current: PaymentEntity,
            result: PaymentBatchResult?,
            now: Long,
        ): PaymentEntity =
            when {
                result == null -> current.copy(lastErrorCode = NO_RESULT)
                else -> next(current, result, now) ?: current.copy(lastErrorCode = MALFORMED)
            }

        /**
         * The row after [result], or null when the result cannot be used (a posted outcome without a
         * matching payment): the row then stays on the phone and is sent again.
         */
        private fun next(
            current: PaymentEntity,
            result: PaymentBatchResult,
            now: Long,
        ): PaymentEntity? =
            when (result.outcome) {
                PaymentOutcome.POSTED, PaymentOutcome.DUPLICATE, PaymentOutcome.POSTED_NEEDS_REVIEW -> {
                    result.payment?.takeIf { it.matches(current) }?.let { posted ->
                        current.copy(
                            state = PaymentState.SENT_TO_OFFICE,
                            receiptNumber = posted.receiptNumber,
                            postedAt = parseInstant(posted.postedAt),
                            postedBusinessDate = posted.businessDate,
                            balanceAfterPaise = posted.balanceAfterPaise,
                            creditAfterPaise = posted.creditAfterPaise,
                            allocationsJson = PaymentReceipts.encodeAllocations(json, posted.allocations),
                            reviewReason = result.reviewReason?.wire,
                            lastErrorCode = null,
                            syncedAt = now,
                        )
                    }
                }

                PaymentOutcome.REJECTED -> {
                    current.copy(
                        state = PaymentState.NEEDS_OFFICE_HELP,
                        lastErrorCode = result.error?.code ?: PaymentOutcome.REJECTED.wire,
                        syncedAt = now,
                    )
                }

                PaymentOutcome.RETRY_LATER -> {
                    current.copy(lastErrorCode = result.error?.code ?: PaymentOutcome.RETRY_LATER.wire)
                }
            }

        private fun PostedPayment.matches(payment: PaymentEntity): Boolean =
            id.equals(payment.id, ignoreCase = true) && provisionalRef == payment.provisionalRef

        private suspend fun markAttempt(batch: List<PaymentEntity>) {
            val now = time.nowMillis()
            db.withTransaction {
                batch.forEach { sentItem ->
                    val current = dao.get(sentItem.id) ?: return@forEach
                    if (current.state != PaymentState.SAVED_ON_PHONE) return@forEach
                    dao.update(current.copy(attemptCount = current.attemptCount + 1, lastAttemptAt = now))
                }
            }
        }

        private suspend fun recordFailure(
            batch: List<PaymentEntity>,
            failure: ApiFailure,
        ) {
            db.withTransaction {
                batch.forEach { sentItem ->
                    val current = dao.get(sentItem.id) ?: return@forEach
                    if (current.state != PaymentState.SAVED_ON_PHONE) return@forEach
                    dao.update(current.copy(lastErrorCode = failure.syncCode))
                }
            }
        }

        private fun parseInstant(text: String): Long? =
            try {
                Instant.parse(text).toEpochMilli()
            } catch (ignored: DateTimeParseException) {
                null
            }

        companion object {
            /** The contract's maximum batch size (`PaymentBatchRequest.payments`: 1–50). */
            const val BATCH_SIZE = 50

            /** Batches in one run (2,500 payments); a longer queue continues in the next run. */
            const val MAX_BATCHES_PER_RUN = 50

            /** `last_error_code` when the answer had no result for a payment that was sent. */
            const val NO_RESULT = "no_result"

            /** `last_error_code` when a posted outcome came without a matching payment (a contract bug). */
            const val MALFORMED = "malformed"

            private const val BAD_RESULT = "posted outcome without a matching payment"
        }
    }

/** ISO-8601 UTC with milliseconds, like the server's `toISOString()`: `2026-10-13T01:15:00.000Z`. */
private val WIRE_INSTANT: DateTimeFormatter =
    DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC)

/** An epoch-ms instant as the contract writes instants (UTC, `Z`). */
fun wireInstant(epochMillis: Long): String = WIRE_INSTANT.format(Instant.ofEpochMilli(epochMillis))

/** The wire item for a queued payment: `recorded_at` as ISO-8601 UTC, `upi_reference` only for UPI. */
fun PaymentEntity.toBatchItem(): PaymentBatchItem =
    PaymentBatchItem(
        id = id,
        customerId = customerId,
        amountPaise = amountPaise,
        method = method,
        upiReference = upiReference?.takeIf { method == PaymentMethod.UPI },
        notes = notes,
        recordedAt = wireInstant(recordedAt),
        provisionalRef = provisionalRef,
        collectorId = collectorId,
        deviceId = deviceId,
    )

private val PaymentSyncResult.status: PushStatus
    get() =
        when (this) {
            is PaymentSyncResult.Done -> {
                PushStatus.Finished
            }

            PaymentSyncResult.NotSignedIn -> {
                PushStatus.Idle
            }

            is PaymentSyncResult.RetryLater -> {
                if (failure is ApiFailure.Offline) PushStatus.NoInternet else PushStatus.Failed
            }

            is PaymentSyncResult.Stopped -> {
                PushStatus.Failed
            }
        }
