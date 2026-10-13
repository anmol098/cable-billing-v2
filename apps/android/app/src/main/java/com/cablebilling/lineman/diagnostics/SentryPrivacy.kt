package com.cablebilling.lineman.diagnostics

import io.sentry.Breadcrumb
import io.sentry.SentryEvent
import io.sentry.protocol.User

/**
 * Sentry's `beforeSend` / `beforeBreadcrumb` (PLAN §11.1): nothing that names a person, a phone
 * number, an amount tied to a customer or a token leaves the phone. Sentry is also started with
 * `sendDefaultPii = false`, no screenshots and no view hierarchy ([CrashReporting]); this is the second
 * line, applied to every event right before it is sent.
 */
object SentryPrivacy {
    /** Keeps only Sentry's random installation id of the user (crash counts per phone), drops the rest. */
    fun scrub(event: SentryEvent): SentryEvent {
        event.user = event.user?.id?.let { id -> User().apply { this.id = id } }
        event.request = null
        event.serverName = null
        @Suppress("DEPRECATION") // still filled by older Sentry integrations
        event.contexts.device?.name = null // the phone's own name, e.g. "Ramesh's phone"
        event.message?.let { message ->
            message.formatted = message.formatted?.let(PiiScrubber::scrub)
            message.message = message.message?.let(PiiScrubber::scrub)
            message.params = message.params?.map(PiiScrubber::scrub)
        }
        event.exceptions?.forEach { exception -> exception.value = exception.value?.let(PiiScrubber::scrub) }
        event.breadcrumbs?.forEach(::scrubInPlace)
        event.extras?.keys?.toList()?.forEach { key ->
            event.setExtra(key, PiiScrubber.scrub(event.getExtra(key)?.toString()))
        }
        event.tags
            ?.keys
            ?.toList()
            ?.forEach { key -> event.setTag(key, PiiScrubber.scrub(event.getTag(key))) }
        return event
    }

    /** Scrubs a breadcrumb's message and data before Sentry keeps it. */
    fun scrub(breadcrumb: Breadcrumb): Breadcrumb = breadcrumb.also(::scrubInPlace)

    private fun scrubInPlace(breadcrumb: Breadcrumb) {
        breadcrumb.message = breadcrumb.message?.let(PiiScrubber::scrub)
        breadcrumb.data.keys.toList().forEach { key ->
            breadcrumb.setData(key, PiiScrubber.scrub(breadcrumb.getData(key)?.toString()))
        }
    }
}
