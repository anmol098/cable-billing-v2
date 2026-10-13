package com.cablebilling.lineman.data.db

import androidx.room.withTransaction
import com.cablebilling.lineman.data.network.generated.CustomerDetailResponse
import com.cablebilling.lineman.data.network.generated.OpenBill
import com.cablebilling.lineman.data.network.generated.RosterCustomer
import com.cablebilling.lineman.data.network.generated.SyncCustomersResponse
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/** The phone's clock, injectable so tests can move time. */
fun interface TimeSource {
    /** Epoch milliseconds, UTC. */
    fun nowMillis(): Long

    companion object {
        val System = TimeSource { java.lang.System.currentTimeMillis() }
    }
}

/** What one applied roster page changed. */
data class PageCounts(
    val upserted: Int,
    val removed: Int,
)

/**
 * Writes to the roster cache, each call one Room transaction: roster pages, customer detail, and
 * the [SyncStreams.ROSTER] bookkeeping. **Never touches `payments`** (or the other queues): a
 * tombstone, a full resync or a change of operator only replaces roster rows.
 *
 * Tenant rule: the roster belongs to the operator in [SyncMetaEntity.scope]. Before writing for
 * another operator, [claimFor] wipes the roster, so one operator's customers never show to another's
 * lineman on a shared phone.
 */
@Singleton
class RosterStore
    @Inject
    constructor(
        private val db: CableDatabase,
        private val time: TimeSource,
    ) {
        private val customers = db.customerDao()
        private val writes = db.rosterWriteDao()
        private val meta = db.syncMetaDao()
        private val mutableSyncing = MutableStateFlow(false)

        /** True while a roster sync runs in this process (set by RosterSync). */
        val syncing: StateFlow<Boolean> = mutableSyncing.asStateFlow()

        fun markSyncing(running: Boolean) {
            mutableSyncing.value = running
        }

        suspend fun rosterMeta(): SyncMetaEntity? = meta.get(SyncStreams.ROSTER)

        /**
         * Makes [operatorId] the owner of the roster. If another operator's roster is stored, it is
         * deleted first (cursor and "updated" time too). Returns the roster's sync row.
         */
        suspend fun claimFor(operatorId: String): SyncMetaEntity =
            db.withTransaction {
                val current = meta.get(SyncStreams.ROSTER)
                if (current?.scope == operatorId) return@withTransaction current
                writes.deleteAllOpenBills()
                writes.deleteAllConnections()
                writes.deleteAllCustomers()
                val fresh =
                    SyncMetaEntity(
                        stream = SyncStreams.ROSTER,
                        scope = operatorId,
                        cursor = null,
                        lastSuccessAt = null,
                        lastServerTime = null,
                        lastAttemptAt = current?.lastAttemptAt,
                        lastFailure = null,
                    )
                meta.upsert(fresh)
                fresh
            }

        /** Notes an attempt and its failure ([failure] null = still running or fine). */
        suspend fun recordAttempt(failure: String?) {
            db.withTransaction {
                val current = meta.get(SyncStreams.ROSTER) ?: return@withTransaction
                meta.upsert(current.copy(lastAttemptAt = time.nowMillis(), lastFailure = failure))
            }
        }

        /** Forgets the cursor (after CURSOR_INVALID): the next sync is a full one. The cached rows stay. */
        suspend fun clearCursor() {
            db.withTransaction {
                val current = meta.get(SyncStreams.ROSTER) ?: return@withTransaction
                meta.upsert(current.copy(cursor = null))
            }
        }

        /**
         * Applies one page of `GET /sync/customers`: upserts customers (ignoring copies older than the
         * stored one), deletes tombstones, and updates the bookkeeping, all in one transaction.
         *
         * @param storeCursor store `next_cursor` (delta sync, or the last page of a full sync).
         * @param finished the sync is complete with this page: set "updated at" to now.
         * @param keepOnly last page of a full sync: every customer whose id is not in this set (all
         *   ids received in this full sync) is dropped, so the roster equals the server's.
         */
        suspend fun applyPage(
            page: SyncCustomersResponse,
            storeCursor: Boolean,
            finished: Boolean,
            keepOnly: Set<String>? = null,
        ): PageCounts =
            db.withTransaction {
                val now = time.nowMillis()
                val (active, inactive) = page.customers.partition { it.active }
                val upserted = upsertNewer(active, now)
                var removed = delete(page.removedCustomerIds + inactive.map { it.id })
                if (keepOnly != null) removed += delete(customers.allIds().filterNot { it in keepOnly })
                val current = meta.get(SyncStreams.ROSTER) ?: error("claimFor() must run before applyPage()")
                meta.upsert(
                    current.copy(
                        cursor = if (storeCursor) page.nextCursor else current.cursor,
                        lastSuccessAt = if (finished) now else current.lastSuccessAt,
                        lastServerTime = if (finished) parseInstant(page.serverTime) else current.lastServerTime,
                        lastAttemptAt = now,
                        lastFailure = null,
                    ),
                )
                PageCounts(upserted = upserted, removed = removed)
            }

        /**
         * Stores a fresh `GET /customers/{id}` answer for [operatorId]'s roster: the customer row (unless
         * the stored copy is newer) and its open bills; an inactive customer is dropped from the roster.
         */
        suspend fun storeDetail(
            operatorId: String,
            detail: CustomerDetailResponse,
        ) {
            claimFor(operatorId)
            db.withTransaction {
                val customer = detail.customer
                if (!customer.active) {
                    delete(listOf(customer.id))
                    return@withTransaction
                }
                val now = time.nowMillis()
                if (upsertNewer(listOf(customer), now) == 0) return@withTransaction
                writes.deleteOpenBills(listOf(customer.id))
                writes.insertOpenBills(detail.openBills.map { it.toEntity(customer.id, now) })
            }
        }

        /** Drops one customer from [operatorId]'s roster (the server says it does not exist: CUSTOMER_NOT_FOUND). */
        suspend fun removeCustomer(
            operatorId: String,
            customerId: String,
        ) {
            claimFor(operatorId)
            db.withTransaction { delete(listOf(customerId)) }
        }

        /** Upserts [incoming] except where the stored copy is newer; replaces their connections. */
        private suspend fun upsertNewer(
            incoming: List<RosterCustomer>,
            now: Long,
        ): Int {
            if (incoming.isEmpty()) return 0
            val stored =
                incoming
                    .map { it.id }
                    .chunked(SQL_CHUNK)
                    .flatMap { customers.versions(it) }
                    .associate { it.id to it.updatedAt }
            val accepted =
                incoming
                    .associateBy { it.id }
                    .values
                    .filter { customer -> stored[customer.id]?.let { it <= parseInstant(customer.updatedAt) } ?: true }
            if (accepted.isNotEmpty()) {
                // A changed customer's cached bills may be out of date: they are fetched again with the detail.
                val changed = accepted.filter { stored[it.id] != null && stored[it.id] != parseInstant(it.updatedAt) }
                changed.map { it.id }.chunked(SQL_CHUNK).forEach { writes.deleteOpenBills(it) }
                accepted.map { it.id }.chunked(SQL_CHUNK).forEach { writes.deleteConnections(it) }
                writes.upsert(accepted.map { it.toEntity(now) })
                writes.insertConnections(accepted.flatMap { it.connectionEntities() })
            }
            return accepted.size
        }

        /** Deletes roster rows (customer, connections, bills) for [ids]; returns how many customers existed. */
        private suspend fun delete(ids: List<String>): Int {
            if (ids.isEmpty()) return 0
            var existed = 0
            ids.distinct().chunked(SQL_CHUNK).forEach { chunk ->
                existed += customers.versions(chunk).size
                writes.deleteOpenBills(chunk)
                writes.deleteConnections(chunk)
                writes.deleteCustomers(chunk)
            }
            return existed
        }

        companion object {
            /** Ids per `IN (…)`: under SQLite's 999 bind-variable limit of older Android versions. */
            const val SQL_CHUNK = 500

            /** An ISO-8601 instant with `Z` (the contract's only form) as epoch ms. */
            fun parseInstant(iso: String): Long = Instant.parse(iso).toEpochMilli()
        }
    }

/** The cached row for a roster customer (search columns computed here). */
internal fun RosterCustomer.toEntity(now: Long): CustomerEntity =
    CustomerEntity(
        id = id,
        code = code,
        name = name,
        phone = phone,
        altPhone = altPhone,
        address = address,
        areaId = area?.id,
        areaName = area?.name,
        balancePaise = balancePaise,
        creditPaise = creditPaise,
        openBillCount = openBills.count,
        openBillsOutstandingPaise = openBills.outstandingPaise,
        oldestOpenPeriod = openBills.oldestPeriod,
        updatedAt = RosterStore.parseInstant(updatedAt),
        cachedAt = now,
        searchDigits = SearchText.digitsColumn(code, listOf(phone, altPhone), connections.map { it.vcNumber }),
        searchName = SearchText.nameColumn(name, code),
    )

internal fun RosterCustomer.connectionEntities(): List<CustomerVcEntity> =
    connections.mapIndexed { index, connection ->
        CustomerVcEntity(
            customerId = id,
            position = index,
            vcNumber = connection.vcNumber,
            status = connection.status.wire,
        )
    }

internal fun OpenBill.toEntity(
    customerId: String,
    now: Long,
): OpenBillEntity =
    OpenBillEntity(
        invoiceId = invoiceId,
        customerId = customerId,
        invoiceNumber = invoiceNumber,
        kind = kind.wire,
        period = period,
        chargesPaise = chargesPaise,
        outstandingPaise = outstandingPaise,
        cachedAt = now,
    )
