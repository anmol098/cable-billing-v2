package com.cablebilling.lineman.data.db

import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.network.ApiErrorParser
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.MobileApi
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.generated.CustomerDetailResponse
import com.cablebilling.lineman.data.network.generated.ErrorCode
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import javax.inject.Inject
import javax.inject.Singleton

/**
 * A customer's balance as the phone should show it (PLAN §11.5): the server's balance minus the
 * payments this phone has that the server balance does not include yet. Label it "including payments
 * saved on phone" when [includesPhonePayments].
 */
data class ProjectedBalance(
    /** Signed server balance (positive = owes). */
    val serverBalancePaise: Long,
    /** Advance on the server. */
    val serverCreditPaise: Long,
    /** Sum of the phone's not-yet-included payments ([RosterQueries.PENDING_FOR_CUSTOMER]). */
    val pendingPaise: Long,
    val pendingCount: Int,
) {
    /** Server balance minus the phone's payments (negative = paid in advance). */
    val balancePaise: Long get() = serverBalancePaise - pendingPaise

    /** What is due now: never below zero. Show it large and red. */
    val duePaise: Long get() = balancePaise.coerceAtLeast(0)

    /** Advance after the phone's payments: the server's credit plus any phone money beyond the due. */
    val creditPaise: Long get() =
        serverCreditPaise +
            (pendingPaise - serverBalancePaise.coerceAtLeast(0)).coerceAtLeast(0)

    val includesPhonePayments: Boolean get() = pendingCount > 0
}

/** One search result row. */
data class CustomerSummary(
    val id: String,
    val code: String,
    val name: String,
    val areaName: String?,
    val phone: String?,
    val balance: ProjectedBalance,
)

/** Everything cached about one customer (customer screen). */
data class CustomerDetail(
    val customer: CustomerEntity,
    /** Current connections in the server's order; `connections.size` is the connection count. */
    val connections: List<CustomerVcEntity>,
    /**
     * Unpaid bills from the last online detail, oldest month first. Empty if never fetched: the roster
     * only has the summary ([CustomerEntity.openBillCount]); [RosterRepository.refreshCustomer] fills it.
     */
    val openBills: List<OpenBillEntity>,
    val balance: ProjectedBalance,
)

/**
 * How fresh the roster is, for the sync banner ("Updated 5 min ago" / "3 payments on phone").
 * Works offline: it only reads Room.
 */
data class RosterSyncStatus(
    /** Phone clock (epoch ms) of the last complete roster sync for the signed-in operator, null if never. */
    val lastUpdatedAt: Long?,
    /** Whole minutes since [lastUpdatedAt] at the time of this value (0 if the clock went back), null if never. */
    val minutesAgo: Long?,
    /** A roster sync is running now. */
    val syncing: Boolean,
    /** Why the last attempt failed (`offline`, `server:<CODE>` …), null if it worked or none ran. */
    val lastFailure: String?,
    /** Payments still on the phone (state SAVED_ON_PHONE). */
    val savedOnPhoneCount: Int,
)

/**
 * The read side of the roster cache for the screens (T-065 search + customer, T-066 collect): Room
 * Flows that work offline with the last synced data, and an online refresh of one customer.
 *
 * Only the signed-in operator's roster is ever returned: while the stored roster belongs to another
 * operator (before the first sync after a different operator's lineman signed in), searches are empty.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@Singleton
class RosterRepository
    @Inject
    constructor(
        db: CableDatabase,
        private val store: RosterStore,
        private val sessions: SessionStore,
        private val api: MobileApi,
        private val errors: ApiErrorParser,
        private val time: TimeSource,
    ) {
        private val customers = db.customerDao()
        private val payments = db.paymentDao()
        private val rosterMeta = db.syncMetaDao().observe(SyncStreams.ROSTER)

        private val operatorId: Flow<String?> =
            sessions.state.map { (it as? SessionState.SignedIn)?.session?.operator?.id }.distinctUntilChanged()

        /** The roster row of the signed-in operator, or null (signed out, never synced, or another operator's). */
        private val ownMeta: Flow<SyncMetaEntity?> =
            combine(
                operatorId,
                rosterMeta,
            ) { operator, meta -> meta?.takeIf { operator != null && it.scope == operator } }

        private val rosterVisible: Flow<Boolean> = ownMeta.map { it != null }.distinctUntilChanged()

        /**
         * Customers matching [query], best first, at most [limit]. Digits only (number pad): any part of
         * the code, a phone or a VC number. With letters (ABC key): any part of the name or code. Blank: empty.
         */
        fun search(
            query: String,
            limit: Int = DEFAULT_SEARCH_LIMIT,
        ): Flow<List<CustomerSummary>> {
            val trimmed = query.trim()
            val digits = SearchText.digitsOnly(trimmed)
            val rows: Flow<List<CustomerSearchRow>> =
                when {
                    trimmed.any { it.isLetter() } -> {
                        customers.searchByName(SearchText.escapeLike(SearchText.normaliseText(trimmed)), limit)
                    }

                    digits.isNotEmpty() -> {
                        customers.searchByDigits(digits, limit)
                    }

                    else -> {
                        return flowOf(emptyList())
                    }
                }
            return rosterVisible.flatMapLatest { visible ->
                if (visible) rows.map { list -> list.map { it.toSummary() } } else flowOf(emptyList())
            }
        }

        /** One cached customer with the projected balance, or null if not in the roster. Updates live. */
        fun customer(id: String): Flow<CustomerDetail?> =
            rosterVisible.flatMapLatest { visible ->
                if (!visible) {
                    flowOf(null)
                } else {
                    customers.observeDetail(id).map { row -> row?.toDetail() }
                }
            }

        /**
         * Fetches `GET /customers/{id}` and stores it (row + open bills); the [customer] Flow then
         * updates. Offline it fails with [ApiFailure.Offline] and the cached data stays. If the server
         * says CUSTOMER_NOT_FOUND, the customer is dropped from the phone's roster.
         */
        suspend fun refreshCustomer(id: String): ApiResult<CustomerDetailResponse> {
            sessions.load()
            val operator =
                sessions.session?.operator?.id
                    ?: return ApiResult.Failure(ApiFailure.SignedOut(SignOutReason.SIGNED_OUT))
            val result = apiCall(errors) { api.getCustomer(id) }
            when (result) {
                is ApiResult.Success -> {
                    store.storeDetail(operator, result.value)
                }

                is ApiResult.Failure -> {
                    val failure = result.failure
                    if (failure is ApiFailure.Server && failure.knownCode == ErrorCode.CUSTOMER_NOT_FOUND) {
                        store.removeCustomer(operator, id)
                    }
                }
            }
            return result
        }

        /**
         * The sync banner's data, re-emitted at least every [tickMillis] so "X min ago" stays current.
         * Reads only Room, so it works in airplane mode.
         */
        fun syncStatus(tickMillis: Long = STATUS_TICK_MS): Flow<RosterSyncStatus> {
            val ticker =
                flow {
                    while (true) {
                        emit(time.nowMillis())
                        delay(tickMillis)
                    }
                }
            return combine(
                ownMeta,
                payments.observeSavedOnPhoneCount(),
                store.syncing,
                ticker,
            ) { meta, count, syncing, now ->
                val last = meta?.lastSuccessAt
                RosterSyncStatus(
                    lastUpdatedAt = last,
                    minutesAgo = last?.let { ((now - it) / MS_PER_MINUTE).coerceAtLeast(0) },
                    syncing = syncing,
                    lastFailure = meta?.lastFailure,
                    savedOnPhoneCount = count,
                )
            }.distinctUntilChanged()
        }

        companion object {
            const val DEFAULT_SEARCH_LIMIT = 50
            const val STATUS_TICK_MS = 30_000L
            private const val MS_PER_MINUTE = 60_000L
        }
    }

private fun CustomerSearchRow.toSummary() =
    CustomerSummary(
        id = id,
        code = code,
        name = name,
        areaName = areaName,
        phone = phone,
        balance = ProjectedBalance(balancePaise, creditPaise, pendingPaise, pendingCount),
    )

private fun CustomerDetailRow.toDetail() =
    CustomerDetail(
        customer = customer,
        connections = connections.sortedBy { it.position },
        openBills = openBills.sortedWith(compareBy({ it.period }, { it.invoiceNumber })),
        balance = ProjectedBalance(customer.balancePaise, customer.creditPaise, pendingPaise, pendingCount),
    )
