package com.cablebilling.lineman.durability

import android.content.ContentValues
import android.database.sqlite.SQLiteDatabase
import androidx.sqlite.db.SupportSQLiteDatabase
import com.cablebilling.lineman.durability.DurabilityFixtures.DAY
import com.cablebilling.lineman.durability.DurabilityFixtures.OPERATOR_ID
import com.cablebilling.lineman.durability.DurabilityFixtures.customerId
import com.cablebilling.lineman.durability.DurabilityFixtures.mohan
import com.cablebilling.lineman.durability.DurabilityFixtures.suresh

/**
 * A phone's database as an older app version left it: rows in **every** table, written with raw SQL in
 * that version's columns (the app's classes may already look different). The migration suite creates
 * each exported schema version with these rows, upgrades it to the current version and reads it back
 * with the current DAOs and JSON classes ([RoomMigrationSuiteTest]).
 *
 * **Adding schema version N** (bump `CableDatabase.VERSION`, add `Migration(N-1, N)`): add `N to ::seedVN`
 * to [byVersion], writing the same logical data in version N's columns, and extend
 * `RoomMigrationSuiteTest.assertTheSeedSurvived` for the new columns. The suite fails while a version
 * has no seed, so no schema version ships without a migration test.
 */
object MigrationSeeds {
    /** Every exported schema version → how to fill a database of that version. */
    val byVersion: Map<Int, (SupportSQLiteDatabase) -> Unit> = mapOf(1 to ::seedV1)

    const val CUSTOMER_CODE = "1045"
    val customer: String = customerId(1045)
    const val ON_PHONE = "01929a3e-5b10-7c4e-8a06-000000000001"
    const val SENT = "01929a3e-5b10-7c4e-8a06-000000000002"
    const val REFUSED = "01929a3e-5b10-7c4e-8a06-000000000003"
    const val HELD = "01929a3e-5b10-7c4e-8a06-000000000004"
    const val ACTION = "01929a3e-5b10-7c4e-8a07-000000000001"
    const val SUBMISSION = "0192ab00-0000-7000-8000-000000000001"
    const val CURSOR = "c_2026-10-13T03:00:00.000Z_123"

    /** Customer row's server `updated_at` (epoch ms). SENT was posted before it, so it no longer counts as pending. */
    const val UPDATED_AT = 1_760_340_000_000L
    const val POSTED_AT = 1_760_330_000_000L
    const val RECORDED_AT = 1_760_331_000_000L

    /** `queued_handover_json` as T-070 writes it (QueuedHandover). */
    const val QUEUED_HANDOVER_JSON =
        """{"request":{"submission_id":"$SUBMISSION","cash_handed_over_paise":80000,""" +
            """"discrepancy_reason":"pending_sync","unsynced_payment_count":1,"unsynced_cash_paise":45000},""" +
            """"queued_at":1760346000000,"state":"waiting","attempt_count":2,"last_attempt_at":1760346060000,""" +
            """"last_error_code":"offline"}"""

    /** `handover_json` as T-070 stores the server's `Handover`. */
    const val HANDOVER_JSON =
        """{"submission_id":"0192ab00-0000-7000-8000-000000000000","cash_expected_paise":35000,""" +
            """"cash_handed_over_paise":30000,"discrepancy_paise":-5000,"discrepancy_reason":"short",""" +
            """"unsynced_payment_count":0,"unsynced_cash_paise":0,"submitted_at":"2026-10-13T10:00:00.000Z",""" +
            """"reviewed_at":"2026-10-13T10:30:00.000Z","review_note":"count again"}"""

    /** `allocations_json` as T-066 stores a posted payment's allocations. */
    const val ALLOCATIONS_JSON =
        """[{"invoice_id":"01929a3e-5b10-7c4e-8a04-000000000001","invoice_number":"INV-2609-00098",""" +
            """"kind":"regular","period":"2026-09-01","amount_paise":35000,"outstanding_after_paise":55000}]"""

    /** Version 1 (T-064 … T-071). */
    fun seedV1(db: SupportSQLiteDatabase) {
        rosterV1(db)
        paymentsV1(db)
        outboxesV1(db)
    }

    private fun rosterV1(db: SupportSQLiteDatabase) {
        db.put(
            "customers",
            "id" to customer,
            "code" to CUSTOMER_CODE,
            "name" to "Ramesh Kumar",
            "phone" to "9876543210",
            "area_name" to "Ward 4",
            "balance_paise" to 90_000L,
            "credit_paise" to 0L,
            "open_bill_count" to 1,
            "open_bills_outstanding_paise" to 90_000L,
            "oldest_open_period" to "2026-09-01",
            "updated_at" to UPDATED_AT,
            "cached_at" to UPDATED_AT,
            "search_digits" to " 1045 9876543210 1234567890 ",
            "search_name" to "ramesh kumar",
        )
        db.put(
            "customer_vcs",
            "customer_id" to customer,
            "position" to 0,
            "vc_number" to "1234567890",
            "status" to "active",
        )
        db.put(
            "open_bills",
            "invoice_id" to "01929a3e-5b10-7c4e-8a04-000000000002",
            "customer_id" to customer,
            "invoice_number" to "INV-2610-00120",
            "kind" to "regular",
            "period" to "2026-10-01",
            "charges_paise" to 90_000L,
            "outstanding_paise" to 90_000L,
            "cached_at" to UPDATED_AT,
        )
    }

    private fun paymentsV1(db: SupportSQLiteDatabase) {
        db.payment(ON_PHONE, "P-K7Q-0001", 45_000L, "cash", "SAVED_ON_PHONE", suresh.id)
        db.payment(
            SENT,
            "P-K7Q-0002",
            35_000L,
            "cash",
            "SENT_TO_OFFICE",
            suresh.id,
            "receipt_number" to "R-2610-00045",
            "posted_at" to POSTED_AT,
            "posted_business_date" to DAY,
            "balance_after_paise" to 55_000L,
            "credit_after_paise" to 0L,
            "allocations_json" to ALLOCATIONS_JSON,
            "synced_at" to POSTED_AT,
        )
        db.payment(
            REFUSED,
            "P-K7Q-0003",
            10_000L,
            "cash",
            "NEEDS_OFFICE_HELP",
            suresh.id,
            "last_error_code" to "CUSTOMER_NOT_FOUND",
        )
        db.payment(HELD, "P-K7Q-0004", 20_000L, "upi", "SAVED_ON_PHONE", mohan.id, "upi_reference" to "412345678901")
    }

    private fun outboxesV1(db: SupportSQLiteDatabase) {
        db.put(
            "receipt_actions_outbox",
            "id" to ACTION,
            "payment_id" to SENT,
            "action" to "printed",
            "at" to POSTED_AT,
            "state" to "PENDING",
            "attempt_count" to 1,
        )
        db.put(
            "collection_day",
            "collector_id" to suresh.id,
            "business_date" to DAY,
            "cash_total_paise" to 35_000L,
            "upi_total_paise" to 0L,
            "payment_count" to 1L,
            "status" to "returned",
            "handover_json" to HANDOVER_JSON,
            "server_time" to POSTED_AT,
            "cached_at" to POSTED_AT,
            "queued_handover_json" to QUEUED_HANDOVER_JSON,
        )
        db.put(
            "sync_meta",
            "stream" to "roster",
            "scope" to OPERATOR_ID,
            "cursor" to CURSOR,
            "last_success_at" to UPDATED_AT,
            "last_server_time" to UPDATED_AT,
            "last_attempt_at" to UPDATED_AT,
        )
    }

    private fun SupportSQLiteDatabase.payment(
        id: String,
        ref: String,
        amountPaise: Long,
        method: String,
        state: String,
        collectorId: String,
        vararg extra: Pair<String, Any?>,
    ) = put(
        "payments",
        "id" to id,
        "customer_id" to customer,
        "customer_code" to CUSTOMER_CODE,
        "customer_name" to "Ramesh Kumar",
        "amount_paise" to amountPaise,
        "method" to method,
        "recorded_at" to RECORDED_AT,
        "business_date" to DAY,
        "provisional_ref" to ref,
        "collector_id" to collectorId,
        "device_id" to DurabilityFixtures.DEVICE_ID,
        "state" to state,
        "attempt_count" to 0,
        *extra,
    )

    private fun SupportSQLiteDatabase.put(
        table: String,
        vararg columns: Pair<String, Any?>,
    ) {
        val values = ContentValues()
        columns.forEach { (name, value) ->
            when (value) {
                null -> values.putNull(name)
                is String -> values.put(name, value)
                is Int -> values.put(name, value)
                is Long -> values.put(name, value)
                else -> error("unsupported value for $name")
            }
        }
        insert(table, SQLiteDatabase.CONFLICT_ABORT, values)
    }
}
