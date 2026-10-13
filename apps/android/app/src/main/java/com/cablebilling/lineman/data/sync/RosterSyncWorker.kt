package com.cablebilling.lineman.data.sync

import android.content.Context
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.cablebilling.lineman.data.network.AppConfigRepository
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

/**
 * Runs [RosterSync] for WorkManager (periodic and on demand, see [RosterSyncScheduler]). After a
 * successful sync it also refreshes `/app/config` (force-update gate, operator details), best effort.
 *
 * Results: synced or nobody signed in → success; no connection or a temporary server error → retry
 * with backoff (up to [MAX_ATTEMPTS] runs); anything else → failure (the periodic sync tries again
 * in 30 min). The cached roster is never cleared by a failure.
 */
@HiltWorker
class RosterSyncWorker
    @AssistedInject
    constructor(
        @Assisted context: Context,
        @Assisted params: WorkerParameters,
        private val sync: RosterSync,
        private val appConfig: AppConfigRepository,
    ) : CoroutineWorker(context, params) {
        override suspend fun doWork(): Result =
            when (val result = sync.run()) {
                is RosterSyncResult.Synced -> {
                    appConfig.refresh()
                    Result.success()
                }

                RosterSyncResult.NotSignedIn -> {
                    Result.success()
                }

                is RosterSyncResult.Failed -> {
                    val attemptsLeft = runAttemptCount + 1 < MAX_ATTEMPTS
                    if (result.failure.isRetryable && attemptsLeft) Result.retry() else Result.failure()
                }
            }

        companion object {
            /** Runs of one request before giving up until the next trigger (periodic, app open, push). */
            const val MAX_ATTEMPTS = 5
        }
    }
