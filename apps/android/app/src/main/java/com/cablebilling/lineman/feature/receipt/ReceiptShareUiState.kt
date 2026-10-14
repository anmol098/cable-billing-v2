package com.cablebilling.lineman.feature.receipt

import android.net.Uri
import androidx.annotation.Keep
import com.cablebilling.lineman.printing.receipt.ReceiptNumber
import kotlinx.serialization.Serializable

/** How the receipt goes to the customer (the Done screen's WhatsApp and SMS tiles). */
@Keep // A navigation argument: its serializer must survive R8.
@Serializable
enum class ShareChannel {
    WhatsApp,
    Sms,
}

/** The payment as the share screen shows it. Money is integer paise. */
data class SharePayment(
    val customerId: String,
    val customerName: String,
    val amountPaise: Long,
    val number: ReceiptNumber,
)

/** Step 1 (FR-004): the customer's number is confirmed or typed before anything is prepared. */
sealed interface PhoneStep {
    data object Loading : PhoneStep

    /** "Is this the customer's number?" with the stored number in big digits. */
    data class Confirm(
        val phone: String,
    ) : PhoneStep

    /** Typing a number on the pad. [previous] = the number to go back to (null when none was stored). */
    data class Edit(
        val digits: String,
        val previous: String?,
    ) : PhoneStep

    /** Confirmed: the share buttons show. [changeQueued] = a new number waits to go to the office. */
    data class Confirmed(
        val phone: String,
        val changeQueued: Boolean,
    ) : PhoneStep
}

/** The preview link as the screen shows it. */
sealed interface LinkView {
    data object None : LinkView

    data object Getting : LinkView

    /** "The link will be ready when there is internet." */
    data object Queued : LinkView

    data class Ready(
        val url: String,
    ) : LinkView

    /** The office refused the payment: no link (PDF still works). */
    data object Unavailable : LinkView
}

/** Something the lineman did that the phone can see (never "sent" / "delivered", RULE-19). */
enum class Opened { WhatsApp, Sms, Pdf }

/** Why a share did not open. The payment is untouched (RULE-18). */
enum class ShareProblem { NoWhatsApp, NoSms, PdfFailed }

/** An app to open now (consumed by the screen, then reported back with `onLaunched`). */
sealed interface ShareLaunch {
    data class WhatsApp(
        val phone: String,
        val text: String,
    ) : ShareLaunch

    data class Sms(
        val phone: String,
        val text: String,
    ) : ShareLaunch

    data class Pdf(
        val uri: Uri,
        val text: String?,
    ) : ShareLaunch
}

data class ReceiptShareUiState(
    val channel: ShareChannel,
    val payment: SharePayment? = null,
    val phone: PhoneStep = PhoneStep.Loading,
    val link: LinkView = LinkView.None,
    val makingPdf: Boolean = false,
    val opened: Set<Opened> = emptySet(),
    val problem: ShareProblem? = null,
    val launch: ShareLaunch? = null,
) {
    /** Open WhatsApp / Open SMS: needs the confirmed number and the link. */
    val canOpenMessage: Boolean get() = phone is PhoneStep.Confirmed && link is LinkView.Ready && launch == null

    val canSharePdf: Boolean get() = phone is PhoneStep.Confirmed && payment != null && !makingPdf && launch == null
}
