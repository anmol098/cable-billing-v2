package com.cablebilling.lineman.feature.receipt

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.applyTo
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.network.generated.ReceiptActionType
import com.cablebilling.lineman.data.payments.PaymentReceipts
import com.cablebilling.lineman.data.payments.PaymentRepository
import com.cablebilling.lineman.data.receipts.LinkState
import com.cablebilling.lineman.data.receipts.PhoneNumbers
import com.cablebilling.lineman.data.receipts.ReceiptActionRecorder
import com.cablebilling.lineman.data.receipts.ReceiptLinks
import com.cablebilling.lineman.data.receipts.ReceiptMessages
import com.cablebilling.lineman.data.receipts.ReceiptPdfWriter
import com.cablebilling.lineman.data.receipts.ReceiptPhoneBook
import com.cablebilling.lineman.printing.receipt.ReceiptModel
import dagger.assisted.Assisted
import dagger.assisted.AssistedFactory
import dagger.assisted.AssistedInject
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import java.io.IOException

/**
 * Giving one payment's receipt by WhatsApp or SMS (PLAN §11.7, J-07):
 *
 * 1. **Confirm the number** (FR-004): the stored number in big digits, "Yes, this number" or
 *    "Change number" (number pad, 10 digits from 6–9). A change is queued for the office
 *    (`ReceiptPhoneBook`) and used at once.
 * 2. **Link**: asked for once the number is confirmed; offline or before the payment reached the
 *    office it is queued ("The link will be ready when there is internet") and turns ready by itself.
 * 3. **Open WhatsApp** (wa.me chat with the message and link) / **Open SMS** (`smsto:` with the
 *    link) / **Share PDF** (made on the phone, offline, provisional number until the office answers).
 *
 * Only what the phone sees is recorded (`whatsapp_opened`, `sms_opened`, `pdf_shared`). Nothing here
 * changes the payment (RULE-18): a failure shows a red line and "The payment is saved".
 */
@Suppress("LongParameterList", "TooManyFunctions") // DI collaborators; one public function per button.
@HiltViewModel(assistedFactory = ReceiptShareViewModel.Factory::class)
class ReceiptShareViewModel
    @AssistedInject
    constructor(
        @Assisted val paymentId: String,
        @Assisted val channel: ShareChannel,
        private val payments: PaymentRepository,
        private val sessions: SessionStore,
        private val phoneBook: ReceiptPhoneBook,
        private val links: ReceiptLinks,
        private val pdfs: ReceiptPdfWriter,
        private val messages: ReceiptMessages,
        private val actions: ReceiptActionRecorder,
        private val json: Json,
    ) : ViewModel() {
        private val local = MutableStateFlow(ReceiptShareUiState(channel))
        private val gettingLink = MutableStateFlow(false)
        private val linkWanted = MutableStateFlow(false)

        @OptIn(ExperimentalCoroutinesApi::class)
        private val linkState =
            linkWanted.flatMapLatest { wanted -> if (wanted) links.observe(paymentId) else flowOf(LinkState.None) }

        val state: StateFlow<ReceiptShareUiState> =
            combine(local, payments.observe(paymentId), linkState, gettingLink) { ui, payment, link, getting ->
                ui.copy(payment = payment?.let(::sharePayment), link = linkView(link, getting))
            }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS), local.value)

        init {
            viewModelScope.launch {
                val payment = payments.get(paymentId) ?: return@launch
                val known = phoneBook.phoneFor(payment.customerId).phone
                local.update {
                    it.copy(
                        phone =
                            if (known !=
                                null
                            ) {
                                PhoneStep.Confirm(known)
                            } else {
                                PhoneStep.Edit("", previous = null)
                            },
                    )
                }
            }
        }

        /** "Yes, this number". */
        fun confirmPhone() {
            val step = local.value.phone as? PhoneStep.Confirm ?: return
            usePhone(step.phone)
        }

        /** "Change number": type a new one (Back returns to the stored one). */
        fun changePhone() {
            val step = local.value.phone
            val previous =
                when (step) {
                    is PhoneStep.Confirm -> step.phone
                    is PhoneStep.Confirmed -> step.phone
                    else -> return
                }
            local.update { it.copy(phone = PhoneStep.Edit("", previous), problem = null) }
        }

        fun onKey(key: NumberPadKey) {
            local.update { ui ->
                val step = ui.phone as? PhoneStep.Edit ?: return@update ui
                ui.copy(phone = step.copy(digits = key.applyTo(step.digits, maxLength = PhoneNumbers.LENGTH)))
            }
        }

        /** "Use this number" on the pad (only for a valid number). */
        fun useTyped() {
            val step = local.value.phone as? PhoneStep.Edit ?: return
            if (PhoneNumbers.isValid(step.digits)) usePhone(step.digits)
        }

        /** Back while typing: to the stored number if there was one. Returns false when the screen should close. */
        fun back(): Boolean {
            val previous = (local.value.phone as? PhoneStep.Edit)?.previous
            if (previous != null) local.update { it.copy(phone = PhoneStep.Confirm(previous)) }
            return previous != null
        }

        private fun usePhone(phone: String) {
            local.update { it.copy(phone = PhoneStep.Confirmed(phone, changeQueued = false), problem = null) }
            viewModelScope.launch {
                val payment = payments.get(paymentId) ?: return@launch
                val queued = phoneBook.confirm(payment.customerId, phone)
                if (queued) {
                    local.update { ui ->
                        val step = ui.phone as? PhoneStep.Confirmed ?: return@update ui
                        ui.copy(phone = step.copy(changeQueued = step.phone == phone))
                    }
                }
            }
            requestLink()
        }

        private fun requestLink() {
            if (linkWanted.value) return
            linkWanted.value = true
            gettingLink.value = true
            viewModelScope.launch {
                try {
                    links.request(paymentId)
                } finally {
                    gettingLink.value = false
                }
            }
        }

        /** "Open WhatsApp" / "Open SMS": the message with the link, in the customer's chat / SMS app. */
        fun openMessage() {
            val ui = state.value
            val phone = (ui.phone as? PhoneStep.Confirmed)?.phone ?: return
            val link = ui.link as? LinkView.Ready ?: return
            viewModelScope.launch {
                val receipt = receipt() ?: return@launch
                val text = messages.withLink(receipt, link.url)
                val launch =
                    when (channel) {
                        ShareChannel.WhatsApp -> ShareLaunch.WhatsApp(phone, text)
                        ShareChannel.Sms -> ShareLaunch.Sms(phone, text)
                    }
                local.update { it.copy(launch = launch, problem = null) }
            }
        }

        /** "Share PDF": made now from the payment as it is (permanent number once the office answered). */
        fun sharePdf() {
            if (local.value.makingPdf) return
            local.update { it.copy(makingPdf = true, problem = null) }
            viewModelScope.launch {
                val receipt = receipt()
                val uri =
                    try {
                        receipt?.let { pdfs.uriFor(pdfs.write(paymentId, it)) }
                    } catch (ignored: IOException) {
                        null
                    } catch (ignored: IllegalArgumentException) {
                        null // FileProvider refused the path.
                    } catch (ignored: IllegalStateException) {
                        null // The PDF engine failed.
                    }
                val link = state.value.link as? LinkView.Ready
                val text = if (receipt != null && link != null) messages.withLink(receipt, link.url) else null
                local.update {
                    if (uri == null) {
                        it.copy(makingPdf = false, problem = ShareProblem.PdfFailed)
                    } else {
                        it.copy(makingPdf = false, launch = ShareLaunch.Pdf(uri, text))
                    }
                }
            }
        }

        /** The screen tried to open [launch]; [opened] = an app took it. Records only what happened. */
        fun onLaunched(
            launch: ShareLaunch,
            opened: Boolean,
        ) {
            if (local.value.launch != launch) return
            val what =
                when (launch) {
                    is ShareLaunch.WhatsApp -> Opened.WhatsApp
                    is ShareLaunch.Sms -> Opened.Sms
                    is ShareLaunch.Pdf -> Opened.Pdf
                }
            if (opened) actions.record(paymentId, what.action)
            local.update {
                it.copy(
                    launch = null,
                    opened = if (opened) it.opened + what else it.opened,
                    problem = if (opened) null else what.problem,
                )
            }
        }

        private suspend fun receipt(): ReceiptModel? {
            val payment = payments.get(paymentId)
            val session = sessions.session
            return if (payment != null && session != null) PaymentReceipts.model(payment, session, json) else null
        }

        private fun sharePayment(payment: PaymentEntity) =
            SharePayment(
                customerId = payment.customerId,
                customerName = payment.customerName,
                amountPaise = payment.amountPaise,
                number = PaymentReceipts.number(payment),
            )

        private fun linkView(
            link: LinkState,
            getting: Boolean,
        ): LinkView =
            when (link) {
                is LinkState.Ready -> LinkView.Ready(link.url)
                LinkState.Unavailable -> LinkView.Unavailable
                LinkState.Queued -> if (getting) LinkView.Getting else LinkView.Queued
                LinkState.None -> if (getting) LinkView.Getting else LinkView.None
            }

        @AssistedFactory
        interface Factory {
            fun create(
                paymentId: String,
                channel: ShareChannel,
            ): ReceiptShareViewModel
        }

        private companion object {
            const val STOP_TIMEOUT_MS = 5_000L
        }
    }

private val Opened.action: ReceiptActionType
    get() =
        when (this) {
            Opened.WhatsApp -> ReceiptActionType.WHATSAPP_OPENED
            Opened.Sms -> ReceiptActionType.SMS_OPENED
            Opened.Pdf -> ReceiptActionType.PDF_SHARED
        }

private val Opened.problem: ShareProblem
    get() =
        when (this) {
            Opened.WhatsApp -> ShareProblem.NoWhatsApp

            Opened.Sms -> ShareProblem.NoSms

            // The share sheet always exists; if even that failed, the PDF could not be handed over.
            Opened.Pdf -> ShareProblem.PdfFailed
        }
