package com.cablebilling.lineman.feature.waiting

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
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
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.PaymentStatus
import com.cablebilling.designsystem.component.StatusChip
import com.cablebilling.designsystem.component.color
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.sync.PushStatus
import com.cablebilling.lineman.feature.collect.CallOfficeButton
import com.cablebilling.lineman.feature.collect.InfoLine
import com.cablebilling.lineman.feature.collect.word
import com.cablebilling.lineman.feature.login.OfficeDialer
import com.cablebilling.lineman.printing.receipt.ReceiptDates
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import java.time.Instant
import com.cablebilling.designsystem.R as DesignR

/** The Waiting tab with its ViewModel (PLAN §11.3 Waiting). */
@Composable
fun WaitingScreen(
    modifier: Modifier = Modifier,
    viewModel: WaitingViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    WaitingContent(
        state = state,
        onTryNow = viewModel::tryNow,
        onCallOffice = { OfficeDialer.dial(context, state.officePhone) },
        modifier = modifier,
    )
}

/**
 * The Waiting tab without its ViewModel: how many payments are not at the office, what the last push
 * did, another lineman's held payments, the list (problems first) with state chips, and "Try now".
 */
@Composable
fun WaitingContent(
    state: WaitingUiState,
    onTryNow: () -> Unit,
    onCallOffice: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier = modifier.fillMaxSize().testTag(WaitingTags.SCREEN)) {
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            contentPadding = PaddingValues(CableSpacing.S4),
        ) {
            item { Header(state) }
            if (state.held > 0) {
                item { HeldBlock(state.held, onCallOffice) }
            }
            items(state.items, key = { it.id }) { item -> WaitingRow(item, onCallOffice) }
        }
        if (state.ownOnPhone > 0) {
            BigButton(
                text =
                    stringResource(
                        if (state.push ==
                            PushStatus.Running
                        ) {
                            R.string.mobile_collect_waiting_sending
                        } else {
                            R.string.mobile_collect_waiting_try_now
                        },
                    ),
                icon = painterResource(DesignR.drawable.ic_cb_next),
                onClick = onTryNow,
                enabled = state.canTryNow,
                modifier = Modifier.padding(CableSpacing.S4).testTag(WaitingTags.TRY_NOW),
            )
        }
    }
}

@Composable
private fun Header(state: WaitingUiState) {
    Column(verticalArrangement = Arrangement.spacedBy(CableSpacing.S2)) {
        Text(
            text = stringResource(R.string.mobile_collect_waiting_title),
            style = MaterialTheme.typography.headlineSmall,
            color = Tokens.Color.Text,
        )
        if (state.loading) return@Column
        if (state.items.isEmpty()) {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_success),
                tint = CableTheme.semanticColors.success,
                text = stringResource(R.string.mobile_collect_waiting_nothing),
                modifier = Modifier.testTag(WaitingTags.NOTHING),
            )
        } else {
            Text(
                text = pluralStringResource(R.plurals.mobile_collect_waiting_count, state.items.size, state.items.size),
                style = MaterialTheme.typography.titleMedium,
                color = Tokens.Color.Text,
                modifier = Modifier.testTag(WaitingTags.COUNT),
            )
        }
        PushInfoLine(state)
    }
}

/** What the last push did, honestly: sending, no internet, failed (tries again), or all at the office. */
@Composable
private fun PushInfoLine(state: WaitingUiState) {
    val (icon, tint, text) =
        when {
            state.push == PushStatus.Running -> {
                Triple(
                    DesignR.drawable.ic_cb_pending,
                    CableTheme.semanticColors.pending,
                    R.string.mobile_collect_waiting_sending,
                )
            }

            state.push == PushStatus.NoInternet && state.ownOnPhone > 0 -> {
                Triple(
                    DesignR.drawable.ic_cb_pending,
                    CableTheme.semanticColors.pending,
                    R.string.mobile_collect_waiting_no_internet,
                )
            }

            state.push == PushStatus.Failed && state.ownOnPhone > 0 -> {
                Triple(
                    DesignR.drawable.ic_cb_pending,
                    CableTheme.semanticColors.pending,
                    R.string.mobile_collect_waiting_failed,
                )
            }

            state.allSent -> {
                Triple(
                    DesignR.drawable.ic_cb_success,
                    CableTheme.semanticColors.success,
                    R.string.mobile_collect_waiting_all_sent,
                )
            }

            else -> {
                return
            }
        }
    InfoLine(painterResource(icon), tint, stringResource(text), Modifier.testTag(WaitingTags.PUSH))
}

/** Another lineman's payments on this phone: not sent with this sign-in; call the office. */
@Composable
private fun HeldBlock(
    count: Int,
    onCallOffice: () -> Unit,
) {
    Card(modifier = Modifier.testTag(WaitingTags.HELD)) {
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_danger),
            tint = CableTheme.semanticColors.danger,
            text = pluralStringResource(R.plurals.mobile_collect_waiting_held_explain, count, count),
        )
        CallOfficeButton(onClick = onCallOffice, modifier = Modifier.testTag(WaitingTags.CALL_OFFICE))
    }
}

@Composable
private fun WaitingRow(
    item: WaitingItem,
    onCallOffice: () -> Unit,
) {
    val status = if (item.kind == WaitingKind.Problem) PaymentStatus.NeedsHelp else PaymentStatus.SavedOnPhone
    Card(modifier = Modifier.testTag(WaitingTags.row(item.id))) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(CableSpacing.S1)) {
                Text(
                    text = item.customerName,
                    style = MaterialTheme.typography.titleMedium,
                    color = Tokens.Color.Text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = "${item.customerCode} · ${item.reference}",
                    style = CableTheme.numericTypography.body,
                    color = Tokens.Color.TextMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = timeText(item.recordedAt),
                    style = MaterialTheme.typography.bodyLarge,
                    color = Tokens.Color.TextMuted,
                )
            }
            AmountDisplay(amountPaise = item.amountPaise, style = CableTheme.numericTypography.amountSmall)
        }
        Row(
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            StatusChip(status = status, text = stringResource(status.word))
            if (item.kind == WaitingKind.Held) {
                StatusChip(
                    status = PaymentStatus.NeedsHelp,
                    text = stringResource(R.string.mobile_collect_waiting_held_chip),
                )
            }
        }
        if (item.kind == WaitingKind.Problem) {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_danger),
                tint = PaymentStatus.NeedsHelp.color,
                text = stringResource(R.string.mobile_collect_done_problem),
            )
            CallOfficeButton(onClick = onCallOffice, modifier = Modifier.testTag(WaitingTags.call(item.id)))
        }
    }
}

/** `12 अक्टू 2026, 4:05 PM` in India time (receipt words, so it matches the printed receipt). */
@Composable
private fun timeText(epochMillis: Long): String {
    val instant = Instant.ofEpochMilli(epochMillis)
    val language = ReceiptLanguage.current()
    val time = ReceiptDates.time(instant)
    val clock =
        stringResource(
            if (time.afterNoon) R.string.mobile_printer_receipt_time_pm else R.string.mobile_printer_receipt_time_am,
            time.text,
        )
    return "${ReceiptDates.date(instant, language)}, $clock"
}

@Composable
private fun Card(
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    val shape = MaterialTheme.shapes.large
    Column(
        modifier =
            modifier
                .fillMaxWidth()
                .background(Tokens.Color.Surface, shape)
                .border(Tokens.Border.Hairline, Tokens.Color.Border, shape)
                .padding(CableSpacing.S4),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
    ) {
        content()
    }
}
