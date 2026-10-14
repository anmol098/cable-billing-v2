package com.cablebilling.lineman.data.receipts

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.await
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.CableDatabase
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.runningFold
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/**
 * When the receipt queues are sent (see [ReceiptSync]): after every recorded action, phone change or
 * queued link; when a lineman signs in; when the app comes to the foreground; and **whenever payments
 * leave the phone** (the payment push succeeded, so actions and links waiting for those payments can
 * go). Runs as unique work [WORK] with a network constraint and exponential backoff, so it survives
 * process death and reboots. Same policy as the payment push (`PaymentSyncScheduler`):
 * APPEND_OR_REPLACE with at most one run waiting.
 */
@Singleton
class ReceiptSyncScheduler
    @Inject
    constructor(
        @param:ApplicationContext private val context: Context,
        private val db: CableDatabase,
        private val sessions: SessionStore,
        private val sync: dagger.Lazy<ReceiptSync>,
    ) : ReceiptSyncTrigger {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val started = AtomicBoolean(false)
        private val enqueueLock = Mutex()

        /** Starts the triggers. Call once, on the main thread (CableApplication.onCreate). */
        fun start() {
            if (!started.compareAndSet(false, true)) return
            scope.launch {
                sessions.load()
                sessions.state
                    .map { (it as? SessionState.SignedIn)?.session?.user?.id }
                    .distinctUntilChanged()
                    .filterNotNull()
                    .collect { syncIfWork() }
            }
            scope.launch {
                // Fewer payments on the phone = the push delivered some: their receipt work can go now.
                db
                    .paymentDao()
                    .observeSavedOnPhoneCount()
                    .runningFold(Int.MAX_VALUE to Int.MAX_VALUE) { (_, previous), count -> previous to count }
                    .collect { (previous, count) -> if (count < previous && previous != Int.MAX_VALUE) syncIfWork() }
            }
            ProcessLifecycleOwner.get().lifecycle.addObserver(
                object : DefaultLifecycleObserver {
                    override fun onStart(owner: LifecycleOwner) {
                        if (sessions.session != null) scope.launch { syncIfWork() }
                    }
                },
            )
        }

        override fun requestSync() {
            scope.launch { enqueue() }
        }

        /** Enqueues a run when anything is queued. Returns true if a run was added. */
        suspend fun syncIfWork(): Boolean = sync.get().hasWork() && enqueue()

        /** Enqueues a run unless one is already waiting to start. Returns true if a run was added. */
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
            const val WORK = "receipt-sync"
            const val TAG = "receipt-sync"
            const val BACKOFF_SECONDS = 30L

            fun request(): OneTimeWorkRequest =
                OneTimeWorkRequestBuilder<ReceiptSyncWorker>()
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
                    .addTag(TAG)
                    .build()
        }
    }
