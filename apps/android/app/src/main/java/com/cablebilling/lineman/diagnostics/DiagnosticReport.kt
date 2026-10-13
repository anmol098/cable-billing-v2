package com.cablebilling.lineman.diagnostics

import android.content.Intent
import android.os.Build
import com.cablebilling.lineman.BuildConfig
import java.time.Instant

/** The app and phone, for the top of the report and the settings screen. No identifiers of a person. */
data class AppInfo(
    val versionName: String,
    val versionCode: Long,
    /** dev / staging / prod. */
    val flavor: String,
    val androidRelease: String,
    val sdk: Int,
    val manufacturer: String,
    val model: String,
) {
    /** `0.1.0-dev (1)`. */
    val version: String get() = "$versionName ($versionCode)"

    /** Sentry release name: `lineman@0.1.0+1`. */
    val release: String get() = "lineman@$versionName+$versionCode"

    companion object {
        fun current(): AppInfo =
            AppInfo(
                versionName = BuildConfig.VERSION_NAME,
                versionCode = BuildConfig.VERSION_CODE.toLong(),
                flavor = BuildConfig.FLAVOR,
                androidRelease = Build.VERSION.RELEASE.orEmpty(),
                sdk = Build.VERSION.SDK_INT,
                manufacturer = Build.MANUFACTURER.orEmpty(),
                model = Build.MODEL.orEmpty(),
            )
    }
}

/** How many payments are where, by count only (no customers, no amounts). */
data class QueueCounts(
    val waiting: Int,
    val needsHelp: Int,
    val otherLineman: Int,
)

/**
 * The "app report" the lineman shares from settings: app and phone, the queue as counts, then the
 * diagnostic log. Plain text, so it can go to WhatsApp, e-mail or anything else on the share sheet.
 */
object DiagnosticReport {
    fun build(
        app: AppInfo,
        language: String,
        queue: QueueCounts?,
        logLines: List<String>,
        now: Instant,
    ): String =
        buildString {
            appendLine("Cable Billing lineman app report")
            appendLine("created=$now")
            appendLine("app=${app.version} flavor=${app.flavor}")
            appendLine("android=${app.androidRelease} sdk=${app.sdk}")
            appendLine("device=${PiiScrubber.scrub("${app.manufacturer} ${app.model}")}")
            appendLine("language=$language")
            if (queue != null) {
                appendLine(
                    "queue waiting=${queue.waiting} needs_help=${queue.needsHelp} other_lineman=${queue.otherLineman}",
                )
            }
            appendLine("log lines=${logLines.size}")
            logLines.forEach(::appendLine)
        }.trimEnd()

    /** The share sheet with the report as text ("Share", never "Send": we cannot know if it went anywhere). */
    fun shareIntent(
        text: String,
        subject: String,
        chooserTitle: String,
    ): Intent {
        val send =
            Intent(Intent.ACTION_SEND)
                .setType("text/plain")
                .putExtra(Intent.EXTRA_SUBJECT, subject)
                .putExtra(Intent.EXTRA_TEXT, text)
        return Intent.createChooser(send, chooserTitle)
    }
}
