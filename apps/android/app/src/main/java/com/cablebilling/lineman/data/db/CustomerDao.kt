package com.cablebilling.lineman.data.db

import androidx.room.ColumnInfo
import androidx.room.Dao
import androidx.room.Embedded
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Relation
import androidx.room.Transaction
import androidx.room.Upsert
import kotlinx.coroutines.flow.Flow

/** SQL shared by the roster queries. */
object RosterQueries {
    /**
     * A payment `p` of customer `c` that the cached server balance does not include yet: still on the
     * phone, or posted after the server last changed this customer's row (the roster has not caught
     * up). Rejected payments (NEEDS_OFFICE_HELP) are not counted: the office sorts them out.
     */
    const val PENDING_FOR_CUSTOMER =
        "(p.state = 'SAVED_ON_PHONE' OR (p.state = 'SENT_TO_OFFICE' AND p.posted_at > c.updated_at))"

    /** Columns of [CustomerSearchRow], plus the pending sums of [PENDING_FOR_CUSTOMER]. */
    const val SEARCH_SELECT =
        "SELECT c.id, c.code, c.name, c.area_name, c.phone, c.balance_paise, c.credit_paise, " +
            "COALESCE(SUM(p.amount_paise), 0) AS pending_paise, COUNT(p.id) AS pending_count " +
            "FROM customers c LEFT JOIN payments p ON p.customer_id = c.id AND " + PENDING_FOR_CUSTOMER + " "
}

/** One search result: what a result row shows, plus the unsynced payments for the projected due. */
data class CustomerSearchRow(
    val id: String,
    val code: String,
    val name: String,
    @ColumnInfo(name = "area_name") val areaName: String?,
    val phone: String?,
    @ColumnInfo(name = "balance_paise") val balancePaise: Long,
    @ColumnInfo(name = "credit_paise") val creditPaise: Long,
    @ColumnInfo(name = "pending_paise") val pendingPaise: Long,
    @ColumnInfo(name = "pending_count") val pendingCount: Int,
)

/** A customer with connections, cached open bills and unsynced payments (customer screen). */
data class CustomerDetailRow(
    @Embedded val customer: CustomerEntity,
    @ColumnInfo(name = "pending_paise") val pendingPaise: Long,
    @ColumnInfo(name = "pending_count") val pendingCount: Int,
    @Relation(parentColumn = "id", entityColumn = "customer_id")
    val connections: List<CustomerVcEntity>,
    @Relation(parentColumn = "id", entityColumn = "customer_id")
    val openBills: List<OpenBillEntity>,
)

/** The stored server version of a customer row. */
data class CustomerVersion(
    val id: String,
    @ColumnInfo(name = "updated_at") val updatedAt: Long,
)

/**
 * Reads of the roster cache. Flows re-run when customers or payments change. Writes are in
 * [RosterWriteDao], used by [RosterStore] only.
 */
@Dao
interface CustomerDao {
    /**
     * Number-pad search: [digits] (ASCII digits only, not empty) anywhere in the code, a phone or a
     * VC number. Order: exact code, a whole phone/VC/code equal to it, a token starting with it, the rest;
     * then by name.
     */
    @Query(
        RosterQueries.SEARCH_SELECT +
            "WHERE c.search_digits LIKE '%' || :digits || '%' GROUP BY c.id " +
            "ORDER BY CASE WHEN c.code = :digits THEN 0 " +
            "WHEN c.search_digits LIKE '% ' || :digits || ' %' THEN 1 " +
            "WHEN c.search_digits LIKE '% ' || :digits || '%' THEN 2 ELSE 3 END, c.name, c.id " +
            "LIMIT :limit",
    )
    fun searchByDigits(
        digits: String,
        limit: Int,
    ): Flow<List<CustomerSearchRow>>

    /**
     * Name search (ABC key): [escapedText] (normalised with [SearchText.normaliseText], then
     * [SearchText.escapeLike]) anywhere in the name or code. Names starting with it first, then
     * names with a word starting with it.
     */
    @Query(
        RosterQueries.SEARCH_SELECT +
            "WHERE c.search_name LIKE '%' || :escapedText || '%' ESCAPE '\\' GROUP BY c.id " +
            "ORDER BY CASE WHEN c.search_name LIKE :escapedText || '%' ESCAPE '\\' THEN 0 " +
            "WHEN c.search_name LIKE '% ' || :escapedText || '%' ESCAPE '\\' THEN 1 ELSE 2 END, c.name, c.id " +
            "LIMIT :limit",
    )
    fun searchByName(
        escapedText: String,
        limit: Int,
    ): Flow<List<CustomerSearchRow>>

    @Transaction
    @Query(
        "SELECT c.*, COALESCE(SUM(p.amount_paise), 0) AS pending_paise, COUNT(p.id) AS pending_count " +
            "FROM customers c LEFT JOIN payments p ON p.customer_id = c.id AND " +
            RosterQueries.PENDING_FOR_CUSTOMER + " WHERE c.id = :id GROUP BY c.id",
    )
    fun observeDetail(id: String): Flow<CustomerDetailRow?>

    @Query("SELECT * FROM customers WHERE id = :id")
    suspend fun get(id: String): CustomerEntity?

    @Query("SELECT COUNT(*) FROM customers")
    suspend fun count(): Int

    @Query("SELECT id FROM customers")
    suspend fun allIds(): List<String>

    /** At most 999 ids per call (SQLite's bind limit on old phones). */
    @Query("SELECT id, updated_at FROM customers WHERE id IN (:ids)")
    suspend fun versions(ids: List<String>): List<CustomerVersion>
}

/**
 * Writes to the roster tables, used only by [RosterStore] (inside its transactions). Nothing here
 * touches `payments`.
 */
@Dao
interface RosterWriteDao {
    @Upsert
    suspend fun upsert(customers: List<CustomerEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertConnections(connections: List<CustomerVcEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertOpenBills(bills: List<OpenBillEntity>)

    /** At most 999 ids per call. */
    @Query("DELETE FROM customer_vcs WHERE customer_id IN (:customerIds)")
    suspend fun deleteConnections(customerIds: List<String>)

    /** At most 999 ids per call. */
    @Query("DELETE FROM open_bills WHERE customer_id IN (:customerIds)")
    suspend fun deleteOpenBills(customerIds: List<String>)

    /** Roster rows only (customers, their connections and bills); payments are never touched. At most 999 ids. */
    @Query("DELETE FROM customers WHERE id IN (:ids)")
    suspend fun deleteCustomers(ids: List<String>)

    @Query("DELETE FROM customers")
    suspend fun deleteAllCustomers()

    @Query("DELETE FROM customer_vcs")
    suspend fun deleteAllConnections()

    @Query("DELETE FROM open_bills")
    suspend fun deleteAllOpenBills()
}
