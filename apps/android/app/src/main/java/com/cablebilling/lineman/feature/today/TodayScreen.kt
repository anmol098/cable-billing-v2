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

/**
 * The Today tab with its ViewModel (PLAN §11.3 Today).
 *
 * @param onHandOver open the handover flow for that India-time day.
 */
@Composable
fun TodayScreen(
    onHandOver: (businessDate: String) -> Unit,
    modifier: Modifier = Modifier,
    viewModel: TodayViewModel = hiltViewModel(),
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    LifecycleResumeEffect(viewModel) {
        viewModel.onShown()
        onPauseOrDispose {}
    }
    TodayContent(
        state = state,
        actions =
            TodayActions(
                onHandOver = { onHandOver(state.businessDate) },
                onCheckAgain = viewModel::refresh,
                onTryNow = viewModel::tryNow,
                onCallOffice = { OfficeDialer.dial(context, state.officePhone) },
            ),
        modifier = modifier,
    )
}

/** What the Today screen can do. */
data class TodayActions(
    val onHandOver: () -> Unit = {},
    val onCheckAgain: () -> Unit = {},
    val onTryNow: () -> Unit = {},
    val onCallOffice: () -> Unit = {},
)

/**
 * The Today tab without its ViewModel: the day's cash and UPI tiles (never one mixed total), what is
 * only on the phone, what the office has, the handover's state, today's payments, and the one big button
 * "ऑफिस को कैश दें / Hand over cash".
 */
@Composable
fun TodayContent(
    state: TodayUiState,
    actions: TodayActions,
    modifier: Modifier = Modifier,
) {
    val summary = state.summary
    state.voice?.let { SpeakOnShow(it) }
    Column(modifier = modifier.fillMaxSize().testTag(TodayTags.SCREEN)) {
        LazyColumn(
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            contentPadding = PaddingValues(CableSpacing.S4),
        ) {
            item { Header(state) }
            if (summary != null) {
                item { Totals(summary) }
                item { Sources(summary, state.officeCheck, actions) }
                item { HandoverCard(state.handover, actions) }
                item {
                    Text(
                        text = stringResource(R.string.mobile_today_list_title),
                        style = MaterialTheme.typography.titleLarge,
                        color = Tokens.Color.Text,
                    )
                }
                if (summary.rows.isEmpty()) {
                    item {
                        Text(
                            text = stringResource(R.string.mobile_today_nothing_yet),
                            style = MaterialTheme.typography.bodyLarge,
                            color = Tokens.Color.TextMuted,
                            modifier = Modifier.testTag(TodayTags.NOTHING_YET),
                        )
                    }
                }
                items(summary.rows, key = { it.id }) { row -> PaymentRow(row) }
            }
        }
        if (state.canHandOver) HandOverButton(state.handover, actions.onHandOver)
    }
}

@Composable
private fun Header(state: TodayUiState) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.mobile_today_title),
                style = MaterialTheme.typography.headlineSmall,
                color = Tokens.Color.Text,
            )
            if (state.businessDate.isNotEmpty()) {
                Text(
                    text = dateText(state.businessDate),
                    style = MaterialTheme.typography.bodyLarge,
                    color = Tokens.Color.TextMuted,
                    modifier = Modifier.testTag(TodayTags.DATE),
                )
            }
        }
        state.voice?.let { line ->
            SpeakButton(text = spokenText(line), label = stringResource(R.string.mobile_designsystem_speak))
        }
    }
}

/** 💵 Cash ₹X | 📱 UPI ₹Y, then the number of payments. */
@Composable
private fun Totals(summary: DaySummary) {
    Column(verticalArrangement = Arrangement.spacedBy(CableSpacing.S2)) {
        Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
            MethodTile(PaymentMethod.Cash, summary.day.cashPaise, Modifier.weight(1f).testTag(TodayTags.CASH_TILE))
            MethodTile(PaymentMethod.Upi, summary.day.upiPaise, Modifier.weight(1f).testTag(TodayTags.UPI_TILE))
        }
        Text(
            text = pluralStringResource(R.plurals.common_payment_count, summary.day.count, summary.day.count),
            style = MaterialTheme.typography.titleMedium,
            color = Tokens.Color.Text,
            modifier = Modifier.testTag(TodayTags.COUNT),
        )
    }
}

/** Where the numbers come from, said honestly: only on the phone, problems, at the office. */
@Composable
private fun Sources(
    summary: DaySummary,
    check: OfficeCheck,
    actions: TodayActions,
) {
    Column(verticalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
        if (check == OfficeCheck.NoInternet) {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_pending),
                tint = CableTheme.semanticColors.pending,
                text = stringResource(R.string.common_no_internet),
            )
        }
        if (summary.source == TotalsSource.PhoneOnly && !summary.day.isEmpty) {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_pending),
                tint = CableTheme.semanticColors.pending,
                text = stringResource(R.string.mobile_today_phone_only),
                modifier = Modifier.testTag(TodayTags.PHONE_ONLY),
            )
        }
        if (!summary.onPhone.isEmpty) {
            Column(
                modifier = Modifier.testTag(TodayTags.ON_PHONE),
                verticalArrangement = Arrangement.spacedBy(CableSpacing.S1),
            ) {
                InfoLine(
                    icon = painterResource(DesignR.drawable.ic_cb_pending),
                    tint = CableTheme.semanticColors.pending,
                    text =
                        pluralStringResource(
                            R.plurals.mobile_today_on_phone,
                            summary.onPhone.count,
                            summary.onPhone.count,
                        ),
                )
                SplitAmounts(summary.onPhone)
            }
        }
        if (!summary.problems.isEmpty) {
            Column(
                modifier = Modifier.testTag(TodayTags.PROBLEMS),
                verticalArrangement = Arrangement.spacedBy(CableSpacing.S2),
            ) {
                InfoLine(
                    icon = painterResource(DesignR.drawable.ic_cb_danger),
                    tint = CableTheme.semanticColors.danger,
                    text =
                        pluralStringResource(
                            R.plurals.mobile_today_problem,
                            summary.problems.count,
                            summary.problems.count,
                        ),
                )
                SplitAmounts(summary.problems)
                CallOfficeButton(onClick = actions.onCallOffice, modifier = Modifier.testTag(TodayTags.CALL_OFFICE))
            }
        }
        val office = summary.office
        if (office != null) {
            Column(
                modifier = Modifier.testTag(TodayTags.AT_OFFICE),
                verticalArrangement = Arrangement.spacedBy(CableSpacing.S1),
            ) {
                InfoLine(
                    icon = painterResource(DesignR.drawable.ic_cb_success),
                    tint = CableTheme.semanticColors.success,
                    text =
                        if (office.isFresh) {
                            stringResource(R.string.mobile_today_at_office)
                        } else {
                            stringResource(R.string.mobile_today_at_office_at, clockText(office.serverTime))
                        },
                )
                Row(
                    horizontalArrangement = Arrangement.spacedBy(CableSpacing.S4),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SplitAmounts(office.totals)
                    Text(
                        text =
                            pluralStringResource(
                                R.plurals.common_payment_count,
                                office.totals.count,
                                office.totals.count,
                            ),
                        style = MaterialTheme.typography.bodyLarge,
                        color = Tokens.Color.TextMuted,
                    )
                }
            }
        }
    }
}

/** "ऑफिस को कैश दें / Hand over cash", or "फिर से कैश दें / Hand over again" once one was made. */
@Composable
private fun HandOverButton(
    view: HandoverView,
    onClick: () -> Unit,
) {
    val first = view == HandoverView.NotYet
    val primary = first || view is HandoverView.SentBack || view is HandoverView.Refused
    BigButton(
        text = stringResource(if (first) R.string.common_hand_over_cash else R.string.mobile_today_handover_again),
        icon = painterResource(DesignR.drawable.ic_cb_handover),
        onClick = onClick,
        style = if (primary) BigButtonStyle.Primary else BigButtonStyle.Secondary,
        modifier = Modifier.padding(CableSpacing.S4).testTag(TodayTags.HAND_OVER),
    )
}

@Composable
private fun PaymentRow(row: DayRow) {
    TodayCard(modifier = Modifier.testTag(TodayTags.row(row.id))) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(CableSpacing.S1)) {
                Text(
                    text = row.customerName,
                    style = MaterialTheme.typography.titleMedium,
                    color = Tokens.Color.Text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = "${row.customerCode} · ${row.reference}",
                    style = CableTheme.numericTypography.body,
                    color = Tokens.Color.TextMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = clockText(row.recordedAt),
                    style = MaterialTheme.typography.bodyLarge,
                    color = Tokens.Color.TextMuted,
                )
            }
            Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(CableSpacing.S1)) {
                AmountDisplay(amountPaise = row.amountPaise, style = CableTheme.numericTypography.amountSmall)
                InfoLine(
                    icon = painterResource(row.method.ui.icon),
                    tint = methodColor(row.method.ui),
                    text = methodWord(row.method.ui),
                )
            }
        }
        val status =
            when (row.status) {
                DayRowStatus.OnPhone -> PaymentStatus.SavedOnPhone
                DayRowStatus.Sent -> PaymentStatus.Sent
                DayRowStatus.Problem, DayRowStatus.Cancelled -> PaymentStatus.NeedsHelp
            }
        StatusChip(
            status = status,
            text =
                if (row.status ==
                    DayRowStatus.Cancelled
                ) {
                    stringResource(R.string.mobile_today_cancelled)
                } else {
                    stringResource(status.word)
                },
        )
    }
}

@Composable
private fun methodColor(method: PaymentMethod) =
    if (method == PaymentMethod.Upi) CableTheme.semanticColors.upi else CableTheme.semanticColors.cash

/** `13 Oct 2026` / `13 अक्टू 2026` for a `YYYY-MM-DD` India-time day. */
@Composable
private fun dateText(businessDate: String): String {
    val noonInIndia =
        LocalDate
            .parse(businessDate)
            .atTime(NOON, 0)
            .atZone(ReceiptDates.BUSINESS_ZONE)
            .withZoneSameInstant(ZoneOffset.UTC)
            .toInstant()
    return ReceiptDates.date(noonInIndia, ReceiptLanguage.current())
}

private const val NOON = 12
