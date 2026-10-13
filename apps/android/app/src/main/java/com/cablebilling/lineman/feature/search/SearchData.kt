package com.cablebilling.lineman.feature.search

import com.cablebilling.lineman.data.db.CustomerSummary
import com.cablebilling.lineman.data.db.RosterRepository
import com.cablebilling.lineman.data.db.RosterSyncStatus
import com.cablebilling.lineman.data.sync.RosterSyncScheduler
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.android.components.ViewModelComponent
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject

/**
 * What the search home reads and asks for. The app uses [RosterSearchData] (the offline roster from
 * T-064); ViewModel tests use a fake.
 */
interface SearchData {
    /** Best matches for [query], at most [SEARCH_LIMIT]; digits only = number-pad search, letters = name search. */
    fun search(query: String): Flow<List<CustomerSummary>>

    /** The sync banner's data ("Updated 5 min ago", payments on phone). Works offline. */
    fun syncStatus(): Flow<RosterSyncStatus>

    /** Pull the customer list again as soon as there is internet. */
    fun requestSync()

    companion object {
        /** Rows shown at most; more means "type more" (the roster ranks the best matches first). */
        const val SEARCH_LIMIT = RosterRepository.DEFAULT_SEARCH_LIMIT
    }
}

/** [SearchData] on the phone's roster cache ([RosterRepository]) and the roster sync ([RosterSyncScheduler]). */
class RosterSearchData
    @Inject
    constructor(
        private val roster: RosterRepository,
        private val scheduler: RosterSyncScheduler,
    ) : SearchData {
        override fun search(query: String): Flow<List<CustomerSummary>> = roster.search(query, SearchData.SEARCH_LIMIT)

        override fun syncStatus(): Flow<RosterSyncStatus> = roster.syncStatus()

        override fun requestSync() = scheduler.requestNow()
    }

@Module
@InstallIn(ViewModelComponent::class)
abstract class SearchDataModule {
    @Binds
    abstract fun bindSearchData(impl: RosterSearchData): SearchData
}
