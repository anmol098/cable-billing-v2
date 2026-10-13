package com.cablebilling.lineman

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
import com.cablebilling.lineman.data.sync.PaymentSyncScheduler
import com.cablebilling.lineman.data.sync.RosterSyncScheduler
import com.cablebilling.lineman.diagnostics.CrashReporting
import com.cablebilling.lineman.locale.AppLanguage
import dagger.hilt.android.HiltAndroidApp
import javax.inject.Inject

@HiltAndroidApp
class CableApplication :
    Application(),
    Configuration.Provider {
    @Inject
    lateinit var workerFactory: HiltWorkerFactory

    @Inject
    lateinit var rosterSync: RosterSyncScheduler

    @Inject
    lateinit var paymentSync: PaymentSyncScheduler

    /** WorkManager starts on first use with this config, so @HiltWorker workers get injected. */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()

    override fun onCreate() {
        super.onCreate()
        CrashReporting.init(this, dsn = BuildConfig.SENTRY_DSN, environment = BuildConfig.FLAVOR)
        AppLanguage.applyDefaultAtAppStart()
        rosterSync.start() // T-064: roster pull on sign-in, app open and every 30 min.
        paymentSync.start() // T-066: push payments saved on the phone on sign-in and app open.
    }
}
