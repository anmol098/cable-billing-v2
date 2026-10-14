package com.cablebilling.lineman.data.receipts

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.io.IOException
import javax.inject.Inject
import javax.inject.Qualifier
import javax.inject.Singleton

/** The DataStore file of [ReceiptRequestStore] (`receipt_requests`), apart from the app settings. */
@Qualifier
@Retention(AnnotationRetention.BINARY)
annotation class ReceiptRequestsDataStore

/**
 * A phone number the lineman confirmed or typed in the receipt flow (FR-004), for
 * `PATCH /customers/{id}/phone`. [sentAt] null = still to send. After the server took it, the entry
 * stays (so the phone keeps showing the new number) until the roster has a copy of the customer
 * newer than [serverUpdatedAt].
 */
@Serializable
data class QueuedPhone(
    @SerialName("customer_id") val customerId: String,
    /** 10 digits (contract `IndianMobile`). */
    val phone: String,
    /** Who changed it and for which operator: sent only under that sign-in (the server audits the actor). */
    @SerialName("user_id") val userId: String,
    @SerialName("operator_id") val operatorId: String,
    @SerialName("queued_at") val queuedAt: Long,
    val attempts: Int = 0,
    @SerialName("last_error") val lastError: String? = null,
    @SerialName("sent_at") val sentAt: Long? = null,
    /** The customer's `updated_at` (epoch ms) in the server's answer. */
    @SerialName("server_updated_at") val serverUpdatedAt: Long? = null,
)

/** A preview link asked for while it could not be made (offline, or the payment not at the office yet). */
@Serializable
data class QueuedLink(
    @SerialName("payment_id") val paymentId: String,
    @SerialName("user_id") val userId: String,
    @SerialName("queued_at") val queuedAt: Long,
    val attempts: Int = 0,
    @SerialName("last_error") val lastError: String? = null,
)

/** A preview link the server made (`POST /receipts/{paymentId}/link`), reused until it nearly expires. */
@Serializable
data class ReadyLink(
    @SerialName("payment_id") val paymentId: String,
    val url: String,
    @SerialName("expires_at") val expiresAt: Long,
    @SerialName("receipt_number") val receiptNumber: String,
    @SerialName("got_at") val gotAt: Long,
)

/** Everything the receipt flow keeps for later. */
@Serializable
data class ReceiptRequests(
    val phones: List<QueuedPhone> = emptyList(),
    val links: List<QueuedLink> = emptyList(),
    val ready: List<ReadyLink> = emptyList(),
) {
    val hasWork: Boolean get() = links.isNotEmpty() || phones.any { it.sentAt == null }
}

/**
 * The receipt flow's durable requests: phone changes to send, links to fetch, links already made.
 * Kept in its own Preferences DataStore file (written atomically, so it survives process death)
 * rather than Room, so no database migration is needed (the payments' Room schema is untouched).
 * Small by design: one phone entry per customer, one link entry per payment, at most [MAX_READY]
 * ready links.
 */
@Singleton
class ReceiptRequestStore
    @Inject
    constructor(
        @param:ReceiptRequestsDataStore private val store: DataStore<Preferences>,
    ) {
        /** The requests now (an unreadable file reads as empty: the receipt flow just asks again). */
        val requests: Flow<ReceiptRequests> =
            store.data
                .catch { e -> if (e is IOException) emit(emptyPreferences()) else throw e }
                .map { decode(it[KEY]) }

        suspend fun current(): ReceiptRequests = requests.first()

        /** Changes the requests in one atomic write and returns the new value. */
        suspend fun update(change: (ReceiptRequests) -> ReceiptRequests): ReceiptRequests {
            var result = ReceiptRequests()
            store.edit { prefs ->
                result = change(decode(prefs[KEY])).trimmed()
                prefs[KEY] = JSON.encodeToString(ReceiptRequests.serializer(), result)
            }
            return result
        }

        private fun ReceiptRequests.trimmed(): ReceiptRequests =
            copy(ready = ready.sortedByDescending { it.gotAt }.take(MAX_READY))

        private fun decode(text: String?): ReceiptRequests =
            text?.let {
                try {
                    JSON.decodeFromString(ReceiptRequests.serializer(), it)
                } catch (ignored: SerializationException) {
                    null
                } catch (ignored: IllegalArgumentException) {
                    null
                }
            } ?: ReceiptRequests()

        companion object {
            /** DataStore file name (`files/datastore/receipt_requests.preferences_pb`). */
            const val FILE = "receipt_requests"

            const val MAX_READY = 100

            private val KEY = stringPreferencesKey("requests")
            private val JSON = Json { ignoreUnknownKeys = true }
        }
    }
