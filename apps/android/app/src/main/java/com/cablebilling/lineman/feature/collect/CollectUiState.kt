package com.cablebilling.lineman.feature.collect

import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.lineman.data.payments.PaymentRules
import com.cablebilling.lineman.voice.VoiceLine

/** The collect flow's screens (PLAN §11.3), one job each: Amount → Method → (UPI ref) → Confirm. */
enum class CollectStep { Amount, Method, UpiReference, Confirm }

/** Why Save did not save. Nothing was written in either case. */
enum class CollectProblem {
    /** Room could not write (or the draft broke a rule): "Not saved. Try again." */
    NotSaved,

    /** Nobody is signed in any more: sign in, then collect again. */
    SignedOut,
}

/** Everything the collect flow shows. Money is integer paise; the lineman types whole rupees (D-17). */
data class CollectUiState(
    /** The customer has not been read from the phone yet. */
    val loading: Boolean = true,
    val customer: CollectCustomer? = null,
    val step: CollectStep = CollectStep.Amount,
    /** Whole rupees as typed on the pad ("" = nothing yet). */
    val amountDigits: String = "",
    val method: PaymentMethod? = null,
    /** UPI reference as typed (optional; "" = none). */
    val upiReference: String = "",
    /** Save is running (the button is disabled; "Saved" is never shown before it commits). */
    val saving: Boolean = false,
    val problem: CollectProblem? = null,
    /** Set once the payment is committed in Room: the screen moves to Done with this id. */
    val savedPaymentId: String? = null,
    /** Confirm screen read-out: "रमेश कुमार से पाँच सौ रुपये नकद". */
    val confirmVoice: VoiceLine? = null,
) {
    val amountPaise: Long get() = (amountDigits.toLongOrNull() ?: 0L) * PaymentRules.PAISE_PER_RUPEE

    /** The Amount screen's Next button. */
    val canContinue: Boolean get() = amountPaise > 0

    /** The customer is not on the phone's list (removed by the office). */
    val notFound: Boolean get() = !loading && customer == null

    /** Quick amounts (PLAN §11.3 Amount): the full due first (when there is one), then ₹100, ₹200, ₹500. */
    val quickAmountsPaise: List<Long>
        get() {
            val due = customer?.duePaise?.takeIf { it > 0 }?.let(::roundUpToRupees)
            return listOfNotNull(due) + QUICK_AMOUNTS_PAISE.filter { it != due }
        }

    companion object {
        val QUICK_AMOUNTS_PAISE: List<Long> = listOf(10_000L, 20_000L, 50_000L)

        /** Whole rupees only (D-17): a due with paise is pre-filled rounded up, so "full due" clears it. */
        fun roundUpToRupees(paise: Long): Long {
            val perRupee = PaymentRules.PAISE_PER_RUPEE
            return (paise + perRupee - 1) / perRupee * perRupee
        }
    }
}
