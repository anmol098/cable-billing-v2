package com.cablebilling.lineman.feature.today

import android.content.Context
import android.database.SQLException
import androidx.hilt.work.HiltWorker
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.await
import com.cablebilling.lineman.data.sync.PaymentSync
import com.cablebilling.lineman.data.sync.RosterSyncScheduler
import dagger.Binds
import dagger.Module
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Sends the handovers saved on the phone ([TodayRepository.sendQueued]) as the unique work [WORK]: network
 * constraint, exponential backoff, kept by WorkManager across process death and reboots. Same policy as
 * the payment push (T-066 `PaymentSyncScheduler`): APPEND_OR_REPLACE with at most one run waiting, so a
 * request made after a commit always leads to a run that starts after it.
 */
@Singleton
class HandoverSyncScheduler
    @Inject
    constructor(
        @param:ApplicationContext private val context: Context,
        private val repository: dagger.Lazy<TodayRepository>,
        private val paymentsFirst: PaymentsFirst,
    ) : HandoverSendTrigger {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val enqueueLock = Mutex()

        /** After a handover was saved: send as soon as there is a network. */
        override fun requestSend() {
            scope.launch { enqueue() }
        }

        /** Send now in this process (the Today screen sees the answer); anything left goes to the background work. */
        fun sendNow(): Job =
            scope.launch {
                val result =
                    try {
                        sendWithPaymentsFirst(repository.get(), paymentsFirst)
                    } catch (ignored: SQLException) {
                        null // the phone's database could not be read right now: the background work retries
                    }
                if (result !is HandoverSendResult.Done && result != HandoverSendResult.NotSignedIn) enqueue()
            }

        /** Enqueues a send unless one is already waiting to start. Returns true if a run was added. */
        suspend fun enqueue(): Boolean =
            enqueueLock.withLock {
                val workManager = WorkManager.getInstance(context)
                val chain = workManager.getWorkInfosForUniqueWorkFlow(WORK).first()
                if (chain.any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.BLOCKED }) {
                    return@withLock false
                }
                workManager.enqueueUniqueWork(WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request()).await()
                true
            }

        companion object {
            const val WORK = "handover-sync"
            const val TAG = "handover-sync"
            const val BACKOFF_SECONDS = 30L

            fun request(): OneTimeWorkRequest =
                OneTimeWorkRequestBuilder<HandoverSyncWorker>()
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
                    .addTag(TAG)
                    .build()
        }
    }

/**
 * Runs [TodayRepository.sendQueued] for WorkManager. Sent (or nothing to send, or nobody signed in) →
 * success; no internet / 429 / 5xx / unreadable answer → retry with backoff, without a limit (the cash
 * handover is never given up); signed out, app too old → failure, and the next trigger starts again
 * (a new handover, the Today screen opening, "Try now").
 */
@HiltWorker
class HandoverSyncWorker
    @AssistedInject
    constructor(
        @Assisted context: Context,
        @Assisted params: WorkerParameters,
        private val repository: TodayRepository,
        private val paymentsFirst: PaymentsFirst,
    ) : CoroutineWorker(context, params) {
        override suspend fun doWork(): Result {
            val result =
                try {
                    sendWithPaymentsFirst(repository, paymentsFirst)
                } catch (ignored: SQLException) {
                    return Result.retry()
                }
            return when (result) {
                is HandoverSendResult.Done, HandoverSendResult.NotSignedIn -> Result.success()
                is HandoverSendResult.RetryLater -> Result.retry()
                is HandoverSendResult.Stopped -> Result.failure()
            }
        }
    }

/**
 * Pushes the signed-in lineman's payments still on the phone (T-066 `PaymentSync`) right before a handover
 * is sent, so the office's expected cash — snapshotted when the handover arrives (T-062) — already counts
 * them and matches the lineman's own count. It never stops the handover: whatever is still on the phone
 * afterwards is reported with it (`unsynced_*`, reason `pending_sync`).
 */
fun interface PaymentsFirst {
    suspend fun push()
}

/** The app's [PaymentsFirst]: one payment push, then a roster pull if it posted anything (as T-066 does). */
class AppPaymentsFirst
    @Inject
    constructor(
        private val sync: PaymentSync,
        private val roster: RosterSyncScheduler,
    ) : PaymentsFirst {
        override suspend fun push() {
            if (sync.run().sent > 0) roster.requestNow()
        }
    }

/** Sends the waiting handovers, pushing the lineman's payments first when there is a handover to send. */
suspend fun sendWithPaymentsFirst(
    repository: TodayRepository,
    paymentsFirst: PaymentsFirst,
): HandoverSendResult {
    if (repository.hasWaitingForSignedIn()) paymentsFirst.push()
    return repository.sendQueued()
}

/** Hilt: saving a handover asks [HandoverSyncScheduler] for a send; payments go first. */
@Module
@InstallIn(SingletonComponent::class)
abstract class HandoverSyncModule {
    @Binds
    abstract fun bindSendTrigger(impl: HandoverSyncScheduler): HandoverSendTrigger

    @Binds
    abstract fun bindPaymentsFirst(impl: AppPaymentsFirst): PaymentsFirst
}
