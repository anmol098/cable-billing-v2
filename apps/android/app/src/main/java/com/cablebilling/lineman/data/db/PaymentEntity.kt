package com.cablebilling.lineman.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import com.cablebilling.lineman.data.network.generated.PaymentMethod

/**
 * Where a payment taken on this phone stands (PLAN §10.4). Stored as the enum name (TEXT), so a
 * later task can add a state without a schema migration (but must check [PaymentDao] and the
 * projection rule in [RosterQueries.PENDING_FOR_CUSTOMER]).
 */
enum class PaymentState {
    /** In Room, not yet accepted by the server. Retried automatically. Counts in the projected balance. */
    SAVED_ON_PHONE,

    /** The server posted it (`posted`, `duplicate` or `posted_needs_review`); [PaymentEntity.receiptNumber] is set. */
    SENT_TO_OFFICE,

    /** The server rejected it (`rejected`): "Call office". Kept forever, never retried automatically. */
    NEEDS_OFFICE_HELP,
}

/**
 * The local payment queue (PLAN §11.5, used by T-066). One row per payment the lineman saved on this
 * phone. Rows are **never deleted** (BR-11): [PaymentDao] has no delete. The row is inserted in one
 * transaction before the app says "Saved", and only its sync fields change afterwards.
 *
 * Instants are epoch ms UTC: [recordedAt] by the phone clock, [postedAt] by the server's. Money is paise.
 */
@Entity(
    tableName = "payments",
    indices = [
        Index("customer_id", "state"),
        Index("state", "recorded_at"),
        Index("collector_id", "business_date"),
        Index(value = ["provisional_ref"], unique = true),
    ],
)
data class PaymentEntity(
    /** UUIDv7 made before the insert: the idempotency key sent as `id` (FR-015). */
    @PrimaryKey val id: String,
    @ColumnInfo(name = "customer_id") val customerId: String,
    /** Customer code and name when saved, for the Waiting list and receipts even if the customer leaves the roster. */
    @ColumnInfo(name = "customer_code") val customerCode: String,
    @ColumnInfo(name = "customer_name") val customerName: String,
    @ColumnInfo(name = "amount_paise") val amountPaise: Long,
    val method: PaymentMethod,
    @ColumnInfo(name = "upi_reference") val upiReference: String?,
    val notes: String?,
    /** Phone clock when the lineman saved it (epoch ms); sent as ISO-8601 `recorded_at`. */
    @ColumnInfo(name = "recorded_at") val recordedAt: Long,
    /** India-time day of [recordedAt] (`YYYY-MM-DD`), for the Today totals. */
    @ColumnInfo(name = "business_date") val businessDate: String,
    /** `P-{device_code}-{seq}`, shown until the permanent receipt number arrives (FR-016). */
    @ColumnInfo(name = "provisional_ref") val provisionalRef: String,
    @ColumnInfo(name = "collector_id") val collectorId: String,
    @ColumnInfo(name = "device_id") val deviceId: String,
    val state: PaymentState = PaymentState.SAVED_ON_PHONE,
    /** Push attempts so far, the last one's time (phone clock) and failure code (`ErrorCode` wire or `offline`). */
    @ColumnInfo(name = "attempt_count") val attemptCount: Int = 0,
    @ColumnInfo(name = "last_attempt_at") val lastAttemptAt: Long? = null,
    @ColumnInfo(name = "last_error_code") val lastErrorCode: String? = null,
    /** `ReviewReason` wire value for `posted_needs_review` (or a local hold reason), else null. */
    @ColumnInfo(name = "review_reason") val reviewReason: String? = null,
    /** From the server's `PostedPayment` once posted. */
    @ColumnInfo(name = "receipt_number") val receiptNumber: String? = null,
    @ColumnInfo(name = "posted_at") val postedAt: Long? = null,
    @ColumnInfo(name = "posted_business_date") val postedBusinessDate: String? = null,
    @ColumnInfo(name = "balance_after_paise") val balanceAfterPaise: Long? = null,
    @ColumnInfo(name = "credit_after_paise") val creditAfterPaise: Long? = null,
    /** The posted payment's `allocations` as JSON (receipt line "Oct bill paid, Nov ₹50 left"). */
    @ColumnInfo(name = "allocations_json") val allocationsJson: String? = null,
    /** Phone clock when the server's answer was stored. */
    @ColumnInfo(name = "synced_at") val syncedAt: Long? = null,
)
