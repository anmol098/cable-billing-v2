package com.cablebilling.lineman.feature.collect

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.designsystem.component.applyTo
import com.cablebilling.lineman.data.payments.PaymentDraft
import com.cablebilling.lineman.data.payments.PaymentRules
import com.cablebilling.lineman.data.payments.SaveResult
import com.cablebilling.lineman.voice.VoiceLines
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import com.cablebilling.lineman.data.network.generated.PaymentMethod as WireMethod

/**
 * The collect flow for one customer (PLAN §11.3): Amount (pre-filled with the due, quick amounts,
 * number pad) → Method (Cash / UPI) → UPI reference (optional, Skip) → Confirm (read aloud) → Save.
 *
 * Everything typed, the step and the payment id live in [SavedStateHandle], so the flow comes back
 * as it was after process death. The payment id (UUIDv7) is made when Confirm first opens and kept
 * for the whole flow: Save tapped twice, or again after a restart, saves one payment.
 */
@Suppress("TooManyFunctions") // One small function per thing the lineman can do on these screens.
@HiltViewModel(assistedFactory = CollectViewModel.Factory::class)
class CollectViewModel
    @AssistedInject
    constructor(
        @Assisted val customerId: String,
        private val data: CollectData,
        private val voiceLines: VoiceLines,
        private val saved: SavedStateHandle,
    ) : ViewModel() {
        private val saving = MutableStateFlow(SaveState())

        private data class SaveState(
            val running: Boolean = false,
            val problem: CollectProblem? = null,
            val savedPaymentId: String? = null,
        )

        private data class Cached(
            val customer: CollectCustomer?,
        )

        private data class Draft(
            val step: CollectStep,
            val digits: String,
            val method: PaymentMethod?,
            val upiReference: String,
        )

        private val draft =
            combine(
                saved.getStateFlow(KEY_STEP, CollectStep.Amount.name),
                saved.getStateFlow(KEY_DIGITS, ""),
                saved.getStateFlow<String?>(KEY_METHOD, null),
                saved.getStateFlow(KEY_UPI, ""),
            ) { step, digits, method, upi ->
                Draft(
                    step = CollectStep.valueOf(step),
                    digits = digits,
                    method = method?.let(PaymentMethod::valueOf),
                    upiReference = upi,
                )
            }

        /** The customer, read eagerly (Save does not depend on the screen collecting [state]); null = not read yet. */
        private val cachedCustomer: StateFlow<Cached?> =
            data.customer(customerId).map { Cached(it) }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

        val state: StateFlow<CollectUiState> =
            combine(
                cachedCustomer,
                draft,
                saving,
            ) { cached, draft, save ->
                val customer = cached?.customer
                val amountPaise = (draft.digits.toLongOrNull() ?: 0L) * PaymentRules.PAISE_PER_RUPEE
                CollectUiState(
                    loading = cached == null,
                    customer = customer,
                    step = draft.step,
                    amountDigits = draft.digits,
                    method = draft.method,
                    upiReference = draft.upiReference,
                    saving = save.running,
                    problem = save.problem,
                    savedPaymentId = save.savedPaymentId,
                    confirmVoice =
                        if (customer != null && draft.method != null && draft.step == CollectStep.Confirm) {
                            voiceLines.collected(customer.name, amountPaise, draft.method)
                        } else {
                            null
                        },
                )
            }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), CollectUiState())

        init {
            viewModelScope.launch {
                val customer = cachedCustomer.filterNotNull().first().customer
                if (saved.get<Boolean>(KEY_PREFILLED) != true && customer != null) {
                    if (customer.duePaise > 0) setAmount(CollectUiState.roundUpToRupees(customer.duePaise))
                    saved[KEY_PREFILLED] = true
                }
            }
        }

        private val step: CollectStep get() = CollectStep.valueOf(saved[KEY_STEP] ?: CollectStep.Amount.name)
        private val digits: String get() = saved[KEY_DIGITS] ?: ""
        private val method: PaymentMethod? get() = saved.get<String>(KEY_METHOD)?.let(PaymentMethod::valueOf)

        /** A number-pad key on the Amount screen. The first key after a pre-fill or a chip starts afresh. */
        fun onKey(key: NumberPadKey) {
            if (step != CollectStep.Amount) return
            val fresh = saved.get<Boolean>(KEY_FRESH) == true
            val start = if (fresh && (key is NumberPadKey.Digit || key == NumberPadKey.DoubleZero)) "" else digits
            saved[KEY_DIGITS] = key.applyTo(start, maxLength = PaymentRules.MAX_RUPEE_DIGITS, trimLeadingZeros = true)
            saved[KEY_FRESH] = false
            clearProblem()
        }

        /** A quick amount chip (full due, ₹100 …): replaces the amount. */
        fun onQuickAmount(paise: Long) {
            if (step != CollectStep.Amount) return
            setAmount(paise)
        }

        /** Amount → Method. */
        fun onAmountDone() {
            if (step == CollectStep.Amount &&
                (digits.toLongOrNull() ?: 0L) > 0
            ) {
                saved[KEY_STEP] = CollectStep.Method.name
            }
        }

        /** Cash → Confirm; UPI → the optional reference first. */
        fun onMethod(method: PaymentMethod) {
            if (step != CollectStep.Method) return
            saved[KEY_METHOD] = method.name
            if (method == PaymentMethod.Upi) {
                saved[KEY_STEP] = CollectStep.UpiReference.name
            } else {
                saved[KEY_UPI] = ""
                toConfirm()
            }
        }

        fun onUpiReferenceChange(text: String) {
            saved[KEY_UPI] = text.take(PaymentRules.MAX_UPI_REFERENCE)
        }

        /** "Skip": no reference (it is optional, BR-10). */
        fun onUpiSkip() {
            if (step != CollectStep.UpiReference) return
            saved[KEY_UPI] = ""
            toConfirm()
        }

        fun onUpiDone() {
            if (step == CollectStep.UpiReference) toConfirm()
        }

        /**
         * One step back. Returns false on the Amount screen (the caller leaves the flow). Never after
         * the payment is saved: the flow is then finished.
         */
        fun onBack(): Boolean {
            val previous = if (saving.value.running) step else previousStep()
            if (previous != null && previous != step) {
                saved[KEY_STEP] = previous.name
                clearProblem()
            }
            return previous != null
        }

        private fun previousStep(): CollectStep? =
            when (step) {
                CollectStep.Amount -> null
                CollectStep.Method -> CollectStep.Amount
                CollectStep.UpiReference -> CollectStep.Method
                CollectStep.Confirm -> if (method == PaymentMethod.Upi) CollectStep.UpiReference else CollectStep.Method
            }

        /**
         * Saves the payment on the phone. "Saved" (the Done screen) follows only after Room committed it
         * ([CollectUiState.savedPaymentId]).
         */
        fun save() {
            val customer = cachedCustomer.value?.customer
            val chosen = method
            val save = saving.value
            val ready = step == CollectStep.Confirm && !save.running && save.savedPaymentId == null
            if (customer == null || chosen == null || !ready) return
            val amountPaise = (digits.toLongOrNull() ?: 0L) * PaymentRules.PAISE_PER_RUPEE
            val upiReference: String = saved[KEY_UPI] ?: ""
            val paymentId = paymentId()
            saving.value = SaveState(running = true)
            viewModelScope.launch {
                val result =
                    data.save(
                        PaymentDraft(
                            id = paymentId,
                            customerId = customer.id,
                            customerCode = customer.code,
                            customerName = customer.name,
                            amountPaise = amountPaise,
                            method = if (chosen == PaymentMethod.Upi) WireMethod.UPI else WireMethod.CASH,
                            upiReference = upiReference.takeIf { chosen == PaymentMethod.Upi },
                        ),
                    )
                saving.value =
                    when (result) {
                        is SaveResult.Saved -> SaveState(savedPaymentId = result.paymentId)
                        SaveResult.NotSignedIn -> SaveState(problem = CollectProblem.SignedOut)
                        is SaveResult.Invalid, is SaveResult.Failed -> SaveState(problem = CollectProblem.NotSaved)
                    }
            }
        }

        private fun toConfirm() {
            paymentId()
            saved[KEY_STEP] = CollectStep.Confirm.name
        }

        /** The flow's payment id, made once (before the payment is saved) and kept. */
        private fun paymentId(): String =
            saved.get<String>(KEY_PAYMENT_ID) ?: data.newPaymentId().also { saved[KEY_PAYMENT_ID] = it }

        private fun setAmount(paise: Long) {
            saved[KEY_DIGITS] = (paise / PaymentRules.PAISE_PER_RUPEE).toString()
            saved[KEY_FRESH] = true
            clearProblem()
        }

        private fun clearProblem() {
            if (saving.value.problem != null) saving.value = SaveState()
        }

        @AssistedFactory
        interface Factory {
            fun create(customerId: String): CollectViewModel
        }

        companion object {
            const val KEY_STEP = "collect_step"
            const val KEY_DIGITS = "collect_amount_digits"
            const val KEY_FRESH = "collect_amount_fresh"
            const val KEY_PREFILLED = "collect_prefilled"
            const val KEY_METHOD = "collect_method"
            const val KEY_UPI = "collect_upi_reference"
            const val KEY_PAYMENT_ID = "collect_payment_id"
            private const val STOP_TIMEOUT_MS = 5_000L
        }
    }
