package com.cablebilling.lineman.data.sync

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
import com.cablebilling.lineman.data.payments.PaymentPushTrigger
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/**
 * When the payment queue is pushed (PLAN §10.4): right after every save, when a lineman signs in
 * (their own payments only), when the app comes to the foreground, and on "Try now" (Waiting screen).
 * Every push runs as the unique work [WORK] with a network constraint and exponential backoff, so it
 * survives process death and reboots and waits for the network by itself.
 *
 * **Unique-work policy: APPEND_OR_REPLACE, at most one waiting.** Every request made after a payment
 * was committed must lead to a run that *starts* after that commit:
 * - KEEP would drop a request that arrives while a run is finishing (it already read an empty queue),
 *   leaving the new payment on the phone until some later trigger.
 * - REPLACE would cancel a run in the middle of a batch (safe thanks to idempotent ids, but wasted
 *   and it can starve the push when payments are saved quickly).
 * - APPEND keeps runs strictly one after another (never two pushes at once) and queues a new run
 *   behind a running one. To keep the chain short, nothing is appended while a run is already
 *   waiting to start (ENQUEUED, incl. backoff, or BLOCKED): that run starts after the commit anyway
 *   and reads the queue fresh. "_OR_REPLACE" starts a new chain after a failed one (a plain APPEND
 *   would inherit the failure).
 */
@Singleton
class PaymentSyncScheduler
    @Inject
    constructor(
        @param:ApplicationContext private val context: Context,
        private val db: CableDatabase,
        private val sessions: SessionStore,
        private val sync: dagger.Lazy<PaymentSync>,
        private val roster: RosterSyncScheduler,
    ) : PaymentPushTrigger {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val started = AtomicBoolean(false)
        private val enqueueLock = Mutex()

        /**
         * Starts the triggers: a lineman signed in (also the stored session at app start) with their own
         * payments on the phone → push; app to the foreground while signed in → push if needed. Call once,
         * on the main thread (CableApplication.onCreate).
         */
        fun start() {
            if (!started.compareAndSet(false, true)) return
            scope.launch {
                sessions.load() // also when the process was started without a screen (e.g. by WorkManager)
                sessions.state
                    .map { (it as? SessionState.SignedIn)?.session?.user?.id }
                    .distinctUntilChanged()
                    .filterNotNull()
                    .collect { userId -> pushIfOwnPayments(userId) }
            }
            ProcessLifecycleOwner.get().lifecycle.addObserver(
                object : DefaultLifecycleObserver {
                    override fun onStart(owner: LifecycleOwner) {
                        val userId = sessions.session?.user?.id ?: return
                        scope.launch { pushIfOwnPayments(userId) }
                    }
                },
            )
        }

        /** After a save: push as soon as there is a network. */
        override fun requestPush() {
            scope.launch { enqueue() }
        }

        /**
         * "Try now": push at once in this process (the screen sees the answer through
         * [PaymentSync.status]); if something is left, the WorkManager push takes over with backoff.
         */
        fun tryNow(): Job =
            scope.launch {
                val result = sync.get().run()
                if (result.sent > 0) roster.requestNow()
                if (result !is PaymentSyncResult.Done && result != PaymentSyncResult.NotSignedIn) enqueue()
            }

        /** Enqueues a push unless one is already waiting to start. Returns true if a run was added. */
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

        /**
         * Enqueues a push if [userId] has payments on the phone (another lineman's held ones do not
         * count). Returns true if a run was added.
         */
        suspend fun pushIfOwnPayments(userId: String): Boolean =
            db.paymentDao().oldestSavedOnPhoneFor(userId, 1).isNotEmpty() && enqueue()

        companion object {
            const val WORK = "payment-sync"
            const val TAG = "payment-sync"
            const val BACKOFF_SECONDS = 30L

            fun request(): OneTimeWorkRequest =
                OneTimeWorkRequestBuilder<PaymentSyncWorker>()
                    .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
                    .addTag(TAG)
                    .build()
        }
    }
