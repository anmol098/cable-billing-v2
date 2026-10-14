package com.cablebilling.lineman.feature.today

import android.database.SQLException
import androidx.room.withTransaction
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.CollectionDayEntity
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.TimeSource
import com.cablebilling.lineman.data.network.ApiErrorParser
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.MobileApi
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.generated.CollectionDay
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.Handover
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.network.generated.HandoverStatus
import com.cablebilling.lineman.data.sync.isRetryable
import com.cablebilling.lineman.data.sync.syncCode
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import javax.inject.Inject
import javax.inject.Singleton

/** Asks for the saved handovers to be sent soon (WorkManager; see [HandoverSyncScheduler]). */
fun interface HandoverSendTrigger {
    fun requestSend()
}

/** Everything the Today screen needs about one day, as stored on the phone and known in this app run. */
data class DayInputs(
    /** The lineman's payments of the day on this phone (any state), newest first. */
    val payments: List<PaymentEntity>,
    /** The office's answer: fresh (with its payment list) or the last one stored on the phone. */
    val office: OfficeDay?,
    /** A handover saved on the phone and not accepted by the server yet (or refused for good). */
    val queued: QueuedHandover?,
    /** A send is running now. */
    val sending: Boolean,
)

/** How asking the office for the day went. */
sealed interface RefreshResult {
    data class Refreshed(
        val day: OfficeDay,
    ) : RefreshResult

    data class Failed(
        val failure: ApiFailure,
    ) : RefreshResult

    data object NotSignedIn : RefreshResult
}

/** What [TodayRepository.queueHandover] did. The screen may say "Saved on phone" only for [Queued]. */
sealed interface QueueResult {
    /** Committed in Room ([isNew] false: this submission was already saved, e.g. a second tap). */
    data class Queued(
        val isNew: Boolean,
    ) : QueueResult

    /** The office already accepted this day's cash (as last heard): nothing was saved. */
    data object AlreadyAccepted : QueueResult

    data object NotSignedIn : QueueResult

    /** Room could not write. Nothing was saved. */
    data class Failed(
        val cause: Exception,
    ) : QueueResult
}

/** How one send of the saved handovers ended. [sent] were accepted by the server in this run. */
sealed interface HandoverSendResult {
    val sent: Int

    /** Nothing is waiting any more ([refused] were refused for good). */
    data class Done(
        override val sent: Int,
        val refused: Int,
    ) : HandoverSendResult

    /** Something is still waiting for a reason that passes by itself (no internet, 429/5xx, unreadable answer). */
    data class RetryLater(
        override val sent: Int,
        val failure: ApiFailure,
    ) : HandoverSendResult

    /** Retrying now cannot help (signed out, app too old, account switched off); the next trigger tries again. */
    data class Stopped(
        override val sent: Int,
        val failure: ApiFailure,
    ) : HandoverSendResult

    data object NotSignedIn : HandoverSendResult {
        override val sent: Int = 0
    }
}

/**
 * The lineman's day and cash handover (PLAN §8.7, FR-022, J-05) on top of `GET /collections/{date}` and
 * `POST /collections/{date}/handover` (T-061), the phone's payments (T-066) and the `collection_day`
 * table (T-064).
 *
 * **Handover durability.** [queueHandover] commits the handover in Room (`queued_handover_json`, with a
 * `submission_id` made before Save) and only then asks for a send. The request is frozen: every attempt
 * sends the identical body, so a resend after a timeout is a duplicate on the server, never a second
 * handover. The saved handover is cleared only when the server accepted *that* submission (200, or the
 * day shows it as the latest handover). Refusals (409 HANDOVER_ALREADY_ACCEPTED, 409 ID_REUSED, 400
 * VALIDATION …) mark it refused and it is never resent; no internet, 429, 5xx and unreadable answers keep
 * it waiting. Another lineman's saved handover on a shared phone is never sent with this sign-in.
 */
@Suppress("LongParameterList", "TooManyFunctions") // The day, its handover queue and the send share one store.
@Singleton
class TodayRepository
    @Inject
    constructor(
        private val db: CableDatabase,
        private val api: MobileApi,
        private val errors: ApiErrorParser,
        private val sessions: SessionStore,
        private val time: TimeSource,
        private val json: Json,
        private val trigger: HandoverSendTrigger,
    ) {
        private data class DayKey(
            val collectorId: String,
            val businessDate: String,
        )

        /** The office's answers received in this app run, with their payment lists. */
        private val fresh = MutableStateFlow<Map<DayKey, OfficeDay>>(emptyMap())
        private val sendMutex = Mutex()
        private val sendingNow = MutableStateFlow(false)
        private val dayDao get() = db.collectionDayDao()

        /**
         * One request about the lineman's days at a time (a day check or a handover), each answer stored
         * before the next request starts, so a slow older answer cannot overwrite a newer one.
         */
        private val exchange = Mutex()

        /** Order in which requests about a day were started; an older answer never replaces a newer one. */
        private val requestOrder = AtomicLong()
        private val storedOrder = ConcurrentHashMap<DayKey, Long>()

        /** A send is running in this process. */
        val sending: StateFlow<Boolean> = sendingNow.asStateFlow()

        /** [collectorId]'s day [businessDate], live. */
        fun observeDay(
            collectorId: String,
            businessDate: String,
        ): Flow<DayInputs> {
            val key = DayKey(collectorId, businessDate)
            return combine(
                db.paymentDao().observeDay(collectorId, businessDate),
                dayDao.observe(collectorId, businessDate),
                fresh.map { it[key] },
                sendingNow,
            ) { payments, stored, freshDay, sending ->
                DayInputs(
                    payments = payments,
                    office = freshDay ?: stored?.toOfficeDay(),
                    queued = stored?.queuedHandoverJson?.let(::decodeQueued),
                    sending = sending,
                )
            }
        }

        /** Asks the office for the signed-in lineman's day and stores the answer. */
        suspend fun refresh(businessDate: String): RefreshResult {
            val userId = signedInUserId() ?: return RefreshResult.NotSignedIn
            return exchange.withLock {
                val asked = requestOrder.incrementAndGet()
                when (val result = apiCall(errors) { api.getCollectionDay(businessDate) }) {
                    is ApiResult.Success -> {
                        val response = result.value
                        RefreshResult.Refreshed(
                            store(userId, businessDate, response.session, response.serverTime, null, asked),
                        )
                    }

                    is ApiResult.Failure -> {
                        RefreshResult.Failed(result.failure)
                    }
                }
            }
        }

        /**
         * Saves [request] as the signed-in lineman's handover for [businessDate] (replacing one not yet
         * accepted by the server), commits, then asks for a send. Idempotent on the submission id.
         */
        suspend fun queueHandover(
            businessDate: String,
            request: HandoverRequest,
        ): QueueResult {
            val userId = signedInUserId() ?: return QueueResult.NotSignedIn
            val result =
                try {
                    db.withTransaction {
                        val stored = dayDao.get(userId, businessDate)
                        val queued = stored?.queuedHandoverJson?.let(::decodeQueued)
                        when {
                            queued?.submissionId == request.submissionId -> {
                                QueueResult.Queued(isNew = false)
                            }

                            stored?.status == HandoverStatus.ACCEPTED.wire &&
                                stored.serverTime != NO_SERVER_ANSWER -> {
                                QueueResult.AlreadyAccepted
                            }

                            else -> {
                                val entry = QueuedHandover(request = request, queuedAt = time.nowMillis())
                                dayDao.upsert(
                                    (stored ?: placeholder(userId, businessDate)).copy(
                                        queuedHandoverJson = json.encodeToString(QueuedHandover.serializer(), entry),
                                    ),
                                )
                                QueueResult.Queued(isNew = true)
                            }
                        }
                    }
                } catch (e: SQLException) {
                    QueueResult.Failed(e)
                } catch (e: IllegalStateException) {
                    QueueResult.Failed(e)
                }
            // Only after the commit (also for a repeat: it makes sure a send follows).
            if (result is QueueResult.Queued) trigger.requestSend()
            return result
        }

        /** Sends the signed-in lineman's waiting handovers, oldest day first. One run at a time. */
        suspend fun sendQueued(): HandoverSendResult =
            sendMutex.withLock {
                sendingNow.value = true
                try {
                    sendAll()
                } finally {
                    sendingNow.value = false
                }
            }

        /** True when the signed-in lineman has a handover waiting to be sent. */
        suspend fun hasWaitingForSignedIn(): Boolean {
            val userId = signedInUserId() ?: return false
            return dayDao.withQueuedHandover(userId).any {
                decodeQueued(it.queuedHandoverJson)?.state ==
                    QueuedHandoverState.WAITING
            }
        }

        private suspend fun sendAll(): HandoverSendResult {
            val userId = signedInUserId() ?: return HandoverSendResult.NotSignedIn
            val progress = SendProgress()
            var stopped: HandoverSendResult? = null
            for (row in dayDao.withQueuedHandover(userId)) {
                stopped =
                    when {
                        // Another lineman signed in meanwhile: nothing more is sent under their sign-in.
                        sessions.session?.user?.id != userId -> HandoverSendResult.NotSignedIn

                        else -> sendOne(userId, row, progress)
                    }
                if (stopped != null) break
            }
            return stopped ?: progress.result()
        }

        /** What one send run has done so far. */
        private class SendProgress(
            var sent: Int = 0,
            var refused: Int = 0,
            var retry: ApiFailure? = null,
        ) {
            fun result(): HandoverSendResult =
                retry?.let { HandoverSendResult.RetryLater(sent, it) } ?: HandoverSendResult.Done(sent, refused)
        }

        /** Sends one day's waiting handover; returns how the run ends, or null to go on. */
        private suspend fun sendOne(
            userId: String,
            row: CollectionDayEntity,
            progress: SendProgress,
        ): HandoverSendResult? {
            val queued = decodeQueued(row.queuedHandoverJson)?.takeIf { it.state == QueuedHandoverState.WAITING }
            if (queued == null) return null
            markAttempt(userId, row.businessDate, queued.submissionId)
            val result =
                exchange.withLock {
                    val asked = requestOrder.incrementAndGet()
                    apiCall(errors) { api.submitHandover(row.businessDate, queued.request) }.also {
                        if (it is ApiResult.Success) {
                            store(
                                userId,
                                row.businessDate,
                                it.value.session,
                                it.value.serverTime,
                                queued.submissionId,
                                asked,
                            )
                        }
                    }
                }
            return when (result) {
                is ApiResult.Success -> {
                    progress.sent++
                    null
                }

                is ApiResult.Failure -> {
                    failed(userId, row.businessDate, queued.submissionId, result.failure, progress)
                }
            }
        }

        /** Records a failed send; returns how the run ends, or null to go on with the next day. */
        private suspend fun failed(
            userId: String,
            businessDate: String,
            submissionId: String,
            failure: ApiFailure,
            progress: SendProgress,
        ): HandoverSendResult? {
            updateQueued(userId, businessDate, submissionId) {
                it.copy(
                    lastErrorCode = failure.syncCode,
                    state = if (failure.isRefusal) QueuedHandoverState.REFUSED else it.state,
                )
            }
            return when {
                failure.isRefusal -> {
                    progress.refused++
                    // The day is final at the office: show it as it is now.
                    if ((failure as? ApiFailure.Server)?.code == ErrorCode.HANDOVER_ALREADY_ACCEPTED.wire) {
                        refresh(businessDate)
                    }
                    null
                }

                failure.isRetryable || failure is ApiFailure.Malformed -> {
                    progress.retry = failure
                    null
                }

                else -> {
                    HandoverSendResult.Stopped(progress.sent, failure)
                }
            }
        }

        private suspend fun markAttempt(
            userId: String,
            businessDate: String,
            submissionId: String,
        ) = updateQueued(userId, businessDate, submissionId) {
            it.copy(attemptCount = it.attemptCount + 1, lastAttemptAt = time.nowMillis())
        }

        /** Changes the saved handover only if it is still [submissionId] (the lineman may have replaced it). */
        private suspend fun updateQueued(
            userId: String,
            businessDate: String,
            submissionId: String,
            change: (QueuedHandover) -> QueuedHandover,
        ) {
            db.withTransaction {
                val stored = dayDao.get(userId, businessDate) ?: return@withTransaction
                val queued = stored.queuedHandoverJson?.let(::decodeQueued) ?: return@withTransaction
                if (queued.submissionId != submissionId) return@withTransaction
                dayDao.upsert(
                    stored.copy(queuedHandoverJson = json.encodeToString(QueuedHandover.serializer(), change(queued))),
                )
            }
        }

        /**
         * Stores the office's answer. The saved handover is cleared when the server accepted it: [sentSubmissionId]
         * (the submission this answer is for) or the answer's latest handover is that submission.
         */
        private suspend fun store(
            userId: String,
            businessDate: String,
            day: CollectionDay,
            serverTime: String,
            sentSubmissionId: String?,
            asked: Long,
        ): OfficeDay {
            val officeDay =
                OfficeDay(
                    businessDate = businessDate,
                    totals = MethodTotals(day.cashTotalPaise, day.upiTotalPaise, day.paymentCount.toInt()),
                    status = day.status,
                    handover = day.handover,
                    payments = day.payments,
                    serverTime = parseInstantMillis(serverTime) ?: time.nowMillis(),
                )
            val key = DayKey(userId, businessDate)
            val newest =
                db.withTransaction {
                    val stored = dayDao.get(userId, businessDate)
                    val queued = stored?.queuedHandoverJson?.let(::decodeQueued)
                    val atOffice = setOfNotNull(sentSubmissionId, day.handover?.submissionId)
                    val keep = queued?.takeIf { it.submissionId !in atOffice }
                    val keepJson = keep?.let { json.encodeToString(QueuedHandover.serializer(), it) }
                    val newest = stored == null || isNewer(officeDay.serverTime, asked, stored.serverTime, key)
                    if (newest) {
                        storedOrder[key] = asked
                        dayDao.upsert(
                            CollectionDayEntity(
                                collectorId = userId,
                                businessDate = businessDate,
                                cashTotalPaise = day.cashTotalPaise,
                                upiTotalPaise = day.upiTotalPaise,
                                paymentCount = day.paymentCount,
                                status = day.status.wire,
                                handoverJson = day.handover?.let { json.encodeToString(Handover.serializer(), it) },
                                serverTime = officeDay.serverTime,
                                cachedAt = time.nowMillis(),
                                queuedHandoverJson = keepJson,
                            ),
                        )
                    } else if (keep != queued) {
                        // An older answer arrived late: keep the newer day, but it still proves the office has
                        // the saved handover.
                        dayDao.upsert(stored.copy(queuedHandoverJson = keepJson))
                    }
                    newest
                }
            if (newest) fresh.update { it + (key to officeDay) }
            return officeDay
        }

        /**
         * True when an answer (server clock [serverTime], request number [asked]) is at least as new as the
         * stored one: a later server clock, or the same clock and a request started later in this run.
         */
        private fun isNewer(
            serverTime: Long,
            asked: Long,
            storedServerTime: Long,
            key: DayKey,
        ): Boolean =
            storedServerTime == NO_SERVER_ANSWER ||
                serverTime > storedServerTime ||
                (serverTime == storedServerTime && asked >= (storedOrder[key] ?: 0L))

        private fun CollectionDayEntity.toOfficeDay(): OfficeDay? {
            val known = HandoverStatus.fromWire(status)?.takeIf { serverTime != NO_SERVER_ANSWER } ?: return null
            return OfficeDay(
                businessDate = businessDate,
                totals = MethodTotals(cashTotalPaise, upiTotalPaise, paymentCount.toInt()),
                status = known,
                handover = handoverJson?.let { decodeOrNull(Handover.serializer(), it) },
                payments = null,
                serverTime = serverTime,
            )
        }

        private fun placeholder(
            userId: String,
            businessDate: String,
        ) = CollectionDayEntity(
            collectorId = userId,
            businessDate = businessDate,
            cashTotalPaise = 0,
            upiTotalPaise = 0,
            paymentCount = 0,
            status = HandoverStatus.OPEN.wire,
            handoverJson = null,
            serverTime = NO_SERVER_ANSWER,
            cachedAt = NO_SERVER_ANSWER,
        )

        private fun decodeQueued(text: String?): QueuedHandover? =
            text?.let { decodeOrNull(QueuedHandover.serializer(), it) }

        private fun <T> decodeOrNull(
            serializer: kotlinx.serialization.KSerializer<T>,
            text: String,
        ): T? =
            try {
                json.decodeFromString(serializer, text)
            } catch (ignored: SerializationException) {
                null
            } catch (ignored: IllegalArgumentException) {
                null
            }

        private suspend fun signedInUserId(): String? = (sessions.load() as? SessionState.SignedIn)?.session?.user?.id

        companion object {
            /** `collection_day.server_time` of a row that only holds a handover saved offline. */
            const val NO_SERVER_ANSWER: Long = 0L
        }
    }

/**
 * The server refused the handover for good: resending the same request cannot succeed (already accepted,
 * id reused with other data, invalid, not allowed). Sign-in problems are not refusals: the handover waits
 * for the lineman to sign in again.
 */
val ApiFailure.isRefusal: Boolean
    get() {
        if (this !is ApiFailure.Server || isTemporary) return false
        val signInProblem =
            httpStatus == ApiFailure.HTTP_UNAUTHORIZED ||
                code == ErrorCode.ACCOUNT_DISABLED.wire ||
                code == ErrorCode.DEVICE_REVOKED.wire
        return !signInProblem && httpStatus in HTTP_CLIENT_ERRORS
    }

private val HTTP_CLIENT_ERRORS = 400..499
