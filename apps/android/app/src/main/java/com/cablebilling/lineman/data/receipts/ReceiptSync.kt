package com.cablebilling.lineman.data.receipts

import androidx.room.withTransaction
import com.cablebilling.lineman.data.auth.Session
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.OutboxState
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.ReceiptActionOutboxEntity
import com.cablebilling.lineman.data.db.TimeSource
import com.cablebilling.lineman.data.network.ApiErrorParser
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.MobileApi
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.ReceiptActionItem
import com.cablebilling.lineman.data.network.generated.ReceiptActionOutcome
import com.cablebilling.lineman.data.network.generated.ReceiptActionResult
import com.cablebilling.lineman.data.network.generated.ReceiptActionType
import com.cablebilling.lineman.data.network.generated.ReceiptActionsRequest
import com.cablebilling.lineman.data.network.generated.UpdatePhoneRequest
import com.cablebilling.lineman.data.sync.isRetryable
import com.cablebilling.lineman.data.sync.syncCode
import com.cablebilling.lineman.data.sync.wireInstant
import com.cablebilling.lineman.diagnostics.DiagnosticLog
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.Instant
import java.time.format.DateTimeParseException
import javax.inject.Inject
import javax.inject.Singleton

/** How one run of [ReceiptSync] ended. */
sealed interface ReceiptSyncResult {
    /** Phone numbers the office took in this run (the roster is then pulled again). */
    val phonesChanged: Int

    /**
     * Nothing more to do now. What is left waits for something else: a payment to reach the office,
     * or a server that does not take phone changes yet (404/501), retried at the next trigger.
     */
    data class Done(
        override val phonesChanged: Int,
    ) : ReceiptSyncResult

    /** No internet or a temporary server problem: try again with backoff. */
    data class RetryLater(
        override val phonesChanged: Int,
        val failure: ApiFailure?,
    ) : ReceiptSyncResult

    /** Signed out or the app is too old: the next trigger (sign-in, update) starts again. */
    data class Stopped(
        override val phonesChanged: Int,
        val failure: ApiFailure,
    ) : ReceiptSyncResult

    data object NotSignedIn : ReceiptSyncResult {
        override val phonesChanged: Int = 0
    }
}

/**
 * Sends the receipt flow's queues to the office, for the signed-in lineman only (PLAN §11.5, §11.7):
 *
 * 1. **Phone changes** → `PATCH /customers/{id}/phone` (FR-004; the server audits them with source
 *    `android`). Taken → kept as "sent" until the roster has a newer copy. 400 VALIDATION → dropped
 *    (the server will never take it). 404 / 501 / 403 → kept for the next trigger without backoff: the
 *    endpoint (T-060) may not be deployed yet, and the change must not be lost. No internet / 429 /
 *    5xx → retry with backoff.
 * 2. **Queued links** → `POST /receipts/{paymentId}/link` once the payment is at the office;
 *    PAYMENT_NOT_FOUND keeps it for later.
 * 3. **Receipt actions** → `POST /receipts/actions:batch`, oldest first, ≤ [BATCH_SIZE], only for
 *    payments at the office (the server answers retry_later otherwise). `recorded` / `duplicate` →
 *    RECORDED; `rejected` → REJECTED (kept, never resent); `retry_later` or no result → stays PENDING.
 *    Ids are fixed when the action happens, so a resend after a lost answer is a `duplicate`.
 *
 * Nothing here touches a payment (RULE-18). One run at a time.
 */
@Suppress("LongParameterList", "TooManyFunctions") // DI collaborators; three small queues in one run.
@Singleton
class ReceiptSync
    @Inject
    constructor(
        private val db: CableDatabase,
        private val api: MobileApi,
        private val errors: ApiErrorParser,
        private val sessions: SessionStore,
        private val store: ReceiptRequestStore,
        private val links: ReceiptLinks,
        private val time: TimeSource,
        private val log: DiagnosticLog,
    ) {
        private val mutex = Mutex()
        private val dao get() = db.receiptActionDao()

        /** True when anything is queued (any lineman): worth enqueuing a run. */
        suspend fun hasWork(): Boolean = dao.countPending() > 0 || store.current().hasWork

        suspend fun run(): ReceiptSyncResult =
            mutex.withLock {
                val session =
                    (sessions.load() as? SessionState.SignedIn)?.session ?: return ReceiptSyncResult.NotSignedIn
                val run = Run()
                sendPhones(session, run)
                if (run.stop == null) fetchLinks(session, run)
                if (run.stop == null) sendActions(session, run)
                val stop = run.stop
                when {
                    stop != null -> ReceiptSyncResult.Stopped(run.phonesChanged, stop)
                    run.retry -> ReceiptSyncResult.RetryLater(run.phonesChanged, run.failure)
                    else -> ReceiptSyncResult.Done(run.phonesChanged)
                }
            }

        private class Run(
            var phonesChanged: Int = 0,
            var retry: Boolean = false,
            var failure: ApiFailure? = null,
            var stop: ApiFailure? = null,
        ) {
            /** Notes a failed call: retry with backoff, stop, or (null) keep it for the next trigger. */
            fun failed(failure: ApiFailure) {
                when {
                    failure is ApiFailure.AppTooOld || failure is ApiFailure.SignedOut -> {
                        stop = failure
                    }

                    failure.isRetryable || failure is ApiFailure.Malformed -> {
                        retry = true
                        this.failure = failure
                    }
                }
            }
        }

        private suspend fun sendPhones(
            session: Session,
            run: Run,
        ) {
            cleanUpSentPhones()
            val queued =
                store.current().phones.filter {
                    it.sentAt == null && it.userId == session.user.id && it.operatorId == session.operator.id
                }
            for (change in queued) {
                sendPhone(change, run)
                if (run.stop != null || run.retry) return
            }
        }

        private suspend fun sendPhone(
            change: QueuedPhone,
            run: Run,
        ) {
            val result =
                apiCall(errors) { api.updateCustomerPhone(change.customerId, UpdatePhoneRequest(change.phone)) }
            when (result) {
                is ApiResult.Success -> {
                    val updatedAt = parseInstant(result.value.customer.updatedAt)
                    updatePhone(
                        change,
                    ) { it.copy(sentAt = time.nowMillis(), serverUpdatedAt = updatedAt, lastError = null) }
                    run.phonesChanged++
                    log.info("receipt_phone_update", "result=ok changed=${result.value.changed}")
                }

                is ApiResult.Failure -> {
                    phoneFailed(change, result.failure, run)
                }
            }
        }

        private suspend fun phoneFailed(
            change: QueuedPhone,
            failure: ApiFailure,
            run: Run,
        ) {
            val code = failure.syncCode
            val server = failure as? ApiFailure.Server
            if (server?.knownCode == ErrorCode.VALIDATION) {
                store.update { r -> r.copy(phones = r.phones.filterNot { it == change }) }
                log.warn("receipt_phone_update", "result=dropped code=$code")
                return
            }
            updatePhone(change) { it.copy(attempts = it.attempts + 1, lastError = code) }
            log.warn("receipt_phone_update", "result=kept code=$code")
            // 404 / 501: the endpoint may not be deployed yet (T-060). Keep the change for the next
            // trigger instead of retrying it with backoff.
            if (server == null || server.httpStatus !in NOT_THERE_YET) run.failed(failure)
        }

        /** Replaces [change] (if it is still the queued one for its customer) with [next]. */
        private suspend fun updatePhone(
            change: QueuedPhone,
            next: (QueuedPhone) -> QueuedPhone,
        ) {
            store.update { requests ->
                requests.copy(
                    phones =
                        requests.phones.map {
                            if (it.customerId == change.customerId && it.queuedAt == change.queuedAt) next(it) else it
                        },
                )
            }
        }

        /** Drops sent phone changes once the roster has a copy at least as new as the server's answer. */
        private suspend fun cleanUpSentPhones() {
            val sent = store.current().phones.filter { it.sentAt != null }
            if (sent.isEmpty()) return
            val customers = db.customerDao()
            val stale =
                sent.filter { entry ->
                    val roster = customers.get(entry.customerId)
                    val serverAt = entry.serverUpdatedAt
                    (roster != null && serverAt != null && roster.updatedAt >= serverAt) ||
                        time.nowMillis() - (entry.sentAt ?: 0) > SENT_PHONE_KEEP_MILLIS
                }
            if (stale.isNotEmpty()) store.update { r -> r.copy(phones = r.phones - stale.toSet()) }
        }

        private suspend fun fetchLinks(
            session: Session,
            run: Run,
        ) {
            val queued = store.current().links.filter { it.userId == session.user.id }
            for (request in queued) {
                val payment = db.paymentDao().get(request.paymentId)
                when {
                    payment == null || payment.state == PaymentState.NEEDS_OFFICE_HELP -> {
                        store.update { r -> r.copy(links = r.links.filterNot { it.paymentId == request.paymentId }) }
                    }

                    // Waits for the payment push; its success triggers this sync again.
                    payment.state != PaymentState.SENT_TO_OFFICE -> {
                        continue
                    }

                    else -> {
                        when (val fetched = links.fetch(payment)) {
                            is LinkFetch.Made -> {
                                log.info("receipt_link", "result=ok")
                            }

                            is LinkFetch.Failed -> {
                                val code = fetched.failure.syncCode
                                store.update { r ->
                                    r.copy(
                                        links =
                                            r.links.map {
                                                if (it.paymentId == request.paymentId) {
                                                    it.copy(attempts = it.attempts + 1, lastError = code)
                                                } else {
                                                    it
                                                }
                                            },
                                    )
                                }
                                log.warn("receipt_link", "result=kept code=$code")
                                run.failed(fetched.failure)
                            }
                        }
                    }
                }
                if (run.stop != null) return
            }
        }

        private suspend fun sendActions(
            session: Session,
            run: Run,
        ) {
            var batches = 0
            var more = true
            while (more && run.stop == null && !run.retry) {
                if (batches++ == MAX_BATCHES_PER_RUN) {
                    run.retry = true // A very long outbox: the next run goes on.
                } else {
                    more = sendBatch(dao.oldestSendable(session.user.id, BATCH_SIZE), run)
                }
            }
        }

        /** Sends one batch; returns false when there was nothing to send. */
        private suspend fun sendBatch(
            batch: List<ReceiptActionOutboxEntity>,
            run: Run,
        ): Boolean {
            if (batch.isEmpty()) return false
            // Only ReceiptActionType values are ever stored; an unknown name would be refused by the server.
            val (known, unknown) = batch.partition { ReceiptActionType.fromWire(it.action) != null }
            if (unknown.isNotEmpty()) {
                dao.update(unknown.map { it.copy(state = OutboxState.REJECTED, lastErrorCode = UNKNOWN_ACTION) })
            }
            return known.isEmpty() || postBatch(known, run)
        }

        /** Posts [batch] and stores the outcomes; false when the call failed (the run stops sending). */
        private suspend fun postBatch(
            batch: List<ReceiptActionOutboxEntity>,
            run: Run,
        ): Boolean =
            when (
                val result =
                    apiCall(errors) { api.postReceiptActions(ReceiptActionsRequest(batch.mapNotNull { it.toItem() })) }
            ) {
                is ApiResult.Success -> {
                    if (apply(batch, result.value.results) > 0) run.retry = true
                    true
                }

                is ApiResult.Failure -> {
                    val code = result.failure.syncCode
                    db.withTransaction {
                        dao.update(batch.map { it.copy(attemptCount = it.attemptCount + 1, lastErrorCode = code) })
                    }
                    log.warn("receipt_actions", "result=failed count=${batch.size} code=$code")
                    // Temporary → retry with backoff; a refusal of the whole batch → the next trigger.
                    run.failed(result.failure)
                    false
                }
            }

        /** Stores the outcomes; returns how many sent actions stay pending (retry_later or no result). */
        private suspend fun apply(
            batch: List<ReceiptActionOutboxEntity>,
            results: List<ReceiptActionResult>,
        ): Int {
            val byId = results.associateBy { it.id.lowercase() }
            val updated =
                batch.map { action ->
                    val result = byId[action.id.lowercase()]
                    when (result?.outcome) {
                        ReceiptActionOutcome.RECORDED, ReceiptActionOutcome.DUPLICATE -> {
                            action.copy(
                                state = OutboxState.RECORDED,
                                attemptCount = action.attemptCount + 1,
                                lastErrorCode = null,
                            )
                        }

                        ReceiptActionOutcome.REJECTED -> {
                            action.copy(
                                state = OutboxState.REJECTED,
                                attemptCount = action.attemptCount + 1,
                                lastErrorCode = result.error?.code ?: ReceiptActionOutcome.REJECTED.wire,
                            )
                        }

                        ReceiptActionOutcome.RETRY_LATER -> {
                            action.copy(
                                attemptCount = action.attemptCount + 1,
                                lastErrorCode = result.error?.code ?: ReceiptActionOutcome.RETRY_LATER.wire,
                            )
                        }

                        null -> {
                            action.copy(attemptCount = action.attemptCount + 1, lastErrorCode = NO_RESULT)
                        }
                    }
                }
            db.withTransaction { dao.update(updated) }
            val recorded = updated.count { it.state == OutboxState.RECORDED }
            val rejected = updated.count { it.state == OutboxState.REJECTED }
            val left = updated.count { it.state == OutboxState.PENDING }
            log.info("receipt_actions", "recorded=$recorded rejected=$rejected left=$left")
            return left
        }

        private fun ReceiptActionOutboxEntity.toItem(): ReceiptActionItem? =
            ReceiptActionType.fromWire(action)?.let { type ->
                ReceiptActionItem(id = id, paymentId = paymentId, action = type, at = wireInstant(at))
            }

        private fun parseInstant(text: String): Long? =
            try {
                Instant.parse(text).toEpochMilli()
            } catch (ignored: DateTimeParseException) {
                null
            }

        companion object {
            /** The contract's maximum (`RECEIPT_ACTION_BATCH_MAX`). */
            const val BATCH_SIZE = 100

            const val MAX_BATCHES_PER_RUN = 20

            /** `last_error_code` when the answer had no result for a sent action. */
            const val NO_RESULT = "no_result"

            /** `last_error_code` for a stored action name this app does not know (never sent). */
            const val UNKNOWN_ACTION = "unknown_action"

            /** A sent phone change is shown on this phone at most this long if the roster never catches up. */
            const val SENT_PHONE_KEEP_MILLIS: Long = 7L * 24 * 60 * 60 * 1000

            /** HTTP statuses that mean "this server has no phone endpoint (yet)": keep, no backoff. */
            private val NOT_THERE_YET = setOf(404, 501)
        }
    }
