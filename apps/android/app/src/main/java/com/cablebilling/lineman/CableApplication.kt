package com.cablebilling.lineman

import android.app.Application
import androidx.hilt.work.HiltWorkerFactory
import androidx.work.Configuration
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

    /** WorkManager starts on first use with this config, so @HiltWorker workers get injected. */
    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder().setWorkerFactory(workerFactory).build()

    override fun onCreate() {
        super.onCreate()
        CrashReporting.init(this, dsn = BuildConfig.SENTRY_DSN, environment = BuildConfig.FLAVOR)
        AppLanguage.applyDefaultAtAppStart()
    }
}
