package com.cablebilling.lineman.data.receipts

import android.database.SQLException
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.ReceiptActionOutboxEntity
import com.cablebilling.lineman.data.db.TimeSource
import com.cablebilling.lineman.data.network.generated.ReceiptActionType
import com.cablebilling.lineman.data.payments.UuidV7
import com.cablebilling.lineman.diagnostics.DiagnosticLog
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Notes what the lineman did with a receipt, for the office (PLAN §11.5, §11.7). Only what the phone
 * can observe ([ReceiptActionType]: printed, print_failed, whatsapp_opened, sms_opened, pdf_shared);
 * never "sent" or "delivered" (RULE-19).
 *
 * Recording never blocks or fails the caller, and never touches the payment (RULE-18).
 */
fun interface ReceiptActionRecorder {
    /** Records [action] on [paymentId]'s receipt; the returned job ends once it is stored. */
    fun record(
        paymentId: String,
        action: ReceiptActionType,
    ): Job

    companion object {
        /** Records nothing (screens shown without the app's storage, e.g. some tests). */
        val None = ReceiptActionRecorder { _, _ -> Job().apply { complete() } }
    }
}

/** Asks for the receipt outboxes to be sent to the office soon (WorkManager; see `ReceiptSyncScheduler`). */
fun interface ReceiptSyncTrigger {
    fun requestSync()
}

/**
 * [ReceiptActionRecorder] on the Room outbox `receipt_actions_outbox`: each action is one row with a
 * UUIDv7 made when it happened (the server's idempotency key, so a resend is a `duplicate`), committed
 * before the send is requested. The row survives process death and is sent by `ReceiptSync` once its
 * payment is at the office. Rows are never deleted.
 */
@Singleton
class OutboxReceiptActions
    @Inject
    constructor(
        private val db: CableDatabase,
        private val time: TimeSource,
        private val trigger: ReceiptSyncTrigger,
        private val log: DiagnosticLog,
    ) : ReceiptActionRecorder {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        override fun record(
            paymentId: String,
            action: ReceiptActionType,
        ): Job =
            scope.launch {
                val at = time.nowMillis()
                val row =
                    ReceiptActionOutboxEntity(
                        id = UuidV7.generate(at),
                        paymentId = paymentId,
                        action = action.wire,
                        at = at,
                    )
                try {
                    db.receiptActionDao().insert(row)
                } catch (e: SQLException) {
                    // The receipt was given anyway; only the office's note of it is missing.
                    log.error("receipt_action_not_stored", e)
                    return@launch
                }
                log.info("receipt_action", "action=${action.wire}")
                trigger.requestSync()
            }
    }
