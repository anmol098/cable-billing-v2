package com.cablebilling.lineman.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/** Where a queued item (receipt action) stands. Stored as the enum name. */
enum class OutboxState {
    /** Waiting to be sent (or `retry_later`). */
    PENDING,

    /** The server answered `recorded` or `duplicate`. */
    RECORDED,

    /** The server answered `rejected`; kept for diagnostics, never resent. */
    REJECTED,
}

/**
 * Receipt actions waiting for `POST /receipts/actions:batch` (PLAN §11.5, used by T-069). Only
 * observable actions (`printed`, `print_failed`, `whatsapp_opened`, `sms_opened`, `pdf_shared`):
 * never "sent" or "delivered".
 */
@Entity(
    tableName = "receipt_actions_outbox",
    indices = [Index("payment_id"), Index("state", "at")],
)
data class ReceiptActionOutboxEntity(
    /** UUID made on the phone: the idempotency key. */
    @PrimaryKey val id: String,
    @ColumnInfo(name = "payment_id") val paymentId: String,
    /** `ReceiptActionType` wire value. */
    val action: String,
    /** Phone clock (epoch ms) when it happened. */
    val at: Long,
    val state: OutboxState = OutboxState.PENDING,
    @ColumnInfo(name = "attempt_count") val attemptCount: Int = 0,
    @ColumnInfo(name = "last_error_code") val lastErrorCode: String? = null,
)

/**
 * The lineman's day as the server last reported it (`GET /collections/{date}`), plus a handover the
 * lineman submitted offline (PLAN §11.5, used by T-070). Local unsynced payments are not in these
 * totals: add them from `payments` and label them.
 */
@Entity(tableName = "collection_day", primaryKeys = ["collector_id", "business_date"])
data class CollectionDayEntity(
    @ColumnInfo(name = "collector_id") val collectorId: String,
    /** India-time day, `YYYY-MM-DD`. */
    @ColumnInfo(name = "business_date") val businessDate: String,
    @ColumnInfo(name = "cash_total_paise") val cashTotalPaise: Long,
    @ColumnInfo(name = "upi_total_paise") val upiTotalPaise: Long,
    @ColumnInfo(name = "payment_count") val paymentCount: Long,
    /** `HandoverStatus` wire value. */
    val status: String,
    /** The server's `handover` object as JSON, or null. */
    @ColumnInfo(name = "handover_json") val handoverJson: String?,
    /**
     * Server clock of that answer (epoch ms). T-070: `0` = no answer from the server yet (a row made only
     * to hold a handover saved offline; its totals are zeros, not the office's numbers).
     */
    @ColumnInfo(name = "server_time") val serverTime: Long,
    /** Phone clock when it was stored (epoch ms). */
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
    /**
     * A handover saved on the phone and not yet accepted by the server, or null. T-070 stores its
     * `QueuedHandover` JSON here (the frozen `HandoverRequest` + attempts, or "refused" for good).
     */
    @ColumnInfo(name = "queued_handover_json") val queuedHandoverJson: String? = null,
)

/**
 * Sync bookkeeping, one row per [stream] (PLAN §11.5): the roster uses [SyncStreams.ROSTER]; later
 * tasks may add their own streams.
 */
@Entity(tableName = "sync_meta")
data class SyncMetaEntity(
    @PrimaryKey val stream: String,
    /** Whose data this is: the operator id the roster belongs to. Data of another operator is never shown. */
    val scope: String?,
    /** The server's `next_cursor`, or null before the first complete sync (or after CURSOR_INVALID). */
    val cursor: String?,
    /** Phone clock (epoch ms) of the last sync that finished: "Updated X min ago". */
    @ColumnInfo(name = "last_success_at") val lastSuccessAt: Long?,
    /** Server clock (`server_time`, epoch ms) of that sync. */
    @ColumnInfo(name = "last_server_time") val lastServerTime: Long?,
    /** Phone clock of the last attempt, successful or not. */
    @ColumnInfo(name = "last_attempt_at") val lastAttemptAt: Long?,
    /** Why the last attempt failed (`offline`, `server:<CODE>`, `malformed`, …), null if it worked. */
    @ColumnInfo(name = "last_failure") val lastFailure: String?,
)

/** Names of the [SyncMetaEntity] streams. */
object SyncStreams {
    const val ROSTER = "roster"
}
