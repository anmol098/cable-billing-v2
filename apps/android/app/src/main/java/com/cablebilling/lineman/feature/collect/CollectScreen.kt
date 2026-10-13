package com.cablebilling.lineman.feature.collect

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.ConfirmCard
import com.cablebilling.designsystem.component.MethodButton
import com.cablebilling.designsystem.component.NumberPad
import com.cablebilling.designsystem.component.NumberPadExtraKey
import com.cablebilling.designsystem.component.NumberPadKey
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.designsystem.component.SpeakButton
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.voice.SpeakOnShow
import com.cablebilling.lineman.voice.spokenText
import com.cablebilling.designsystem.R as DesignR

/**
 * The collect flow with its ViewModel (PLAN §11.3 Amount → Method → UPI ref → Confirm).
 *
 * @param onSaved the payment is committed on the phone: show Done for this payment id.
 * @param onBack leave the flow from the Amount screen (back to the customer).
 */
@Composable
fun CollectScreen(
    customerId: String,
    onSaved: (paymentId: String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: CollectViewModel =
        hiltViewModel<CollectViewModel, CollectViewModel.Factory>(key = customerId) { it.create(customerId) },
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val saved by rememberUpdatedState(onSaved)
    LaunchedEffect(state.savedPaymentId) { state.savedPaymentId?.let { saved(it) } }
    val back = { if (!viewModel.onBack()) onBack() }
    BackHandler(enabled = state.step != CollectStep.Amount) { back() }
    CollectContent(
        state = state,
        actions =
            CollectActions(
                onBack = back,
                onKey = viewModel::onKey,
                onQuickAmount = viewModel::onQuickAmount,
                onAmountDone = viewModel::onAmountDone,
                onMethod = viewModel::onMethod,
                onUpiReferenceChange = viewModel::onUpiReferenceChange,
                onUpiSkip = viewModel::onUpiSkip,
                onUpiDone = viewModel::onUpiDone,
                onSave = viewModel::save,
            ),
        modifier = modifier,
    )
}

/** What the collect screens can do (one object, so the stateless content stays readable). */
data class CollectActions(
    val onBack: () -> Unit = {},
    val onKey: (NumberPadKey) -> Unit = {},
    val onQuickAmount: (paise: Long) -> Unit = {},
    val onAmountDone: () -> Unit = {},
    val onMethod: (PaymentMethod) -> Unit = {},
    val onUpiReferenceChange: (String) -> Unit = {},
    val onUpiSkip: () -> Unit = {},
    val onUpiDone: () -> Unit = {},
    val onSave: () -> Unit = {},
)

/** The collect flow without its ViewModel: the current step's screen. */
@Composable
fun CollectContent(
    state: CollectUiState,
    actions: CollectActions,
    modifier: Modifier = Modifier,
) {
    val customer = state.customer
    when {
        customer == null -> {
            Column(modifier = modifier.fillMaxSize()) {
                BackRow(onBack = actions.onBack)
                if (state.notFound) {
                    InfoLine(
                        icon = painterResource(DesignR.drawable.ic_cb_customer),
                        tint = Tokens.Color.TextMuted,
                        text = stringResource(R.string.mobile_search_customer_not_found),
                        modifier = Modifier.padding(CableSpacing.S4).testTag(CollectTags.NOT_FOUND),
                    )
                }
            }
        }

        else -> {
            when (state.step) {
                CollectStep.Amount -> AmountStep(state, customer, actions, modifier)
                CollectStep.Method -> MethodStep(state, customer, actions, modifier)
                CollectStep.UpiReference -> UpiStep(state, actions, modifier)
                CollectStep.Confirm -> ConfirmStep(state, customer, actions, modifier)
            }
        }
    }
}

/** A step: back row, the customer's name, then [content], then the bottom [button] (thumb reach). */
@Composable
private fun Step(
    tag: String,
    title: String,
    customer: CollectCustomer?,
    onBack: () -> Unit,
    modifier: Modifier,
    backEnd: @Composable () -> Unit = {},
    button: @Composable ColumnScope.() -> Unit,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier = modifier.fillMaxSize().testTag(tag)) {
        BackRow(onBack = onBack, end = backEnd)
        Column(
            modifier =
                Modifier
                    .weight(
                        1f,
                    ).fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = CableSpacing.S4),
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
        ) {
            customer?.let {
                Text(
                    text = it.name,
                    style = MaterialTheme.typography.titleLarge,
                    color = Tokens.Color.Text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag(CollectTags.CUSTOMER_NAME),
                )
            }
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
    state: CollectUiState,
    customer: CollectCustomer,
    actions: CollectActions,
    modifier: Modifier,
) {
    Step(
        tag = CollectTags.AMOUNT_SCREEN,
        title = stringResource(R.string.mobile_collect_amount_title),
        customer = customer,
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
                modifier = Modifier.testTag(CollectTags.NEXT),
            )
        },
    ) {
        if (customer.duePaise > 0) {
            Text(
                text = stringResource(R.string.mobile_collect_amount_due_now, Rupees.format(customer.duePaise)),
                style = MaterialTheme.typography.bodyLarge,
                color = CableTheme.semanticColors.due,
                modifier = Modifier.testTag(CollectTags.DUE_NOW),
            )
        }
        if (state.amountPaise > 0) {
            AmountDisplay(amountPaise = state.amountPaise, modifier = Modifier.testTag(CollectTags.AMOUNT))
        } else {
            Text(
                text = stringResource(R.string.mobile_collect_amount_hint),
                style = MaterialTheme.typography.headlineSmall,
                color = Tokens.Color.TextMuted,
                modifier = Modifier.testTag(CollectTags.AMOUNT_HINT),
            )
        }
        QuickAmounts(state, customer, actions.onQuickAmount)
    }
}

/** Full due (its own row) then ₹100 / ₹200 / ₹500: one tap sets the amount. */
@Composable
private fun QuickAmounts(
    state: CollectUiState,
    customer: CollectCustomer,
    onQuickAmount: (Long) -> Unit,
) {
    val amounts = state.quickAmountsPaise
    val due = amounts.firstOrNull()?.takeIf { customer.duePaise > 0 }
    if (due != null) {
        QuickAmountButton(
            text = stringResource(R.string.mobile_collect_amount_chip_due, Rupees.format(due)),
            paise = due,
            onQuickAmount = onQuickAmount,
            modifier = Modifier.fillMaxWidth(),
        )
    }
    Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2)) {
        amounts.drop(if (due != null) 1 else 0).forEach { paise ->
            QuickAmountButton(Rupees.format(paise), paise, onQuickAmount, Modifier.weight(1f))
        }
    }
}

@Composable
private fun QuickAmountButton(
    text: String,
    paise: Long,
    onQuickAmount: (Long) -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = { onQuickAmount(paise) },
        modifier = modifier.heightIn(min = CableSizes.TouchMin).testTag(CollectTags.chip(paise)),
        shape = MaterialTheme.shapes.medium,
    ) {
        Text(text = text, style = CableTheme.numericTypography.body, maxLines = 1)
    }
}

@Composable
private fun MethodStep(
    state: CollectUiState,
    customer: CollectCustomer,
    actions: CollectActions,
    modifier: Modifier,
) {
    Step(
        tag = CollectTags.METHOD_SCREEN,
        title = stringResource(R.string.mobile_collect_method_title),
        customer = customer,
        onBack = actions.onBack,
        modifier = modifier,
        button = {
            Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
                MethodButton(
                    method = PaymentMethod.Cash,
                    text = methodLabel(PaymentMethod.Cash),
                    onClick = { actions.onMethod(PaymentMethod.Cash) },
                    modifier = Modifier.weight(1f).testTag(CollectTags.CASH),
                )
                MethodButton(
                    method = PaymentMethod.Upi,
                    text = methodLabel(PaymentMethod.Upi),
                    onClick = { actions.onMethod(PaymentMethod.Upi) },
                    modifier = Modifier.weight(1f).testTag(CollectTags.UPI),
                )
            }
        },
    ) {
        AmountDisplay(amountPaise = state.amountPaise, modifier = Modifier.testTag(CollectTags.AMOUNT))
    }
}

@Composable
private fun UpiStep(
    state: CollectUiState,
    actions: CollectActions,
    modifier: Modifier,
) {
    Step(
        tag = CollectTags.UPI_SCREEN,
        title = stringResource(R.string.mobile_collect_upi_title),
        customer = state.customer,
        onBack = actions.onBack,
        modifier = modifier,
        button = {
            BigButton(
                text = stringResource(R.string.mobile_collect_upi_skip),
                icon = painterResource(DesignR.drawable.ic_cb_next),
                onClick = actions.onUpiSkip,
                style = BigButtonStyle.Secondary,
                modifier = Modifier.testTag(CollectTags.UPI_SKIP),
            )
            BigButton(
                text = stringResource(R.string.common_next),
                icon = painterResource(DesignR.drawable.ic_cb_next),
                onClick = actions.onUpiDone,
                enabled = state.upiReference.isNotBlank(),
                modifier = Modifier.testTag(CollectTags.UPI_NEXT),
            )
        },
    ) {
        Text(
            text = stringResource(R.string.mobile_collect_upi_hint),
            style = MaterialTheme.typography.bodyLarge,
            color = Tokens.Color.TextMuted,
        )
        OutlinedTextField(
            value = state.upiReference,
            onValueChange = actions.onUpiReferenceChange,
            singleLine = true,
            textStyle = CableTheme.numericTypography.body,
            keyboardOptions =
                KeyboardOptions(
                    capitalization = KeyboardCapitalization.Characters,
                    keyboardType = KeyboardType.Ascii,
                    imeAction = ImeAction.Done,
                ),
            keyboardActions = KeyboardActions(onDone = { if (state.upiReference.isNotBlank()) actions.onUpiDone() }),
            modifier = Modifier.fillMaxWidth().heightIn(min = CableSizes.TouchMin).testTag(CollectTags.UPI_FIELD),
        )
    }
}

@Composable
private fun ConfirmStep(
    state: CollectUiState,
    customer: CollectCustomer,
    actions: CollectActions,
    modifier: Modifier,
) {
    val method = state.method ?: PaymentMethod.Cash
    SpeakOnShow(state.confirmVoice)
    Step(
        tag = CollectTags.CONFIRM_SCREEN,
        title = stringResource(R.string.mobile_collect_confirm_title),
        customer = null,
        onBack = actions.onBack,
        modifier = modifier,
        backEnd = {
            state.confirmVoice?.let { line ->
                SpeakButton(
                    text = spokenText(line),
                    label = stringResource(R.string.mobile_designsystem_speak),
                    modifier = Modifier.testTag(CollectTags.SPEAK),
                )
            }
        },
        button = {
            BigButton(
                text =
                    stringResource(
                        if (state.saving) R.string.mobile_collect_confirm_saving else R.string.common_save,
                    ),
                icon = painterResource(DesignR.drawable.ic_cb_success),
                onClick = actions.onSave,
                style = BigButtonStyle.Success,
                enabled = !state.saving && state.savedPaymentId == null,
                modifier = Modifier.testTag(CollectTags.SAVE),
            )
        },
    ) {
        ConfirmCard(
            customerName = customer.name,
            amountPaise = state.amountPaise,
            method = method,
            methodLabel = methodLabel(method),
            modifier = Modifier.testTag(CollectTags.CONFIRM_CARD),
            details =
                state.upiReference.takeIf { method == PaymentMethod.Upi && it.isNotBlank() }?.let { reference ->
                    {
                        Text(
                            text = stringResource(R.string.mobile_collect_confirm_upi_ref, reference.trim()),
                            style = MaterialTheme.typography.bodyLarge,
                            color = Tokens.Color.Text,
                        )
                    }
                },
        )
        state.problem?.let { problem ->
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_danger),
                tint = CableTheme.semanticColors.danger,
                text =
                    stringResource(
                        when (problem) {
                            CollectProblem.NotSaved -> R.string.mobile_collect_confirm_not_saved
                            CollectProblem.SignedOut -> R.string.mobile_collect_confirm_signed_out
                        },
                    ),
                modifier = Modifier.testTag(CollectTags.PROBLEM),
            )
        }
    }
}
