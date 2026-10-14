package com.cablebilling.lineman.feature.collect

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.designsystem.component.PaymentStatus
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.network.generated.ReceiptActionType
import com.cablebilling.lineman.data.payments.PaymentReceipts
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.receipts.ReceiptActionRecorder
import com.cablebilling.lineman.printing.PrintProblem
import com.cablebilling.lineman.printing.PrintResult
import com.cablebilling.lineman.printing.ReceiptPrinter
import com.cablebilling.lineman.printing.receipt.ReceiptNumber
import com.cablebilling.lineman.voice.VoiceLine
import com.cablebilling.lineman.voice.VoiceLines
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.onStart
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import com.cablebilling.lineman.data.network.generated.PaymentMethod as WireMethod

/** A saved payment as the Done screen shows it. Money is integer paise. */
data class DonePayment(
    val id: String,
    val customerName: String,
    val amountPaise: Long,
    val method: PaymentMethod,
    /** Permanent `R-…` once the office answered, else the provisional `P-…` (amber, "temporary"). */
    val number: ReceiptNumber,
    val status: PaymentStatus,
    /** Posted, but the office will check it (`posted_needs_review`): the money is safe. */
    val officeWillCheck: Boolean,
) {
    companion object {
        fun from(payment: PaymentEntity): DonePayment =
            DonePayment(
                id = payment.id,
                customerName = payment.customerName,
                amountPaise = payment.amountPaise,
                method = if (payment.method == WireMethod.UPI) PaymentMethod.Upi else PaymentMethod.Cash,
                number = PaymentReceipts.number(payment),
                status = payment.state.status,
                officeWillCheck = payment.state == PaymentState.SENT_TO_OFFICE && payment.reviewReason != null,
            )
    }
}

/** The honest chip for a queue state (BR-11): saved on phone, sent to office, or a problem. */
val PaymentState.status: PaymentStatus
    get() =
        when (this) {
            PaymentState.SAVED_ON_PHONE -> PaymentStatus.SavedOnPhone
            PaymentState.SENT_TO_OFFICE -> PaymentStatus.Sent
            PaymentState.NEEDS_OFFICE_HELP -> PaymentStatus.NeedsHelp
        }

/** The Print tile (T-068's printer). */
sealed interface PrintState {
    data object Idle : PrintState

    data object Printing : PrintState

    /** Every byte reached the printer ("The printer got it. Check the paper."). */
    data object Printed : PrintState

    data class Failed(
        val problem: PrintProblem,
    ) : PrintState
}

/** Everything the Done screen shows. */
data class DoneUiState(
    val loading: Boolean = true,
    val payment: DonePayment? = null,
    val officePhone: String? = null,
    val print: PrintState = PrintState.Idle,
    /** Spoken after a print: the result in words. */
    val printVoice: VoiceLine? = null,
)

/**
 * The Done screen (PLAN §11.3): the saved payment, live from Room, so its receipt number turns from
 * the amber provisional `P-…` to the green permanent `R-…` as soon as the push gets the office's
 * answer. Print goes to the Bluetooth printer (T-068); printing never touches the payment (RULE-18).
 */
@HiltViewModel(assistedFactory = CollectDoneViewModel.Factory::class)
class CollectDoneViewModel
    @AssistedInject
    constructor(
        @Assisted val paymentId: String,
        private val payments: PaymentRepository,
        private val sessions: SessionStore,
        private val printer: ReceiptPrinter,
        private val voiceLines: VoiceLines,
        private val json: Json,
        // T-069: printed / print_failed go to the receipt-action outbox (never touches the payment).
        private val receiptActions: ReceiptActionRecorder = ReceiptActionRecorder.None,
    ) : ViewModel() {
        private val printState = MutableStateFlow<Pair<PrintState, VoiceLine?>>(PrintState.Idle to null)

        private data class Loaded(
            val payment: PaymentEntity?,
        )

        val state: StateFlow<DoneUiState> =
            combine(
                payments.observe(paymentId).map { Loaded(it) }.onStart<Loaded?> { emit(null) },
                sessions.state,
                printState,
            ) { loaded, session, (print, printVoice) ->
                DoneUiState(
                    loading = loaded == null,
                    payment = loaded?.payment?.let(DonePayment::from),
                    officePhone = (session as? SessionState.SignedIn)?.session?.operator?.officePhone,
                    print = print,
                    printVoice = printVoice,
                )
            }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), DoneUiState())

        /** "पैसे फ़ोन में सेव हो गए": spoken once when the screen shows (never "sent", BR-11). */
        val savedVoice: VoiceLine = voiceLines.moneySaved()

        /** Prints the receipt (permanent number if the office answered, else provisional). */
        fun print() {
            if (printState.value.first == PrintState.Printing) return
            printState.value = PrintState.Printing to null
            viewModelScope.launch {
                val payment = payments.get(paymentId)
                val session = sessions.session
                val result =
                    if (payment == null || session == null) {
                        PrintResult.Failed(PrintProblem.Failed)
                    } else {
                        printer.print(PaymentReceipts.model(payment, session, json))
                    }
                if (payment != null) {
                    val action =
                        if (result ==
                            PrintResult.Printed
                        ) {
                            ReceiptActionType.PRINTED
                        } else {
                            ReceiptActionType.PRINT_FAILED
                        }
                    receiptActions.record(payment.id, action)
                }
                printState.value =
                    when (result) {
                        PrintResult.Printed -> {
                            PrintState.Printed to voiceLines.line(R.string.mobile_printer_setup_printed)
                        }

                        is PrintResult.Failed -> {
                            PrintState.Failed(result.problem) to voiceLines.line(result.problem.message)
                        }
                    }
            }
        }

        @AssistedFactory
        interface Factory {
            fun create(paymentId: String): CollectDoneViewModel
        }

        private companion object {
            const val STOP_TIMEOUT_MS = 5_000L
        }
    }
