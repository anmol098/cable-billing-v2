package com.cablebilling.lineman.feature.receipt

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.NumberPad
import com.cablebilling.designsystem.component.NumberPadExtraKey
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.receipts.PhoneNumbers
import com.cablebilling.lineman.data.receipts.ReceiptIntents
import com.cablebilling.lineman.feature.collect.BackRow
import com.cablebilling.lineman.feature.collect.InfoLine
import com.cablebilling.designsystem.R as DesignR

/**
 * The receipt share screen with its ViewModel. [launcher] opens WhatsApp / the SMS app / the share
 * sheet (tests pass a fake); [onClose] returns to the Done screen.
 */
@Composable
fun ReceiptShareScreen(
    paymentId: String,
    channel: ShareChannel,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    launcher: ShareLauncher? = null,
    viewModel: ReceiptShareViewModel =
        hiltViewModel<ReceiptShareViewModel, ReceiptShareViewModel.Factory>(key = "$paymentId-$channel") {
            it.create(paymentId, channel)
        },
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    val shareLauncher = launcher ?: remember(context) { ActivityShareLauncher(context) }
    val chooserTitle = stringResource(R.string.mobile_receipt_pdf_share)
    LaunchedEffect(state.launch) {
        val launch = state.launch ?: return@LaunchedEffect
        viewModel.onLaunched(launch, shareLauncher.launch(launch.intents(chooserTitle)))
    }
    val back = { if (!viewModel.back()) onClose() }
    BackHandler(onBack = back)
    ReceiptShareContent(
        state = state,
        actions =
            ShareScreenActions(
                onBack = back,
                onConfirmPhone = viewModel::confirmPhone,
                onChangePhone = viewModel::changePhone,
                onKey = viewModel::onKey,
                onUseTyped = viewModel::useTyped,
                onOpen = viewModel::openMessage,
                onSharePdf = viewModel::sharePdf,
                onDone = onClose,
            ),
        modifier = modifier,
    )
}

/** What the share screen's buttons do. */
data class ShareScreenActions(
    val onBack: () -> Unit = {},
    val onConfirmPhone: () -> Unit = {},
    val onChangePhone: () -> Unit = {},
    val onKey: (NumberPadKey) -> Unit = {},
    val onUseTyped: () -> Unit = {},
    val onOpen: () -> Unit = {},
    val onSharePdf: () -> Unit = {},
    val onDone: () -> Unit = {},
)

private fun ShareLaunch.intents(chooserTitle: String): List<Intent> =
    when (this) {
        is ShareLaunch.WhatsApp -> ReceiptIntents.whatsApp(phone, text)
        is ShareLaunch.Sms -> ReceiptIntents.sms(phone, text)
        is ShareLaunch.Pdf -> ReceiptIntents.pdf(uri, text, chooserTitle)
    }

/** The share screen without its ViewModel: the payment, then one step at a time (number, then share). */
@Composable
fun ReceiptShareContent(
    state: ReceiptShareUiState,
    actions: ShareScreenActions,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().testTag(ReceiptShareTags.SCREEN)) {
        BackRow(onBack = actions.onBack)
        Column(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = CableSpacing.S4, vertical = CableSpacing.S2),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Header(state)
            when (val step = state.phone) {
                PhoneStep.Loading -> Unit
                is PhoneStep.Confirm -> ConfirmPhone(step, actions)
                is PhoneStep.Edit -> EditPhone(step, actions)
                is PhoneStep.Confirmed -> ShareStep(state, step, actions)
            }
        }
    }
}

@Composable
private fun Header(state: ReceiptShareUiState) {
    Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            painter = painterResource(state.channel.icon),
            contentDescription = null,
            tint = Tokens.Color.Text,
            modifier = Modifier.size(CableSizes.Icon),
        )
        Text(
            text = stringResource(state.channel.title),
            style = MaterialTheme.typography.titleLarge,
            color = Tokens.Color.Text,
        )
    }
    val payment = state.payment ?: return
    AmountDisplay(
        amountPaise = payment.amountPaise,
        style = CableTheme.numericTypography.amountSmall,
        modifier = Modifier.testTag(ReceiptShareTags.AMOUNT),
    )
    Text(text = payment.customerName, style = MaterialTheme.typography.titleMedium, color = Tokens.Color.Text)
    Text(
        text = payment.number.text,
        style = CableTheme.numericTypography.body,
        color = Tokens.Color.TextMuted,
        modifier = Modifier.testTag(ReceiptShareTags.NUMBER),
    )
}

@Composable
private fun PhoneDigits(
    text: String,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        style = CableTheme.numericTypography.key,
        color = Tokens.Color.Text,
        textAlign = TextAlign.Center,
        modifier = modifier.fillMaxWidth().testTag(ReceiptShareTags.PHONE),
    )
}

/** "Is this the customer's number?" — Yes / Change. */
@Composable
private fun ConfirmPhone(
    step: PhoneStep.Confirm,
    actions: ShareScreenActions,
) {
    Text(
        text = stringResource(R.string.mobile_receipt_phone_label),
        style = MaterialTheme.typography.bodyLarge,
        color = Tokens.Color.TextMuted,
    )
    PhoneDigits(PhoneNumbers.display(step.phone))
    Text(
        text = stringResource(R.string.mobile_receipt_phone_question),
        style = MaterialTheme.typography.titleMedium,
        color = Tokens.Color.Text,
    )
    BigButton(
        text = stringResource(R.string.mobile_receipt_phone_yes),
        icon = painterResource(DesignR.drawable.ic_cb_success),
        onClick = actions.onConfirmPhone,
        style = BigButtonStyle.Success,
        modifier = Modifier.testTag(ReceiptShareTags.PHONE_YES),
    )
    BigButton(
        text = stringResource(R.string.mobile_receipt_phone_change),
        icon = painterResource(DesignR.drawable.ic_cb_edit),
        onClick = actions.onChangePhone,
        style = BigButtonStyle.Secondary,
        modifier = Modifier.testTag(ReceiptShareTags.PHONE_CHANGE),
    )
}

/** Typing the number on the pad: 10 digits from 6–9, then "Use this number". */
@Composable
private fun EditPhone(
    step: PhoneStep.Edit,
    actions: ShareScreenActions,
) {
    val title = if (step.previous == null) R.string.mobile_receipt_phone_missing else R.string.mobile_receipt_phone_type
    Text(text = stringResource(title), style = MaterialTheme.typography.titleMedium, color = Tokens.Color.Text)
    PhoneDigits(
        text = PhoneNumbers.display(step.digits),
        modifier = Modifier.testTag(ReceiptShareTags.PHONE_TYPED),
    )
    val valid = PhoneNumbers.isValid(step.digits)
    val wrong = step.digits.length == PhoneNumbers.LENGTH && !valid
    Text(
        text = stringResource(R.string.mobile_receipt_phone_invalid),
        style = MaterialTheme.typography.bodyLarge,
        color = if (wrong) CableTheme.semanticColors.danger else Tokens.Color.TextMuted,
        modifier = Modifier.testTag(ReceiptShareTags.PHONE_HINT),
    )
    NumberPad(
        onKey = actions.onKey,
        deleteLabel = stringResource(R.string.mobile_designsystem_numpad_delete),
        extraKey = NumberPadExtraKey.None,
    )
    BigButton(
        text = stringResource(R.string.mobile_receipt_phone_use),
        icon = painterResource(DesignR.drawable.ic_cb_success),
        onClick = actions.onUseTyped,
        enabled = valid,
        modifier = Modifier.testTag(ReceiptShareTags.PHONE_USE),
    )
}

/** The number is confirmed: link state, the one main button, Share PDF (WhatsApp), and Done. */
@Composable
private fun ShareStep(
    state: ReceiptShareUiState,
    step: PhoneStep.Confirmed,
    actions: ShareScreenActions,
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2)) {
        Text(
            text = PhoneNumbers.display(step.phone),
            style = CableTheme.numericTypography.body,
            color = Tokens.Color.Text,
            modifier = Modifier.testTag(ReceiptShareTags.PHONE),
        )
        TextButton(
            onClick = actions.onChangePhone,
            modifier = Modifier.heightIn(min = CableSizes.TouchMin).testTag(ReceiptShareTags.PHONE_CHANGE),
        ) {
            Icon(
                painter = painterResource(DesignR.drawable.ic_cb_edit),
                contentDescription = null,
                modifier = Modifier.size(CableSizes.Icon),
            )
            Text(text = stringResource(R.string.common_change), style = MaterialTheme.typography.labelLarge)
        }
    }
    if (step.changeQueued) {
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_pending),
            tint = CableTheme.semanticColors.pending,
            text = stringResource(R.string.mobile_receipt_phone_queued),
            modifier = Modifier.fillMaxWidth().testTag(ReceiptShareTags.PHONE_QUEUED),
        )
    }
    LinkLine(state.link)
    BigButton(
        text = stringResource(state.channel.openText),
        icon = painterResource(state.channel.icon),
        onClick = actions.onOpen,
        enabled = state.canOpenMessage,
        modifier = Modifier.testTag(ReceiptShareTags.OPEN),
    )
    if (state.channel == ShareChannel.WhatsApp) {
        BigButton(
            text =
                stringResource(
                    if (state.makingPdf) R.string.mobile_receipt_pdf_making else R.string.mobile_receipt_pdf_share,
                ),
            icon = painterResource(DesignR.drawable.ic_cb_share),
            onClick = actions.onSharePdf,
            enabled = state.canSharePdf,
            style = BigButtonStyle.Secondary,
            modifier = Modifier.testTag(ReceiptShareTags.PDF),
        )
    }
    Opened.entries.filter { it in state.opened }.forEach { opened ->
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_success),
            tint = CableTheme.semanticColors.success,
            text = stringResource(opened.word),
            modifier = Modifier.fillMaxWidth().testTag(ReceiptShareTags.OPENED),
        )
    }
    state.problem?.let { problem -> ProblemBlock(problem) }
    BigButton(
        text = stringResource(R.string.common_done),
        icon = painterResource(DesignR.drawable.ic_cb_success),
        onClick = actions.onDone,
        style = BigButtonStyle.Secondary,
        modifier = Modifier.testTag(ReceiptShareTags.DONE),
    )
}

@Composable
private fun LinkLine(link: LinkView) {
    val (icon, tint, text) =
        when (link) {
            LinkView.None -> {
                return
            }

            LinkView.Getting -> {
                Triple(
                    DesignR.drawable.ic_cb_pending,
                    CableTheme.semanticColors.pending,
                    R.string.mobile_receipt_link_getting,
                )
            }

            LinkView.Queued -> {
                Triple(
                    DesignR.drawable.ic_cb_pending,
                    CableTheme.semanticColors.pending,
                    R.string.mobile_receipt_link_after_sync,
                )
            }

            is LinkView.Ready -> {
                Triple(
                    DesignR.drawable.ic_cb_success,
                    CableTheme.semanticColors.success,
                    R.string.mobile_receipt_link_ready,
                )
            }

            LinkView.Unavailable -> {
                Triple(
                    DesignR.drawable.ic_cb_danger,
                    CableTheme.semanticColors.danger,
                    R.string.mobile_receipt_link_unavailable,
                )
            }
        }
    InfoLine(
        icon = painterResource(icon),
        tint = tint,
        text = stringResource(text),
        modifier = Modifier.fillMaxWidth().testTag(ReceiptShareTags.LINK),
    )
}

/** What did not open, and that the payment is safe (RULE-18). */
@Composable
private fun ProblemBlock(problem: ShareProblem) {
    Column(
        modifier = Modifier.fillMaxWidth().testTag(ReceiptShareTags.PROBLEM),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S2),
    ) {
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_danger),
            tint = CableTheme.semanticColors.danger,
            text = stringResource(problem.message),
        )
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_success),
            tint = CableTheme.semanticColors.success,
            text = stringResource(R.string.mobile_receipt_payment_safe),
        )
    }
}

private val ShareChannel.icon: Int
    get() =
        when (this) {
            ShareChannel.WhatsApp -> DesignR.drawable.ic_cb_whatsapp
            ShareChannel.Sms -> DesignR.drawable.ic_cb_sms
        }

private val ShareChannel.title: Int
    get() =
        when (this) {
            ShareChannel.WhatsApp -> R.string.mobile_receipt_title_whatsapp
            ShareChannel.Sms -> R.string.mobile_receipt_title_sms
        }

private val ShareChannel.openText: Int
    get() =
        when (this) {
            ShareChannel.WhatsApp -> R.string.mobile_receipt_whatsapp_open
            ShareChannel.Sms -> R.string.mobile_receipt_sms_open
        }

/** Honest words (glossary "States"): opened / shared, never sent or delivered. */
internal val Opened.word: Int
    get() =
        when (this) {
            Opened.WhatsApp -> R.string.common_whatsapp_opened
            Opened.Sms -> R.string.common_sms_opened
            Opened.Pdf -> R.string.mobile_receipt_pdf_shared
        }

internal val ShareProblem.message: Int
    get() =
        when (this) {
            ShareProblem.NoWhatsApp -> R.string.mobile_receipt_whatsapp_missing
            ShareProblem.NoSms -> R.string.mobile_receipt_sms_missing
            ShareProblem.PdfFailed -> R.string.mobile_receipt_pdf_failed
        }
