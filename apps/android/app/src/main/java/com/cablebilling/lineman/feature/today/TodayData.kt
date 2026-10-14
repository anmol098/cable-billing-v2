package com.cablebilling.lineman.feature.today

import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.TimeSource
import com.cablebilling.lineman.data.network.generated.HandoverRequest
import com.cablebilling.lineman.data.payments.UuidV7
import dagger.Binds
import dagger.Module
import dagger.hilt.InstallIn
import dagger.hilt.android.components.ViewModelComponent
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.Serializable
import javax.inject.Inject

/** The handover flow for one India-time day (`YYYY-MM-DD`), on the Today tab's stack. */
@Serializable
data class HandoverRoute(
    val businessDate: String,
)

/** What the Today and handover screens read and do (the app: [AppTodayData]; ViewModel tests: a fake). */
interface TodayData {
    fun session(): Flow<SessionState>

    /** [collectorId]'s day [businessDate], live. */
    fun day(
        collectorId: String,
        businessDate: String,
    ): Flow<DayInputs>

    /** Asks the office for the signed-in lineman's day. */
    suspend fun refresh(businessDate: String): RefreshResult

    /** Saves the handover on the phone (commits before returning), then asks for a send. */
    suspend fun queueHandover(
        businessDate: String,
        request: HandoverRequest,
    ): QueueResult

    /** Sends the waiting handovers now (and in the background if that cannot finish). */
    fun sendNow()

    /** A new submission id (UUIDv7), made before the handover is saved. */
    fun newSubmissionId(): String

    /** Phone clock, epoch ms UTC. */
    fun nowMillis(): Long
}

class AppTodayData
    @Inject
    constructor(
        private val sessions: SessionStore,
        private val repository: TodayRepository,
        private val scheduler: HandoverSyncScheduler,
        private val time: TimeSource,
    ) : TodayData {
        override fun session(): Flow<SessionState> = sessions.state

        override fun day(
            collectorId: String,
            businessDate: String,
        ): Flow<DayInputs> = repository.observeDay(collectorId, businessDate)

        override suspend fun refresh(businessDate: String): RefreshResult = repository.refresh(businessDate)

        override suspend fun queueHandover(
            businessDate: String,
            request: HandoverRequest,
        ): QueueResult = repository.queueHandover(businessDate, request)

        override fun sendNow() {
            scheduler.sendNow()
        }

        override fun newSubmissionId(): String = UuidV7.generate(time.nowMillis())

        override fun nowMillis(): Long = time.nowMillis()
    }

@Module
@InstallIn(ViewModelComponent::class)
abstract class TodayDataModule {
    @Binds
    abstract fun bindTodayData(impl: AppTodayData): TodayData
}
