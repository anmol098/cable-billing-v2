package com.cablebilling.lineman.data.sync

import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequest
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import javax.inject.Inject
import javax.inject.Singleton

/**
 * When the roster is pulled (PLAN §10.3): every 30 minutes on any network, when the app comes to the
 * foreground, when a lineman signs in, and after a payment push ([requestNow], for T-066). All runs
 * need a network: offline, the request waits in WorkManager and runs when the phone is back online.
 *
 * Nothing touches WorkManager until someone is signed in.
 */
@Singleton
class RosterSyncScheduler
    @Inject
    constructor(
        @param:ApplicationContext private val context: Context,
        private val sync: dagger.Lazy<RosterSync>,
        private val sessions: SessionStore,
    ) {
        private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        private val started = AtomicBoolean(false)

        /**
         * Starts the triggers: sign-in (also the stored session at start) → periodic sync + a pull now;
         * app to foreground while signed in → a pull now. Call once, on the main thread
         * (CableApplication.onCreate).
         */
        fun start() {
            if (!started.compareAndSet(false, true)) return
            scope.launch {
                sessions.state
                    .map { (it as? SessionState.SignedIn)?.session?.user?.id }
                    .distinctUntilChanged()
                    .filterNotNull()
                    .collect {
                        schedulePeriodic()
                        requestNow()
                    }
            }
            ProcessLifecycleOwner.get().lifecycle.addObserver(
                object : DefaultLifecycleObserver {
                    override fun onStart(owner: LifecycleOwner) {
                        if (sessions.session != null) requestNow()
                    }
                },
            )
        }

        /**
         * Pull the roster as soon as there is a network: app open, sign-in, and after a payment push
         * that posted something (T-066). If a pull is already running, it pulls once more at the end.
         */
        fun requestNow() {
            sync.get().markStale()
            WorkManager.getInstance(context).enqueueUniqueWork(NOW_WORK, ExistingWorkPolicy.KEEP, oneTimeRequest())
        }

        /** Keeps the 30-minute periodic pull scheduled (idempotent). */
        fun schedulePeriodic() {
            WorkManager
                .getInstance(context)
                .enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.UPDATE, periodicRequest())
        }

        companion object {
            const val NOW_WORK = "roster-sync-now"
            const val PERIODIC_WORK = "roster-sync-periodic"
            const val TAG = "roster-sync"
            const val PERIOD_MINUTES = 30L
            const val BACKOFF_SECONDS = 30L

            private val networkConstraint =
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

            fun oneTimeRequest(): OneTimeWorkRequest =
                OneTimeWorkRequestBuilder<RosterSyncWorker>()
                    .setConstraints(networkConstraint)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
                    .addTag(TAG)
                    .build()

            fun periodicRequest(): PeriodicWorkRequest =
                PeriodicWorkRequestBuilder<RosterSyncWorker>(PERIOD_MINUTES, TimeUnit.MINUTES)
                    .setConstraints(networkConstraint)
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
                    .addTag(TAG)
                    .build()
        }
    }
