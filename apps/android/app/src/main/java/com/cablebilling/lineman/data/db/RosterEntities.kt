package com.cablebilling.lineman.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/*
 * The cached customer roster (PLAN §10.3, §11.5). Server data only: rows are replaced by roster
 * sync (`GET /sync/customers`) and by customer detail (`GET /customers/{id}`), and dropped for
 * tombstones. Nothing the lineman does is stored here (payments live in `payments`).
 *
 * Storage conventions for every table of [CableDatabase]:
 * - money: `*_paise` INTEGER (Long), never floating point;
 * - instants: `*_at` INTEGER, epoch milliseconds UTC (parsed from / formatted to ISO-8601 `Z` at the
 *   network edge). `updated_at`/`posted_at` are server clock; `cached_at`/`recorded_at` are phone clock;
 * - India-time dates and bill months: TEXT `YYYY-MM-DD` as on the wire;
 * - enums: TEXT with the contract's wire value (see [Converters]).
 */

/** One customer as last heard from the server (`RosterCustomer`). */
@Entity(
    tableName = "customers",
    indices = [Index("code"), Index("name"), Index("phone")],
)
data class CustomerEntity(
    @PrimaryKey val id: String,
    val code: String,
    val name: String,
    val phone: String?,
    @ColumnInfo(name = "alt_phone") val altPhone: String?,
    val address: String?,
    @ColumnInfo(name = "area_id") val areaId: String?,
    @ColumnInfo(name = "area_name") val areaName: String?,
    /** Signed ledger balance on the server: positive = owes this much; zero or negative = nothing due. */
    @ColumnInfo(name = "balance_paise") val balancePaise: Long,
    /** Advance (credit) on the server, not yet used for any bill. */
    @ColumnInfo(name = "credit_paise") val creditPaise: Long,
    @ColumnInfo(name = "open_bill_count") val openBillCount: Long,
    @ColumnInfo(name = "open_bills_outstanding_paise") val openBillsOutstandingPaise: Long,
    /** Month of the oldest unpaid bill (`YYYY-MM-01`), or null. */
    @ColumnInfo(name = "oldest_open_period") val oldestOpenPeriod: String?,
    /** Server `updated_at` (epoch ms). A copy older than the stored one is ignored. */
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
    /** Phone clock (epoch ms) when this copy was stored. */
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
    /**
     * Digits of the code, phones and VC numbers, each as its own space-separated token, for the
     * number-pad search (`LIKE '%digits%'`; a token boundary is never matched across). See [SearchText].
     */
    @ColumnInfo(name = "search_digits") val searchDigits: String,
    /** Lower-case, space-normalised name and code for the ABC (name) search. See [SearchText]. */
    @ColumnInfo(name = "search_name") val searchName: String,
)

/** One current connection (VC card) of a customer, in the server's order ([position]). */
@Entity(
    tableName = "customer_vcs",
    primaryKeys = ["customer_id", "position"],
    indices = [Index("vc_number")],
)
data class CustomerVcEntity(
    @ColumnInfo(name = "customer_id") val customerId: String,
    val position: Int,
    @ColumnInfo(name = "vc_number") val vcNumber: String,
    /** `active` or `suspended` (ConnectionStatus wire value). */
    val status: String,
)

/**
 * An unpaid bill from the last `GET /customers/{id}` (the roster only has the summary). Dropped when
 * a newer roster copy of the customer arrives, because it may be out of date by then.
 */
@Entity(tableName = "open_bills", indices = [Index("customer_id")])
data class OpenBillEntity(
    @PrimaryKey @ColumnInfo(name = "invoice_id") val invoiceId: String,
    @ColumnInfo(name = "customer_id") val customerId: String,
    @ColumnInfo(name = "invoice_number") val invoiceNumber: String,
    /** `regular` or `opening_balance` (BillKind wire value). */
    val kind: String,
    /** Bill month, `YYYY-MM-01`. */
    val period: String,
    @ColumnInfo(name = "charges_paise") val chargesPaise: Long,
    @ColumnInfo(name = "outstanding_paise") val outstandingPaise: Long,
    /** Phone clock (epoch ms) when the detail was fetched. */
    @ColumnInfo(name = "cached_at") val cachedAt: Long,
)
