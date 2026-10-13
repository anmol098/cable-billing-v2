package com.cablebilling.lineman.diagnostics

import android.content.Context
import io.sentry.android.core.SentryAndroid

/**
 * Sentry crash reporting. A no-op unless a DSN is configured at build time
 * (`-Pcb.sentryDsn=…` or SENTRY_DSN); auto-init is disabled in the manifest. T-071 extends this.
 */
object CrashReporting {
    var isEnabled: Boolean = false
        private set

    fun init(
        context: Context,
        dsn: String,
        environment: String,
    ) {
        if (dsn.isBlank()) return
        SentryAndroid.init(context) { options ->
            options.dsn = dsn
            options.environment = environment
            // No names, phone numbers or IPs leave the phone.
            options.isSendDefaultPii = false
        }
        isEnabled = true
    }
}
