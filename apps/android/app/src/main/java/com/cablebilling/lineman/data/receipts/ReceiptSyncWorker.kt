package com.cablebilling.lineman.data.receipts

import android.content.Context
import android.database.SQLException
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.cablebilling.lineman.data.sync.RosterSyncScheduler
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import java.io.IOException

/**
 * Runs [ReceiptSync] for WorkManager (unique work [ReceiptSyncScheduler.WORK], network constraint).
 * Done / not signed in → success; temporary problem → retry with exponential backoff; signed out or
 * app too old → failure (the next trigger starts again). A phone change the office took asks for a
 * roster pull, so the cached customer gets the new number.
 */
@HiltWorker
class ReceiptSyncWorker
    @AssistedInject
    constructor(
        @Assisted context: Context,
        @Assisted params: WorkerParameters,
        private val sync: ReceiptSync,
        private val roster: RosterSyncScheduler,
    ) : CoroutineWorker(context, params) {
        override suspend fun doWork(): Result {
            val result =
                try {
                    sync.run()
                } catch (ignored: SQLException) {
                    null
                } catch (ignored: IOException) {
                    null // The request store could not be read or written right now; nothing was lost.
                } ?: return Result.retry()
            if (result.phonesChanged > 0) roster.requestNow()
            return when (result) {
                is ReceiptSyncResult.Done, ReceiptSyncResult.NotSignedIn -> Result.success()
                is ReceiptSyncResult.RetryLater -> Result.retry()
                is ReceiptSyncResult.Stopped -> Result.failure()
            }
        }
    }
