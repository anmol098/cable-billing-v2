package com.cablebilling.lineman.data.payments

import android.database.SQLException
import androidx.room.withTransaction
import com.cablebilling.lineman.data.auth.Session
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.TimeSource
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

/** Asks for the payment queue to be pushed to the office soon (WorkManager; see `PaymentSyncScheduler`). */
fun interface PaymentPushTrigger {
    fun requestPush()
}

/**
 * The phone's payment queue (PLAN §10.4, §11.5): saving a payment, and reading it back for the Done,
 * Waiting and Today screens. Rows are never deleted or replaced (BR-11); only the push
 * (`PaymentSync`) changes their sync fields afterwards.
 *
 * **Save order** (FR-015): the UUIDv7 id comes with the draft (made before Save), the provisional
 * reference `P-{device_code}-{seq}` is taken inside the insert's transaction, the transaction commits,
 * and only then does [save] return [SaveResult.Saved] — the screen says "Saved" after that. The push is
 * requested after the commit; if the app dies before it, the next app start finds the payment and
 * pushes it (`PaymentSyncScheduler.start`).
 */
@Singleton
class PaymentRepository
    @Inject
    constructor(
        private val db: CableDatabase,
        private val sessions: SessionStore,
        private val time: TimeSource,
        private val pushes: PaymentPushTrigger,
    ) {
        private val dao get() = db.paymentDao()

        /** Saves [draft] for the signed-in lineman on this phone. Idempotent on [PaymentDraft.id]. */
        suspend fun save(draft: PaymentDraft): SaveResult {
            val problem = PaymentRules.problem(draft)
            val session = if (problem == null) (sessions.load() as? SessionState.SignedIn)?.session else null
            val result =
                when {
                    problem != null -> SaveResult.Invalid(problem)
                    session == null -> SaveResult.NotSignedIn
                    else -> insert(draft, session)
                }
            // Only after the commit (also for a repeat: it makes sure a push follows).
            if (result is SaveResult.Saved) pushes.requestPush()
            return result
        }

        /** One transaction: the existing row for this id, or the next provisional reference + the insert. */
        private suspend fun insert(
            draft: PaymentDraft,
            session: Session,
        ): SaveResult {
            val recordedAt = time.nowMillis()
            return try {
                db.withTransaction {
                    val existing = dao.get(draft.id)
                    if (existing != null) {
                        return@withTransaction SaveResult.Saved(existing.id, existing.provisionalRef, isNew = false)
                    }
                    val deviceCode = session.device.deviceCode
                    val seq = dao.countWithRefPrefix(PaymentRules.provisionalPrefix(deviceCode)) + 1
                    val payment =
                        PaymentEntity(
                            id = draft.id,
                            customerId = draft.customerId,
                            customerCode = draft.customerCode,
                            customerName = draft.customerName,
                            amountPaise = draft.amountPaise,
                            method = draft.method,
                            upiReference = PaymentRules.normalizedUpiReference(draft.method, draft.upiReference),
                            notes = null,
                            recordedAt = recordedAt,
                            businessDate = PaymentRules.businessDate(recordedAt),
                            provisionalRef = PaymentRules.provisionalRef(deviceCode, seq),
                            collectorId = session.user.id,
                            deviceId = session.device.id,
                            state = PaymentState.SAVED_ON_PHONE,
                        )
                    dao.insert(payment)
                    SaveResult.Saved(payment.id, payment.provisionalRef, isNew = true)
                }
            } catch (e: SQLException) {
                SaveResult.Failed(e)
            } catch (e: IllegalStateException) {
                // Room wraps some open/IO failures (e.g. a full disk while opening) in this.
                SaveResult.Failed(e)
            }
        }

        /** One payment as stored now. */
        suspend fun get(id: String): PaymentEntity? = dao.get(id)

        /** One payment, live (the Done screen switches to the permanent number when the push answers). */
        fun observe(id: String): Flow<PaymentEntity?> = dao.observe(id)

        /** Payments the office does not have yet: on the phone, held, or needing office help; newest first. */
        fun observeWaiting(): Flow<List<PaymentEntity>> = dao.observeNotSent()
    }

/**
 * A payment another lineman took on this phone, waiting while someone else is signed in. The push
 * never sends it under the new lineman's sign-in (PLAN §9.2): it stays on the phone, counted and
 * shown as held, until its own lineman signs in again or the office sorts it out.
 */
fun PaymentEntity.isHeldFor(signedInUserId: String?): Boolean =
    state == PaymentState.SAVED_ON_PHONE && signedInUserId != null && collectorId != signedInUserId
