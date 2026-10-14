package com.cablebilling.lineman.feature.today

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.NumberPad
import com.cablebilling.designsystem.component.NumberPadExtraKey
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.SpeakButton
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.network.generated.DiscrepancyReason
import com.cablebilling.lineman.feature.collect.InfoLine
import com.cablebilling.lineman.voice.SpeakOnShow
import com.cablebilling.lineman.voice.spokenText
import com.cablebilling.designsystem.R as DesignR

/**
 * The handover flow with its ViewModel (PLAN §11.3 Today: number pad → reason if different → Confirm).
 *
 * @param onDone the handover is saved on the phone: back to Today, which shows its state.
 * @param onBack leave the flow from the amount step.
 */
@Composable
fun HandoverScreen(
    businessDate: String,
    onDone: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: HandoverViewModel =
        hiltViewModel<HandoverViewModel, HandoverViewModel.Factory>(key = businessDate) { it.create(businessDate) },
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val done by rememberUpdatedState(onDone)
    LaunchedEffect(state.saved) { if (state.saved) done() }
    val back = { if (!viewModel.onBack()) onBack() }
    BackHandler(enabled = state.step != HandoverStep.Amount) { back() }
    HandoverContent(
        state = state,
        actions =
            HandoverActions(
                onBack = back,
                onKey = viewModel::onKey,
                onAmountDone = viewModel::onAmountDone,
                onReason = viewModel::onReason,
                onNoteChange = viewModel::onNoteChange,
                onReasonDone = viewModel::onReasonDone,
                onSubmit = viewModel::submit,
            ),
        modifier = modifier,
    )
}

/** What the handover screens can do. */
data class HandoverActions(
    val onBack: () -> Unit = {},
    val onKey: (NumberPadKey) -> Unit = {},
    val onAmountDone: () -> Unit = {},
    val onReason: (DiscrepancyReason) -> Unit = {},
    val onNoteChange: (String) -> Unit = {},
    val onReasonDone: () -> Unit = {},
    val onSubmit: () -> Unit = {},
)

/** The handover flow without its ViewModel: the current step's screen. */
@Composable
fun HandoverContent(
    state: HandoverUiState,
    actions: HandoverActions,
    modifier: Modifier = Modifier,
) {
    val plan = state.plan
    if (plan == null) {
        Column(modifier = modifier.fillMaxSize()) {
            BackRow(actions.onBack)
            ProblemLine(state.problem)
        }
        return
    }
    when (state.step) {
        HandoverStep.Amount -> AmountStep(state, plan, actions, modifier)
        HandoverStep.Reason -> ReasonStep(state, actions, modifier)
        HandoverStep.Confirm -> ConfirmStep(state, plan, actions, modifier)
    }
}

@Composable
private fun Step(
    tag: String,
    title: String,
    onBack: () -> Unit,
    modifier: Modifier,
    backEnd: @Composable () -> Unit = {},
    button: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier = modifier.fillMaxSize().testTag(tag)) {
        BackRow(onBack, backEnd)
        Column(
            modifier =
                Modifier
                    .weight(1f)
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = CableSpacing.S4),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
        ) {
            Text(text = title, style = MaterialTheme.typography.headlineSmall, color = Tokens.Color.Text)
            content()
        }
        Column(
            modifier = Modifier.fillMaxWidth().padding(CableSpacing.S4),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            content = button,
        )
    }
}

@Composable
private fun AmountStep(
    state: HandoverUiState,
    plan: HandoverPlan,
    actions: HandoverActions,
    modifier: Modifier,
) {
    Step(
        tag = TodayTags.AMOUNT_SCREEN,
        title = stringResource(R.string.mobile_today_handover_amount_title),
        onBack = actions.onBack,
        modifier = modifier,
        button = {
            NumberPad(
                onKey = actions.onKey,
                deleteLabel = stringResource(R.string.mobile_designsystem_numpad_delete),
                extraKey = NumberPadExtraKey.DoubleZero,
            )
            BigButton(
                text = stringResource(R.string.common_next),
                icon = painterResource(DesignR.drawable.ic_cb_next),
                onClick = actions.onAmountDone,
                enabled = state.canContinue,
                modifier = Modifier.testTag(TodayTags.NEXT),
            )
        },
    ) {
        ExpectedLines(plan)
        AmountDisplay(amountPaise = state.handedPaise, modifier = Modifier.testTag(TodayTags.AMOUNT))
        state.discrepancyPaise?.takeIf { state.handedPaise > 0 }?.let {
            DifferenceLine(it, Modifier.testTag(TodayTags.DIFFERENCE))
        }
    }
}

/** "कितना कैश होना चाहिए ₹800" and where that number comes from. */
@Composable
private fun ExpectedLines(plan: HandoverPlan) {
    InfoLine(
        icon = painterResource(DesignR.drawable.ic_cb_cash),
        tint = CableTheme.semanticColors.cash,
        text = stringResource(R.string.mobile_today_status_expected, Rupees.format(plan.expectedPaise)),
        modifier = Modifier.testTag(TodayTags.EXPECTED),
    )
    val office = plan.officeCashPaise
    when {
        plan.source == TotalsSource.PhoneOnly -> {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_pending),
                tint = CableTheme.semanticColors.pending,
                text = stringResource(R.string.mobile_today_handover_phone_only),
                modifier = Modifier.testTag(TodayTags.SOURCE),
            )
        }

        office != null && plan.notInOfficeCashPaise > 0 -> {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_pending),
                tint = CableTheme.semanticColors.pending,
                text =
                    stringResource(
                        R.string.mobile_today_handover_office_and_phone,
                        Rupees.format(office),
                        Rupees.format(plan.notInOfficeCashPaise),
                    ),
                modifier = Modifier.testTag(TodayTags.SOURCE),
            )
        }
    }
}

@Composable
private fun ReasonStep(
    state: HandoverUiState,
    actions: HandoverActions,
    modifier: Modifier,
) {
    Step(
        tag = TodayTags.REASON_SCREEN,
        title = stringResource(R.string.mobile_today_handover_reason_title),
        onBack = actions.onBack,
        modifier = modifier,
        button = {
            BigButton(
                text = stringResource(R.string.common_next),
                icon = painterResource(DesignR.drawable.ic_cb_next),
                onClick = actions.onReasonDone,
                enabled = state.canFinishReason,
                modifier = Modifier.testTag(TodayTags.NEXT),
            )
        },
    ) {
        state.discrepancyPaise?.let { DifferenceLine(it, Modifier.testTag(TodayTags.DIFFERENCE)) }
        state.reasons.chunked(2).forEach { pair ->
            Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
                pair.forEach { reason ->
                    ReasonTile(
                        reason,
                        selected = state.reason == reason,
                        onClick = { actions.onReason(reason) },
                        Modifier.weight(1f),
                    )
                }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            }
        }
        OutlinedTextField(
            value = state.note,
            onValueChange = actions.onNoteChange,
            label = { Text(stringResource(R.string.mobile_today_handover_note)) },
            textStyle = MaterialTheme.typography.bodyLarge,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = Modifier.fillMaxWidth().heightIn(min = CableSizes.TouchMin).testTag(TodayTags.NOTE),
        )
    }
}

/** A big reason tile: icon above a short word; the chosen one has a strong outline and a tick. */
@Composable
private fun ReasonTile(
    reason: DiscrepancyReason,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val shape = MaterialTheme.shapes.large
    val (icon, word) = reason.look()
    Column(
        modifier =
            modifier
                .heightIn(min = CableSizes.Tile)
                .background(Tokens.Color.Surface, shape)
                .border(
                    if (selected) Tokens.Border.Strong else Tokens.Border.Hairline,
                    if (selected) Tokens.Color.Text else Tokens.Color.Border,
                    shape,
                ).selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
                .padding(CableSpacing.S3)
                .testTag(TodayTags.reason(reason.wire)),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S2, Alignment.CenterVertically),
    ) {
        Icon(
            painter = painterResource(if (selected) DesignR.drawable.ic_cb_success else icon),
            contentDescription = null,
            tint = if (selected) CableTheme.semanticColors.success else Tokens.Color.Text,
            modifier = Modifier.size(CableSizes.IconLarge),
        )
        Text(
            text = stringResource(word),
            style = MaterialTheme.typography.titleMedium,
            color = Tokens.Color.Text,
            textAlign = TextAlign.Center,
        )
    }
}

private fun DiscrepancyReason.look(): Pair<Int, Int> =
    when (this) {
        DiscrepancyReason.SHORT -> {
            DesignR.drawable.ic_cb_short to R.string.mobile_today_handover_reason_short
        }

        DiscrepancyReason.EXTRA -> {
            DesignR.drawable.ic_cb_extra to R.string.mobile_today_handover_reason_extra
        }

        DiscrepancyReason.PENDING_SYNC -> {
            DesignR.drawable.ic_cb_pending to
                R.string.mobile_today_handover_reason_pending_sync
        }

        DiscrepancyReason.OTHER -> {
            DesignR.drawable.ic_cb_edit to R.string.mobile_today_handover_reason_other
        }
    }

@Composable
private fun ConfirmStep(
    state: HandoverUiState,
    plan: HandoverPlan,
    actions: HandoverActions,
    modifier: Modifier,
) {
    state.confirmVoice?.let { SpeakOnShow(it) }
    Step(
        tag = TodayTags.CONFIRM_SCREEN,
        title = stringResource(R.string.mobile_today_handover_confirm_title),
        onBack = actions.onBack,
        modifier = modifier,
        backEnd = {
            state.confirmVoice?.let {
                SpeakButton(text = spokenText(it), label = stringResource(R.string.mobile_designsystem_speak))
            }
        },
        button = {
            ProblemLine(state.problem)
            BigButton(
                text =
                    stringResource(
                        if (state.saving) R.string.mobile_today_handover_saving else R.string.common_hand_over_cash,
                    ),
                icon = painterResource(DesignR.drawable.ic_cb_handover),
                onClick = actions.onSubmit,
                enabled = !state.saving && state.problem != HandoverProblem.AlreadyAccepted,
                style = BigButtonStyle.Success,
                modifier = Modifier.testTag(TodayTags.SUBMIT),
            )
        },
    ) {
        TodayCard(modifier = Modifier.testTag(TodayTags.CONFIRM_CARD)) {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_handover),
                tint = Tokens.Color.Text,
                text = stringResource(R.string.common_hand_over_cash),
            )
            Row(
                horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                AmountDisplay(amountPaise = state.handedPaise)
                InfoLine(
                    icon = painterResource(DesignR.drawable.ic_cb_cash),
                    tint = CableTheme.semanticColors.cash,
                    text = stringResource(R.string.common_cash),
                )
            }
            Text(
                text = stringResource(R.string.mobile_today_status_expected, Rupees.format(plan.expectedPaise)),
                style = MaterialTheme.typography.bodyLarge,
                color = Tokens.Color.Text,
            )
            state.discrepancyPaise?.let { DifferenceLine(it) }
            state.reason?.takeIf { it in state.reasons }?.let { reason ->
                val (icon, word) = reason.look()
                InfoLine(painterResource(icon), Tokens.Color.Text, stringResource(word))
            }
            state.note.trim().takeIf { it.isNotEmpty() && state.reasons.isNotEmpty() }?.let { note ->
                Text(text = note, style = MaterialTheme.typography.bodyLarge, color = Tokens.Color.TextMuted)
            }
        }
    }
}
