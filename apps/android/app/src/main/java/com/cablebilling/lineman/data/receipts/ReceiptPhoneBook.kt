package com.cablebilling.lineman.data.receipts

import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.CableDatabase
import com.cablebilling.lineman.data.db.TimeSource
import javax.inject.Inject
import javax.inject.Singleton

/** The number to confirm in the receipt flow. */
data class CustomerPhone(
    /** 10 digits, or null when the phone has no usable number (the lineman types one). */
    val phone: String?,
    /** A change the lineman made that has not reached the office yet. */
    val changePending: Boolean,
)

/**
 * The customer's mobile number for receipts (FR-004): the cached roster number unless the lineman
 * changed it in the receipt flow. A change is queued for `PATCH /customers/{id}/phone` (sent by
 * `ReceiptSync`, offline-safe) and used on this phone at once.
 */
@Singleton
class ReceiptPhoneBook
    @Inject
    constructor(
        private val db: CableDatabase,
        private val store: ReceiptRequestStore,
        private val sessions: SessionStore,
        private val time: TimeSource,
        private val trigger: ReceiptSyncTrigger,
    ) {
        /** The number to show for [customerId]. */
        suspend fun phoneFor(customerId: String): CustomerPhone {
            val entry = store.current().phones.firstOrNull { it.customerId == customerId }
            val roster = db.customerDao().get(customerId)
            return when {
                entry != null && entry.sentAt == null -> {
                    CustomerPhone(entry.phone, changePending = true)
                }

                // The office has the change; the roster copy on the phone may still be older.
                entry != null && (roster == null || roster.updatedAt <= (entry.serverUpdatedAt ?: Long.MAX_VALUE)) -> {
                    CustomerPhone(entry.phone, changePending = false)
                }

                else -> {
                    CustomerPhone(PhoneNumbers.normalize(roster?.phone), changePending = false)
                }
            }
        }

        /**
         * The lineman confirmed [phone] (10 digits) for [customerId]. Queues a change when it differs
         * from what the office has (as far as the phone knows) and asks for a send. Returns true if a
         * change was queued. A format-only difference of the stored number ("+91 98765-43210") is not
         * a change.
         */
        suspend fun confirm(
            customerId: String,
            phone: String,
        ): Boolean {
            require(PhoneNumbers.isValid(phone)) { "not a mobile number" }
            val session = sessions.session
            val effective = phoneFor(customerId).phone
            val entry = store.current().phones.firstOrNull { it.customerId == customerId }
            val rosterPhone = PhoneNumbers.normalize(db.customerDao().get(customerId)?.phone)
            val unchanged = phone == effective || (entry == null && phone == rosterPhone)
            if (session == null || unchanged) return false
            val queued =
                QueuedPhone(
                    customerId = customerId,
                    phone = phone,
                    userId = session.user.id,
                    operatorId = session.operator.id,
                    queuedAt = time.nowMillis(),
                )
            store.update { requests ->
                requests.copy(phones = requests.phones.filterNot { it.customerId == customerId } + queued)
            }
            trigger.requestSync()
            return true
        }
    }
