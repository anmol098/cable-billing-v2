package com.cablebilling.lineman.data.sync

import android.content.Context
import android.database.SQLException
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

/**
 * Runs [PaymentSync] for WorkManager (unique work, network constraint, see [PaymentSyncScheduler]).
 * WorkManager keeps the request across process death and reboots, so a payment saved just before the
 * app was killed is still pushed.
 *
 * Results: everything sent (or nobody signed in) → success; a temporary problem → retry with
 * exponential backoff, **without a limit** (payments are never given up, BR-11); a problem retrying
 * cannot fix (signed out, app too old, refused) → failure, and the next trigger (sign-in, app open,
 * a new save, "Try now") starts again. When the push posted anything, the roster is pulled so the
 * dues on the phone match the office ([RosterSyncScheduler.requestNow]).
 */
@HiltWorker
class PaymentSyncWorker
    @AssistedInject
    constructor(
        @Assisted context: Context,
        @Assisted params: WorkerParameters,
        private val sync: PaymentSync,
        private val roster: RosterSyncScheduler,
    ) : CoroutineWorker(context, params) {
        override suspend fun doWork(): Result {
            val result =
                try {
                    sync.run()
                } catch (ignored: SQLException) {
                    // The phone's database could not be read or written right now; nothing was lost.
                    return Result.retry()
                }
            if (result.sent > 0) roster.requestNow()
            return when (result) {
                is PaymentSyncResult.Done, PaymentSyncResult.NotSignedIn -> Result.success()
                is PaymentSyncResult.RetryLater -> Result.retry()
                is PaymentSyncResult.Stopped -> Result.failure()
            }
        }
    }
