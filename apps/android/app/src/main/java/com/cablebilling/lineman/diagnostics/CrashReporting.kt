package com.cablebilling.lineman.diagnostics

import android.content.Context
import android.os.Build
import io.sentry.android.core.SentryAndroid
import io.sentry.android.core.SentryAndroidOptions

/**
 * Sentry crash reporting (PLAN §11.1, §17). Off unless the build has a DSN for its flavour
 * (`BuildConfig.SENTRY_DSN`: `-Pcb.sentryDsn.<flavour>=…` or `SENTRY_DSN_<FLAVOUR>`; see
 * apps/android/README.md). The dev flavour has none by default, and Sentry never starts under
 * Robolectric, so unit tests send nothing. Auto-init is disabled in the manifest.
 */
object CrashReporting {
    var isEnabled: Boolean = false
        private set

    /** Starts Sentry when [dsn] is set (and this is a real phone). Returns whether it started. */
    fun init(
        context: Context,
        dsn: String,
        environment: String,
        release: String,
    ): Boolean {
        if (!shouldStart(dsn, Build.FINGERPRINT)) return false
        SentryAndroid.init(context) { options -> configure(options, dsn, environment, release) }
        isEnabled = true
        return true
    }

    /** Sentry runs only with a DSN, and never in JVM tests (Robolectric's fingerprint). */
    fun shouldStart(
        dsn: String,
        fingerprint: String?,
    ): Boolean = dsn.isNotBlank() && fingerprint != ROBOLECTRIC_FINGERPRINT

    /** The options: errors only, nothing personal (no default PII, screenshots or view hierarchy), scrubbed. */
    fun configure(
        options: SentryAndroidOptions,
        dsn: String,
        environment: String,
        release: String,
    ) {
        options.dsn = dsn
        options.environment = environment
        options.release = release
        // No names, phone numbers or IPs leave the phone.
        options.isSendDefaultPii = false
        // A screenshot or the view tree would show customer names and amounts.
        options.isAttachScreenshot = false
        options.isAttachViewHierarchy = false
        // Errors only: no performance tracing.
        options.tracesSampleRate = null
        options.setBeforeSend { event, _ -> SentryPrivacy.scrub(event) }
        options.setBeforeBreadcrumb { breadcrumb, _ -> SentryPrivacy.scrub(breadcrumb) }
    }

    private const val ROBOLECTRIC_FINGERPRINT = "robolectric"
}
