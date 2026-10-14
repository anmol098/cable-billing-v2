package com.cablebilling.lineman.feature.today

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.designsystem.component.PaymentStatus
import com.cablebilling.designsystem.component.SpeakButton
import com.cablebilling.designsystem.component.StatusChip
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.Handover
import com.cablebilling.lineman.feature.collect.CallOfficeButton
import com.cablebilling.lineman.feature.collect.InfoLine
import com.cablebilling.lineman.feature.collect.word
import com.cablebilling.lineman.feature.login.OfficeDialer
import com.cablebilling.lineman.printing.receipt.ReceiptDates
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import com.cablebilling.lineman.voice.SpeakOnShow
import com.cablebilling.lineman.voice.spokenText
import java.time.LocalDate
import java.time.ZoneOffset
import com.cablebilling.designsystem.R as DesignR

/** Where the day's cash handover stands, in honest words (never "sent" before the server took it). */
@Composable
internal fun HandoverCard(
    view: HandoverView,
    actions: TodayActions,
) {
    TodayCard(modifier = Modifier.testTag(TodayTags.HANDOVER_CARD)) {
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_handover),
            tint = Tokens.Color.Text,
            text = stringResource(R.string.common_hand_over_cash),
        )
        when (view) {
            HandoverView.NotYet -> {
                StateLine(
                    PaymentStatus.SavedOnPhone,
                    R.string.mobile_today_status_not_yet,
                    DesignR.drawable.ic_cb_pending,
                )
            }

            is HandoverView.OnPhone -> {
                GaveLine(view.handedPaise)
                StateLine(
                    PaymentStatus.SavedOnPhone,
                    if (view.sending) R.string.mobile_today_status_sending else R.string.mobile_today_status_on_phone,
                )
                if (!view.sending) {
                    SmallButton(
                        R.string.mobile_today_status_try_now,
                        DesignR.drawable.ic_cb_next,
                        actions.onTryNow,
                        TodayTags.TRY_NOW,
                    )
                }
            }

            is HandoverView.Refused -> {
                GaveLine(view.handedPaise)
                val text =
                    when (view.code) {
                        REFUSED_TOTAL -> R.string.mobile_today_status_refused_total
                        REFUSED_ACCEPTED -> R.string.mobile_today_status_refused_accepted
                        else -> R.string.mobile_today_status_refused_other
                    }
                StateLine(PaymentStatus.NeedsHelp, text)
                if (text == R.string.mobile_today_status_refused_other) {
                    CallOfficeButton(onClick = actions.onCallOffice)
                }
            }

            is HandoverView.Submitted -> {
                Amounts(view.handover)
                StateLine(PaymentStatus.Sent, R.string.mobile_today_status_sent)
                StateLine(
                    PaymentStatus.SavedOnPhone,
                    R.string.mobile_today_status_waiting_check,
                    DesignR.drawable.ic_cb_handover,
                    TodayTags.HANDOVER_REVIEW,
                )
                SmallButton(
                    R.string.mobile_today_status_check_again,
                    DesignR.drawable.ic_cb_next,
                    actions.onCheckAgain,
                    TodayTags.CHECK_AGAIN,
                )
            }

            is HandoverView.Accepted -> {
                Amounts(view.handover)
                StateLine(PaymentStatus.Sent, R.string.mobile_today_status_accepted, tag = TodayTags.HANDOVER_REVIEW)
                OfficeNote(view.handover)
            }

            is HandoverView.SentBack -> {
                Amounts(view.handover)
                StateLine(
                    PaymentStatus.NeedsHelp,
                    R.string.mobile_today_status_sent_back,
                    DesignR.drawable.ic_cb_undo,
                    TodayTags.HANDOVER_REVIEW,
                )
                OfficeNote(view.handover)
            }
        }
    }
}

@Composable
private fun StateLine(
    status: PaymentStatus,
    text: Int,
    icon: Int = status.icon,
    tag: String = TodayTags.HANDOVER_STATE,
) {
    InfoLine(
        icon = painterResource(icon),
        tint =
            when (status) {
                PaymentStatus.SavedOnPhone -> CableTheme.semanticColors.pending
                PaymentStatus.Sent -> CableTheme.semanticColors.success
                PaymentStatus.NeedsHelp -> CableTheme.semanticColors.danger
            },
        text = stringResource(text),
        modifier = Modifier.testTag(tag),
    )
}

@Composable
private fun GaveLine(handedPaise: Long) {
    Text(
        text = stringResource(R.string.mobile_today_status_you_gave, Rupees.format(handedPaise)),
        style = MaterialTheme.typography.titleMedium,
        color = Tokens.Color.Text,
    )
}

/** The office's numbers for the handover: given, expected, and the difference it computed. */
@Composable
private fun Amounts(handover: Handover) {
    GaveLine(handover.cashHandedOverPaise)
    Text(
        text = stringResource(R.string.mobile_today_status_expected, Rupees.format(handover.cashExpectedPaise)),
        style = MaterialTheme.typography.bodyLarge,
        color = Tokens.Color.Text,
    )
    DifferenceLine(handover.discrepancyPaise, Modifier.testTag(TodayTags.HANDOVER_DIFFERENCE))
}

@Composable
private fun OfficeNote(handover: Handover) {
    handover.reviewNote?.takeIf { it.isNotBlank() }?.let { note ->
        Text(
            text = stringResource(R.string.mobile_today_status_office_note, note),
            style = MaterialTheme.typography.bodyLarge,
            color = Tokens.Color.Text,
            modifier = Modifier.testTag(TodayTags.HANDOVER_NOTE),
        )
    }
}

@Composable
private fun SmallButton(
    text: Int,
    icon: Int,
    onClick: () -> Unit,
    tag: String,
) {
    BigButton(
        text = stringResource(text),
        icon = painterResource(icon),
        onClick = onClick,
        style = BigButtonStyle.Secondary,
        modifier = Modifier.heightIn(min = CableSizes.TouchMin).testTag(tag),
    )
}

/** `last_error_code` of a handover the office refused because its cash total differs (VALIDATION). */
private val REFUSED_TOTAL = "server:${ErrorCode.VALIDATION.wire}"

/** `last_error_code` of a handover sent after the office had accepted the day. */
private val REFUSED_ACCEPTED = "server:${ErrorCode.HANDOVER_ALREADY_ACCEPTED.wire}"
