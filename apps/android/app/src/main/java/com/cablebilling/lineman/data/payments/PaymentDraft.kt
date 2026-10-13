package com.cablebilling.lineman.data.payments

import com.cablebilling.lineman.data.network.generated.PaymentMethod
import java.time.Instant
import java.time.ZoneId

/**
 * A payment the lineman confirmed and is about to save (PLAN §11.3 Confirm → Save). Money is integer
 * paise (whole rupees, D-17).
 *
 * [id] is the UUIDv7 made when the Confirm screen opened ([UuidV7]); it survives process death in the
 * screen's saved state, so tapping Save twice, or again after a restart, saves the payment once.
 */
data class PaymentDraft(
    val id: String,
    val customerId: String,
    val customerCode: String,
    val customerName: String,
    val amountPaise: Long,
    val method: PaymentMethod,
    /** UPI reference the lineman typed (UPI only); blank or skipped = null. */
    val upiReference: String? = null,
)

/** What [PaymentRepository.save] did. "Saved" may only be shown for [Saved]. */
sealed interface SaveResult {
    /** The payment is committed in Room (state SAVED_ON_PHONE, or later if it was saved before). */
    data class Saved(
        val paymentId: String,
        val provisionalRef: String,
        /** False when this id was already saved (a second tap, or a retry after a restart). */
        val isNew: Boolean,
    ) : SaveResult

    /** Nobody is signed in: there is no collector or device to save the payment for. Nothing was written. */
    data object NotSignedIn : SaveResult

    /** The draft breaks a rule the server would refuse (amount, UPI reference). Nothing was written. */
    data class Invalid(
        val reason: String,
    ) : SaveResult

    /** Room could not write (disk full, corrupt file …). Nothing was written; say "Not saved, try again". */
    data class Failed(
        val cause: Exception,
    ) : SaveResult
}

/** Rules every saved payment follows (the contract's `PaymentBatchItem`). */
object PaymentRules {
    /** The contract's MAX_AMOUNT_PAISE (13 rupee digits). */
    const val MAX_AMOUNT_PAISE: Long = 999_999_999_999_900L

    /** Longest amount the number pad accepts, in rupee digits (₹99,99,999). */
    const val MAX_RUPEE_DIGITS: Int = 7

    /** `upi_reference` is 1–64 characters after trimming. */
    const val MAX_UPI_REFERENCE: Int = 64

    const val PAISE_PER_RUPEE: Long = 100L

    /** India time: business dates and the Today totals (CLAUDE.md "Time"). */
    val BUSINESS_ZONE: ZoneId = ZoneId.of("Asia/Kolkata")

    /** `P-{device_code}-{seq}`, seq at least 4 digits (the contract's ProvisionalRef). */
    val PROVISIONAL_REF: Regex = Regex("^P-[A-Z0-9]{3}-[0-9]{4,9}$")

    /** `P-K7Q-`: what every provisional reference of [deviceCode] starts with. */
    fun provisionalPrefix(deviceCode: String): String = "P-$deviceCode-"

    /** The provisional reference for the [seq]th payment saved with [deviceCode]. */
    fun provisionalRef(
        deviceCode: String,
        seq: Int,
    ): String = provisionalPrefix(deviceCode) + "%04d".format(java.util.Locale.ROOT, seq)

    /** India-time date (`YYYY-MM-DD`) of an instant in epoch ms. */
    fun businessDate(epochMillis: Long): String =
        Instant
            .ofEpochMilli(epochMillis)
            .atZone(BUSINESS_ZONE)
            .toLocalDate()
            .toString()

    /** The UPI reference as stored and sent: trimmed, null when blank or the method is cash. */
    fun normalizedUpiReference(
        method: PaymentMethod,
        typed: String?,
    ): String? = typed?.trim()?.takeIf { method == PaymentMethod.UPI && it.isNotEmpty() }

    /** Why [draft] cannot be saved, or null when it is fine. */
    fun problem(draft: PaymentDraft): String? =
        when {
            !UuidV7.isValid(draft.id) -> {
                "id is not a UUIDv7"
            }

            draft.amountPaise <= 0 -> {
                "amount must be above zero"
            }

            draft.amountPaise > MAX_AMOUNT_PAISE -> {
                "amount too large"
            }

            draft.amountPaise % PAISE_PER_RUPEE != 0L -> {
                "whole rupees only"
            }

            (normalizedUpiReference(draft.method, draft.upiReference)?.length ?: 0) > MAX_UPI_REFERENCE -> {
                "UPI reference too long"
            }

            else -> {
                null
            }
        }
}
