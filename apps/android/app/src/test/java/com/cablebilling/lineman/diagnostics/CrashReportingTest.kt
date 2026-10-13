@file:Suppress("DEPRECATION") // Device.name: set and checked on purpose (it must never be sent).

package com.cablebilling.lineman.diagnostics

import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.BuildConfig
import io.sentry.Breadcrumb
import io.sentry.Hint
import io.sentry.SentryEvent
import io.sentry.android.core.SentryAndroidOptions
import io.sentry.protocol.Device
import io.sentry.protocol.Message
import io.sentry.protocol.Request
import io.sentry.protocol.SentryException
import io.sentry.protocol.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant

/**
 * Sentry: when it starts (a DSN, a real phone), how it is configured (nothing personal), and the
 * `beforeSend` / `beforeBreadcrumb` scrubbing. Nothing here starts Sentry or sends anything.
 */
@RunWith(AndroidJUnit4::class)
class CrashReportingTest {
    private val dsn = "https://publickey@o0.ingest.sentry.io/0"

    @Test
    fun `Sentry starts only with a DSN, and never under Robolectric`() {
        assertFalse(CrashReporting.shouldStart("", "google/oriole/oriole:14"))
        assertFalse(CrashReporting.shouldStart("  ", "google/oriole/oriole:14"))
        assertFalse(CrashReporting.shouldStart(dsn, "robolectric"))
        assertTrue(CrashReporting.shouldStart(dsn, "google/oriole/oriole:14"))

        // Even with a DSN, a JVM test never starts it.
        assertFalse(CrashReporting.init(ApplicationProvider.getApplicationContext(), dsn, "dev", "lineman@test"))
        assertFalse(CrashReporting.isEnabled)
    }

    @Test
    fun `the dev flavour has no DSN, so local builds and unit tests send nothing`() {
        if (BuildConfig.FLAVOR == "dev") assertEquals("", BuildConfig.SENTRY_DSN)
    }

    @Test
    fun `options - no default PII, no screenshots or view tree, errors only, scrubbing hooks`() {
        val options = SentryAndroidOptions()
        CrashReporting.configure(options, dsn, "prod", "lineman@0.1.0+1")

        assertEquals(dsn, options.dsn)
        assertEquals("prod", options.environment)
        assertEquals("lineman@0.1.0+1", options.release)
        assertFalse(options.isSendDefaultPii)
        assertFalse(options.isAttachScreenshot)
        assertFalse(options.isAttachViewHierarchy)
        assertNull(options.tracesSampleRate)

        val event = personalEvent()
        val sent = options.beforeSend!!.execute(event, Hint())!!
        assertNoPersonalData(sent)
        val crumb = options.beforeBreadcrumb!!.execute(Breadcrumb("opened 9876543210"), Hint())!!
        assertEquals("opened [number]", crumb.message)
    }

    @Test
    fun `beforeSend removes names, phone numbers, amounts and tokens everywhere in the event`() {
        val event = SentryPrivacy.scrub(personalEvent())
        assertNoPersonalData(event)
        // What support needs stays: the random install id, exception types, and the crash text's shape.
        assertEquals("install-id-1", event.user?.id)
        assertEquals("java.io.IOException", event.exceptions?.single()?.type)
        assertEquals("timeout calling [number]", event.exceptions?.single()?.value)
        assertEquals("payment_push", event.getTag("event"))
    }

    @Test
    fun `the report has app and phone facts, counts and the log - and is shared, not sent`() {
        val app = AppInfo("0.1.0-dev", 1, "dev", "14", 34, "Xiaomi", "Redmi 9A")
        val report =
            DiagnosticReport.build(
                app = app,
                language = "hi",
                queue = QueueCounts(waiting = 3, needsHelp = 1, otherLineman = 2),
                logLines = listOf("2026-10-13T11:30:00.000Z I app_start app=0.1.0-dev (1)"),
                now = Instant.parse("2026-10-13T11:31:00Z"),
            )
        assertTrue(report, report.contains("app=0.1.0-dev (1) flavor=dev"))
        assertTrue(report, report.contains("device=Xiaomi Redmi 9A"))
        assertTrue(report, report.contains("queue waiting=3 needs_help=1 other_lineman=2"))
        assertTrue(report, report.endsWith("I app_start app=0.1.0-dev (1)"))

        val chooser = DiagnosticReport.shareIntent(report, "Cable Billing app report", "Share app report")
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        @Suppress("DEPRECATION")
        val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(Intent.ACTION_SEND, send.action)
        assertEquals("text/plain", send.type)
        assertEquals(report, send.getStringExtra(Intent.EXTRA_TEXT))
        assertEquals("Share app report", chooser.getCharSequenceExtra(Intent.EXTRA_TITLE))
    }

    private fun personalEvent(): SentryEvent =
        SentryEvent().apply {
            user =
                User().apply {
                    id = "install-id-1"
                    name = "Suresh Lineman"
                    email = "suresh@example.com"
                    ipAddress = "10.1.2.3"
                    username = "9876500001"
                }
            request = Request().apply { url = "https://app.example/api/mobile/v1/customers?q=ramesh" }
            serverName = "Suresh's phone"
            contexts.setDevice(Device().apply { name = "Suresh's phone" })
            message =
                Message().apply {
                    formatted = "Saved ₹450 from रमेश, phone 9876543210"
                    message = "Saved %s from %s"
                    params = listOf("₹450", "customer_name=Ramesh")
                }
            exceptions =
                listOf(
                    SentryException().apply {
                        type = "java.io.IOException"
                        value = "timeout calling 9876543210"
                    },
                )
            breadcrumbs =
                listOf(
                    Breadcrumb("http").apply {
                        message = "GET https://app.example/api?phone=9876543210"
                        setData("url", "https://app.example/api?customer=Ramesh")
                        setData("authorization", "Bearer eyJhbGciOi.eyJzdWIi.sig")
                    },
                )
            setExtra("refresh_token", "rt_8f3k2j4h5g6f7d8s9a0")
            setExtra("note", "customer_phone=9876543210")
            setTag("event", "payment_push")
            setTag("customer", "customer_name=Ramesh")
        }

    private fun assertNoPersonalData(event: SentryEvent) {
        assertNull(event.request)
        assertNull(event.serverName)
        assertNull(event.contexts.device?.name)
        assertNotNull(event.user)
        assertNull(event.user?.name)
        assertNull(event.user?.email)
        assertNull(event.user?.ipAddress)
        assertNull(event.user?.username)
        val text =
            listOfNotNull(
                event.message?.formatted,
                event.message?.message,
                event.message?.params?.joinToString(),
                event.exceptions?.joinToString { it.value.orEmpty() },
                event.breadcrumbs?.joinToString { "${it.message} ${it.data}" },
                event.extras?.toString(),
                event.tags?.toString(),
            ).joinToString("\n")
        for (secret in listOf(
            "Ramesh",
            "ramesh",
            "रमेश",
            "9876543210",
            "₹450",
            "eyJhbGciOi",
            "rt_8f3k2j4h5g6f7d8s9a0",
            "Suresh",
        )) {
            assertFalse("'$secret' left in:\n$text", text.contains(secret))
        }
    }
}
