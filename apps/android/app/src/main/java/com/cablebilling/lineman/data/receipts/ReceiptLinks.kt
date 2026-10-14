package com.cablebilling.lineman.data.receipts

import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.db.TimeSource
import com.cablebilling.lineman.data.network.ApiErrorParser
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.MobileApi
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.generated.ReceiptLinkResponse
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import java.time.Instant
import java.time.format.DateTimeParseException
import javax.inject.Inject
import javax.inject.Singleton

/** Where a payment's preview link stands. */
sealed interface LinkState {
    /** Not asked for. */
    data object None : LinkState

    /** Asked for but not made yet (offline, or the payment is not at the office): "ready when there is internet". */
    data object Queued : LinkState

    data class Ready(
        val url: String,
        val receiptNumber: String,
    ) : LinkState

    /** The office refused this payment: there will be no link (the PDF still works). */
    data object Unavailable : LinkState
}

/** How one `POST /receipts/{paymentId}/link` ended. */
sealed interface LinkFetch {
    data class Made(
        val link: ReadyLink,
    ) : LinkFetch

    data class Failed(
        val failure: ApiFailure,
    ) : LinkFetch
}

/**
 * Receipt preview links (PLAN §11.7, T-050/T-061): `POST /receipts/{paymentId}/link` makes a new
 * https link on every call (max 20 live per receipt), so a link is kept and reused until a day before
 * it expires. The server knows the payment only after the push (404 PAYMENT_NOT_FOUND before), so a
 * link asked for while the payment is on the phone, or while offline, is queued ("The link will be
 * ready when there is internet") and fetched by `ReceiptSync` after the payment reaches the office.
 */
@Singleton
class ReceiptLinks
    @Inject
    constructor(
        private val db: CableDatabase,
        private val api: MobileApi,
        private val errors: ApiErrorParser,
        private val store: ReceiptRequestStore,
        private val time: TimeSource,
        private val trigger: ReceiptSyncTrigger,
    ) {
        /** The link state of [paymentId], live (it turns Ready when the background fetch stores it). */
        fun observe(paymentId: String): Flow<LinkState> =
            combine(db.paymentDao().observe(paymentId), store.requests) { payment, requests ->
                stateOf(payment, requests)
            }

        /** The link now if it exists or can be made at once; otherwise queues it and says [LinkState.Queued]. */
        suspend fun request(paymentId: String): LinkState {
            val payment = db.paymentDao().get(paymentId)
            val known = stateOf(payment, store.current())
            if (payment == null || known is LinkState.Ready || known == LinkState.Unavailable) return known
            val fetched = if (payment.state == PaymentState.SENT_TO_OFFICE) fetch(payment) else null
            return if (fetched is LinkFetch.Made) {
                LinkState.Ready(fetched.link.url, fetched.link.receiptNumber)
            } else {
                queue(payment)
                LinkState.Queued
            }
        }

        /** Asks the server for a link for [payment] (at the office) and stores it; drops its queued request. */
        suspend fun fetch(payment: PaymentEntity): LinkFetch =
            when (val result = apiCall(errors) { api.createReceiptLink(payment.id) }) {
                is ApiResult.Success -> {
                    val link = result.value.toReady(payment.id)
                    if (link == null) {
                        LinkFetch.Failed(ApiFailure.Malformed(IllegalStateException("link is not https")))
                    } else {
                        store.update { requests ->
                            requests.copy(
                                links = requests.links.filterNot { it.paymentId == payment.id },
                                ready = requests.ready.filterNot { it.paymentId == payment.id } + link,
                            )
                        }
                        LinkFetch.Made(link)
                    }
                }

                is ApiResult.Failure -> {
                    LinkFetch.Failed(result.failure)
                }
            }

        /** A stored link still worth sending for [payment]. */
        fun usable(
            payment: PaymentEntity,
            link: ReadyLink,
        ): Boolean =
            link.paymentId == payment.id &&
                link.receiptNumber == payment.receiptNumber &&
                link.expiresAt - time.nowMillis() > EXPIRY_MARGIN_MILLIS

        private fun stateOf(
            payment: PaymentEntity?,
            requests: ReceiptRequests,
        ): LinkState {
            if (payment == null || payment.state == PaymentState.NEEDS_OFFICE_HELP) return LinkState.Unavailable
            val ready = requests.ready.firstOrNull { usable(payment, it) }
            return when {
                ready != null -> LinkState.Ready(ready.url, ready.receiptNumber)
                requests.links.any { it.paymentId == payment.id } -> LinkState.Queued
                else -> LinkState.None
            }
        }

        private suspend fun queue(payment: PaymentEntity) {
            // The payment's own lineman: the sync sends it only under that sign-in.
            val userId = payment.collectorId
            store.update { requests ->
                if (requests.links.any { it.paymentId == payment.id }) {
                    requests
                } else {
                    requests.copy(links = requests.links + QueuedLink(payment.id, userId, time.nowMillis()))
                }
            }
            trigger.requestSync()
        }

        private fun ReceiptLinkResponse.toReady(paymentId: String): ReadyLink? {
            val expires =
                try {
                    Instant.parse(link.expiresAt).toEpochMilli()
                } catch (ignored: DateTimeParseException) {
                    null
                }
            return expires
                ?.takeIf { link.url.startsWith("https://") }
                ?.let { ReadyLink(paymentId, link.url, it, link.receiptNumber, time.nowMillis()) }
        }

        companion object {
            /** A link expiring within a day is not reused (the customer may open it later). */
            const val EXPIRY_MARGIN_MILLIS: Long = 24L * 60 * 60 * 1000
        }
    }
