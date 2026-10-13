package com.cablebilling.lineman.data.sync

import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.PageCounts
import com.cablebilling.lineman.data.db.RosterStore
import com.cablebilling.lineman.data.network.ApiErrorParser
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.MobileApi
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.SyncCustomersResponse
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.time.DateTimeException
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/** How a roster sync ended. */
sealed interface RosterSyncResult {
    /** The roster is up to date with the server. */
    data class Synced(
        /** It was a full sync (first sync, after CURSOR_INVALID, or after another operator's lineman). */
        val fullSync: Boolean,
        val pages: Int,
        val upserted: Int,
        val removed: Int,
    ) : RosterSyncResult

    /** Nobody is signed in: nothing to do. */
    data object NotSignedIn : RosterSyncResult

    /** Stopped by [failure]; whatever pages arrived before it are kept, and the cached roster stays usable. */
    data class Failed(
        val failure: ApiFailure,
    ) : RosterSyncResult
}

/** Worth trying again soon: no connection, or a temporary server problem (429 / 5xx). */
val ApiFailure.isRetryable: Boolean
    get() = this is ApiFailure.Offline || (this is ApiFailure.Server && isTemporary)

/** Short code stored in `sync_meta.last_failure` (diagnostics, banner wording). */
val ApiFailure.syncCode: String
    get() =
        when (this) {
            is ApiFailure.Offline -> "offline"
            is ApiFailure.Server -> "server:$code"
            ApiFailure.AppTooOld -> "app_too_old"
            is ApiFailure.SignedOut -> "signed_out"
            is ApiFailure.Malformed -> "malformed"
        }

/**
 * Pulls the customer roster (`GET /sync/customers`, PLAN §10.3, packages/contracts `sync.ts`):
 *
 * - **Full sync** when there is no cursor (first sync, after CURSOR_INVALID, or when the stored roster
 *   belongs to another operator, which [RosterStore.claimFor] wipes first): pages until `has_more` is
 *   false; the last page also drops every customer not received, then stores `next_cursor`. Pages are
 *   committed one by one, so a big first sync is searchable while it runs; an interrupted full sync
 *   keeps no cursor and starts again next time.
 * - **Delta sync** from the stored cursor: each page upserts changed customers, deletes tombstones
 *   and stores `next_cursor` in the same transaction.
 *
 * Local payments are never touched. One sync runs at a time; [markStale] during a run makes it pull
 * once more at the end (a payment push finished meanwhile). Call it through [RosterSyncWorker] /
 * [RosterSyncScheduler]; tests call [run] directly.
 */
@Singleton
class RosterSync
    @Inject
    constructor(
        private val api: MobileApi,
        private val errors: ApiErrorParser,
        private val sessions: SessionStore,
        private val store: RosterStore,
    ) {
        private val mutex = Mutex()
        private val stale = AtomicBoolean(false)

        /** Asks for one more pull after the running one (or the next one) finishes. */
        fun markStale() {
            stale.set(true)
        }

        suspend fun run(): RosterSyncResult =
            mutex.withLock {
                store.markSyncing(true)
                try {
                    var rounds = 0
                    var result: RosterSyncResult
                    do {
                        stale.set(false)
                        result = syncOnce()
                        rounds++
                    } while (result is RosterSyncResult.Synced && stale.get() && rounds < MAX_ROUNDS)
                    result
                } finally {
                    store.markSyncing(false)
                }
            }

        private suspend fun syncOnce(): RosterSyncResult {
            sessions.load()
            val operatorId = sessions.session?.operator?.id ?: return RosterSyncResult.NotSignedIn
            val cursor = store.claimFor(operatorId).cursor
            val result =
                try {
                    if (cursor == null) fullSync() else deltaSync(cursor)
                } catch (e: DateTimeException) {
                    // An instant that is not ISO-8601 with Z: the body does not match the contract.
                    RosterSyncResult.Failed(ApiFailure.Malformed(e))
                }
            if (result is RosterSyncResult.Failed) store.recordAttempt(result.failure.syncCode)
            return result
        }

        private suspend fun deltaSync(start: String): RosterSyncResult {
            var total = PageCounts(0, 0)
            val paged =
                fetchPages(start) { page ->
                    total += store.applyPage(page, storeCursor = true, finished = !page.hasMore)
                }
            val failure = paged.failure
            return if (failure is ApiFailure.Server && failure.knownCode == ErrorCode.CURSOR_INVALID) {
                store.clearCursor()
                fullSync()
            } else {
                paged.result(fullSync = false, total)
            }
        }

        private suspend fun fullSync(): RosterSyncResult {
            var total = PageCounts(0, 0)
            val received = HashSet<String>()
            val paged =
                fetchPages(null) { page ->
                    page.customers.filter { it.active }.mapTo(received) { it.id }
                    received.removeAll(page.removedCustomerIds.toSet())
                    total +=
                        if (page.hasMore) {
                            store.applyPage(page, storeCursor = false, finished = false)
                        } else {
                            store.applyPage(page, storeCursor = true, finished = true, keepOnly = received)
                        }
                }
            return paged.result(fullSync = true, total)
        }

        /** Requests pages from [start] until `has_more` is false (or a failure), giving each to [onPage]. */
        private suspend fun fetchPages(
            start: String?,
            onPage: suspend (SyncCustomersResponse) -> Unit,
        ): Paged {
            var cursor = start
            var pages = 0
            var failure: ApiFailure? = null
            var more = true
            while (more && failure == null) {
                if (pages == MAX_PAGES) {
                    // The server kept answering has_more (a server bug): stop instead of looping forever.
                    failure = ApiFailure.Malformed(IllegalStateException("More than $MAX_PAGES roster pages"))
                } else {
                    when (val fetched = fetch(cursor)) {
                        is ApiResult.Failure -> {
                            failure = fetched.failure
                        }

                        is ApiResult.Success -> {
                            pages++
                            onPage(fetched.value)
                            more = fetched.value.hasMore
                            cursor = fetched.value.nextCursor
                        }
                    }
                }
            }
            return Paged(pages, failure)
        }

        /** How a run of pages ended: [pages] applied, then [failure] (null = reached the end). */
        private data class Paged(
            val pages: Int,
            val failure: ApiFailure?,
        ) {
            fun result(
                fullSync: Boolean,
                total: PageCounts,
            ): RosterSyncResult =
                failure?.let { RosterSyncResult.Failed(it) }
                    ?: RosterSyncResult.Synced(fullSync, pages, total.upserted, total.removed)
        }

        private suspend fun fetch(cursor: String?): ApiResult<SyncCustomersResponse> =
            apiCall(errors) { api.syncCustomers(cursor = cursor, limit = PAGE_SIZE) }

        private operator fun PageCounts.plus(other: PageCounts) =
            PageCounts(upserted + other.upserted, removed + other.removed)

        companion object {
            /** Rows per page (the contract's maximum). */
            const val PAGE_SIZE = 500

            /** 200 pages × 500 = 100,000 customers: far above any operator; a guard against a looping server. */
            const val MAX_PAGES = 200

            /** At most this many pulls per run when [markStale] keeps being called. */
            const val MAX_ROUNDS = 3
        }
    }
