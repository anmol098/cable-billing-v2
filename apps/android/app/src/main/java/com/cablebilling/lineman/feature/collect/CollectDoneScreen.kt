package com.cablebilling.lineman.feature.collect

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.PaymentStatus
import com.cablebilling.designsystem.component.ReceiptActionTile
import com.cablebilling.designsystem.component.StatusChip
import com.cablebilling.designsystem.component.color
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.feature.login.OfficeDialer
import com.cablebilling.lineman.printing.receipt.ReceiptNumber
import com.cablebilling.lineman.voice.SpeakOnShow
import com.cablebilling.lineman.voice.VoiceLine
import com.cablebilling.designsystem.R as DesignR

/**
 * The Done screen with its ViewModel (PLAN §11.3 Done).
 *
 * @param onPrinterSetup a print failed because no printer is set up / paired / allowed.
 * @param onFinish "Done": back to the search home for the next customer.
 */
@Composable
fun CollectDoneScreen(
    paymentId: String,
    onPrinterSetup: () -> Unit,
    onFinish: () -> Unit,
    modifier: Modifier = Modifier,
    shareActions: ReceiptShareActions = ReceiptShareActions(),
    viewModel: CollectDoneViewModel =
        hiltViewModel<CollectDoneViewModel, CollectDoneViewModel.Factory>(key = paymentId) { it.create(paymentId) },
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    CollectDoneContent(
        state = state,
        savedVoice = viewModel.savedVoice,
        onPrint = viewModel::print,
        onPrinterSetup = onPrinterSetup,
        onCallOffice = { OfficeDialer.dial(context, state.officePhone) },
        onFinish = onFinish,
        shareActions = shareActions,
        modifier = modifier,
    )
}

/**
 * The Done screen without its ViewModel: a large tick, the amount, the receipt number (green
 * permanent, or amber temporary with "Saved on phone"), and four big tiles: Print, WhatsApp, SMS,
 * Done. "Money saved on phone" is read out when it shows.
 */
@Composable
fun CollectDoneContent(
    state: DoneUiState,
    savedVoice: VoiceLine?,
    onPrint: () -> Unit,
    onPrinterSetup: () -> Unit,
    onCallOffice: () -> Unit,
    onFinish: () -> Unit,
    modifier: Modifier = Modifier,
    shareActions: ReceiptShareActions = ReceiptShareActions(),
) {
    SpeakOnShow(savedVoice)
    SpeakOnShow(state.printVoice)
    Column(
        modifier =
            modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(CableSpacing.S4)
                .testTag(CollectTags.DONE_SCREEN),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        val payment = state.payment ?: return@Column
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_success),
            contentDescription = null,
            tint = CableTheme.semanticColors.success,
            modifier = Modifier.size(CableSizes.PrimaryButton),
        )
        Text(
            text = stringResource(R.string.mobile_collect_done_title),
            style = MaterialTheme.typography.headlineSmall,
            color = Tokens.Color.Text,
        )
        AmountDisplay(amountPaise = payment.amountPaise, modifier = Modifier.testTag(CollectTags.DONE_AMOUNT))
        Text(text = payment.customerName, style = MaterialTheme.typography.titleLarge, color = Tokens.Color.Text)
        ReceiptNumberBlock(payment)
        StatusChip(
            status = payment.status,
            text = stringResource(payment.status.word),
            modifier = Modifier.testTag(CollectTags.DONE_STATUS),
        )
        StatusNote(payment, onCallOffice)
        PrintProblemBlock(state.print, onPrinterSetup)
        ActionTiles(state.print, onPrint, onFinish, shareActions)
    }
}

/** "Receipt no." in green, or "Temporary no." in amber with the clock (it is only on the phone). */
@Composable
private fun ReceiptNumberBlock(payment: DonePayment) {
    val permanent = payment.number is ReceiptNumber.Permanent
    val color = if (permanent) CableTheme.semanticColors.success else CableTheme.semanticColors.pending
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.testTag(CollectTags.DONE_NUMBER)) {
        Text(
            text =
                stringResource(
                    numberLabel(permanent),
                ),
            style = MaterialTheme.typography.bodyLarge,
            color = Tokens.Color.TextMuted,
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (!permanent) {
                Icon(
                    painter = painterResource(DesignR.drawable.ic_cb_pending),
                    contentDescription = null,
                    tint = color,
                    modifier = Modifier.size(CableSizes.Icon),
                )
            }
            Text(text = payment.number.text, style = CableTheme.numericTypography.key, color = color)
        }
    }
}

private fun numberLabel(permanent: Boolean): Int =
    if (permanent) R.string.mobile_collect_done_receipt_no else R.string.mobile_collect_done_temporary_no

/** One honest line under the chip: when it goes, that the office will check it, or call the office. */
@Composable
private fun StatusNote(
    payment: DonePayment,
    onCallOffice: () -> Unit,
) {
    when {
        payment.status == PaymentStatus.SavedOnPhone -> {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_pending),
                tint = PaymentStatus.SavedOnPhone.color,
                text = stringResource(R.string.mobile_collect_done_goes_when_online),
                modifier = Modifier.testTag(CollectTags.DONE_NOTE),
            )
        }

        payment.status == PaymentStatus.NeedsHelp -> {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_danger),
                tint = PaymentStatus.NeedsHelp.color,
                text = stringResource(R.string.mobile_collect_done_problem),
                modifier = Modifier.testTag(CollectTags.DONE_NOTE),
            )
            CallOfficeButton(onClick = onCallOffice)
        }

        payment.officeWillCheck -> {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_danger),
                tint = CableTheme.semanticColors.pending,
                text = stringResource(R.string.mobile_collect_done_office_will_check),
                modifier = Modifier.testTag(CollectTags.DONE_NOTE),
            )
        }
    }
}

/** After a failed print: what went wrong, that the payment is safe, and printer setup when that fixes it. */
@Composable
private fun PrintProblemBlock(
    print: PrintState,
    onPrinterSetup: () -> Unit,
) {
    if (print !is PrintState.Failed) return
    Column(
        modifier = Modifier.fillMaxWidth().testTag(CollectTags.PRINT_PROBLEM),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S2),
    ) {
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_danger),
            tint = CableTheme.semanticColors.danger,
            text = stringResource(print.problem.message),
        )
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_success),
            tint = CableTheme.semanticColors.success,
            text = stringResource(R.string.mobile_printer_error_payment_safe),
        )
        if (print.problem.needsSetup) {
            BigButton(
                text = stringResource(R.string.mobile_collect_done_printer_setup),
                icon = painterResource(DesignR.drawable.ic_cb_print),
                onClick = onPrinterSetup,
                style = BigButtonStyle.Secondary,
                modifier = Modifier.testTag(CollectTags.PRINTER_SETUP),
            )
        }
    }
}

/** Print, WhatsApp / SMS, Done: two by two. */
@Composable
private fun ActionTiles(
    print: PrintState,
    onPrint: () -> Unit,
    onFinish: () -> Unit,
    shareActions: ReceiptShareActions,
) {
    val printState =
        when (print) {
            PrintState.Idle -> null
            PrintState.Printing -> stringResource(R.string.mobile_printer_setup_printing)
            PrintState.Printed -> stringResource(R.string.mobile_printer_setup_printed)
            is PrintState.Failed -> stringResource(R.string.common_retry)
        }
    Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
        ReceiptActionTile(
            text = stringResource(R.string.common_print),
            icon = painterResource(DesignR.drawable.ic_cb_print),
            onClick = onPrint,
            stateText = printState,
            enabled = print != PrintState.Printing,
            modifier = Modifier.weight(1f).testTag(CollectTags.PRINT),
        )
        ReceiptActionTile(
            text = stringResource(R.string.mobile_collect_done_whatsapp),
            icon = painterResource(DesignR.drawable.ic_cb_whatsapp),
            onClick = { shareActions.onWhatsApp?.invoke() },
            enabled = shareActions.onWhatsApp != null,
            modifier = Modifier.weight(1f).testTag(CollectTags.WHATSAPP),
        )
    }
    Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
        ReceiptActionTile(
            text = stringResource(R.string.mobile_collect_done_sms),
            icon = painterResource(DesignR.drawable.ic_cb_sms),
            onClick = { shareActions.onSms?.invoke() },
            enabled = shareActions.onSms != null,
            modifier = Modifier.weight(1f).testTag(CollectTags.SMS),
        )
        ReceiptActionTile(
            text = stringResource(R.string.common_done),
            icon = painterResource(DesignR.drawable.ic_cb_success),
            onClick = onFinish,
            modifier = Modifier.weight(1f).testTag(CollectTags.FINISH),
        )
    }
}

/** The word for a status chip (glossary: फ़ोन में सेव / ऑफिस पहुँच गया / दिक्कत). */
val PaymentStatus.word: Int
    get() =
        when (this) {
            PaymentStatus.SavedOnPhone -> R.string.common_saved_on_phone
            PaymentStatus.Sent -> R.string.common_sent_to_office
            PaymentStatus.NeedsHelp -> R.string.common_problem
        }
