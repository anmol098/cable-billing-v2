package com.cablebilling.lineman.feature.customer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.AmountTone
import com.cablebilling.designsystem.component.BigButton
import com.cablebilling.designsystem.component.BigButtonStyle
import com.cablebilling.designsystem.component.SpeakButton
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.voice.SpeakOnShow
import com.cablebilling.lineman.voice.spokenText
import com.cablebilling.designsystem.R as DesignR

/**
 * The customer screen (PLAN §11.3 Customer) with its ViewModel.
 *
 * @param onCollect the giant "पैसे लें / Collect" button: start the collect flow for this customer (T-066).
 * @param onBack leave the screen (back to the search home).
 */
@Composable
fun CustomerScreen(
    customerId: String,
    onCollect: (customerId: String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    viewModel: CustomerViewModel =
        hiltViewModel<CustomerViewModel, CustomerViewModel.Factory>(key = customerId) { it.create(customerId) },
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    CustomerContent(
        state = state,
        onCollect = { onCollect(customerId) },
        onCall = { phone -> CustomerDialer.dial(context, phone) },
        onBack = onBack,
        modifier = modifier,
    )
}

/**
 * The customer screen without its ViewModel: name, code, area, the due huge and red (credit apart,
 * in green), connections, tap-to-call, and one giant Collect button at the bottom (thumb reach).
 * "Name, ₹X due" is read out when the screen shows; the speak button replays it.
 */
@Composable
fun CustomerContent(
    state: CustomerUiState,
    onCollect: () -> Unit,
    onCall: (phone: String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SpeakOnShow(state.voiceLine)
    Column(modifier = modifier.fillMaxSize().testTag(CustomerTags.SCREEN)) {
        TopRow(state, onBack)
        val customer = state.customer
        when {
            customer != null -> {
                CustomerDetails(
                    customer = customer,
                    refresh = state.refresh,
                    onCall = onCall,
                    modifier = Modifier.weight(1f),
                )
                BigButton(
                    text = stringResource(R.string.common_collect),
                    icon = painterResource(DesignR.drawable.ic_cb_collect),
                    onClick = onCollect,
                    style = BigButtonStyle.Primary,
                    modifier =
                        Modifier
                            .padding(CableSpacing.S4)
                            .heightIn(min = CableSizes.Tile)
                            .testTag(CustomerTags.COLLECT),
                )
            }

            state.notFound -> {
                InfoLine(
                    icon = painterResource(DesignR.drawable.ic_cb_customer),
                    tint = Tokens.Color.TextMuted,
                    text = stringResource(R.string.mobile_search_customer_not_found),
                    modifier = Modifier.padding(CableSpacing.S4).testTag(CustomerTags.NOT_FOUND),
                )
            }
        }
    }
}

/** ← Back on the left, the speak button on the right. */
@Composable
private fun TopRow(
    state: CustomerUiState,
    onBack: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = CableSpacing.S2, vertical = CableSpacing.S2),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            onClick = onBack,
            modifier = Modifier.heightIn(min = CableSizes.TouchMin).testTag(CustomerTags.BACK),
        ) {
            Icon(
                painter = painterResource(DesignR.drawable.ic_cb_back),
                contentDescription = null,
                modifier = Modifier.size(CableSizes.Icon),
            )
            Spacer(Modifier.size(CableSpacing.S2))
            Text(text = stringResource(R.string.common_back), style = MaterialTheme.typography.labelLarge)
        }
        state.voiceLine?.let { line ->
            SpeakButton(
                text = spokenText(line),
                label = stringResource(R.string.mobile_designsystem_speak),
                modifier = Modifier.testTag(CustomerTags.SPEAK),
            )
        }
    }
}

@Composable
private fun CustomerDetails(
    customer: CustomerView,
    refresh: CustomerRefresh,
    onCall: (phone: String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier =
            modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = CableSpacing.S4),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
    ) {
        Text(
            text = customer.name,
            style = MaterialTheme.typography.headlineLarge,
            color = Tokens.Color.Text,
            modifier = Modifier.testTag(CustomerTags.NAME),
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S4),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = customer.code,
                style = CableTheme.numericTypography.body,
                color = Tokens.Color.TextMuted,
                modifier = Modifier.testTag(CustomerTags.CODE),
            )
            customer.areaName?.let { area ->
                InfoLine(
                    icon = painterResource(DesignR.drawable.ic_cb_area),
                    tint = Tokens.Color.TextMuted,
                    text = area,
                    modifier = Modifier.testTag(CustomerTags.AREA),
                )
            }
        }
        DueBlock(customer)
        if (refresh == CustomerRefresh.NoInternet) {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_pending),
                tint = CableTheme.semanticColors.pending,
                text = stringResource(R.string.mobile_search_customer_no_internet),
                modifier = Modifier.testTag(CustomerTags.NO_INTERNET),
            )
        }
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_plan),
            tint = Tokens.Color.Text,
            text =
                pluralStringResource(
                    R.plurals.mobile_search_customer_connections,
                    customer.connectionCount,
                    customer.connectionCount,
                ),
            modifier = Modifier.testTag(CustomerTags.CONNECTIONS),
        )
        customer.phones.forEachIndexed { index, phone ->
            CallButton(
                phone = phone,
                onClick = { onCall(phone) },
                modifier = Modifier.testTag(CustomerTags.call(index)),
            )
        }
    }
}

/** The due, as big as an amount gets, in red with "बाकी"; "₹0 कुछ बाकी नहीं" when nothing is due; credit apart. */
@Composable
private fun DueBlock(customer: CustomerView) {
    if (customer.duePaise > 0) {
        AmountDisplay(
            amountPaise = customer.duePaise,
            tone = AmountTone.Due,
            dueLabel = stringResource(R.string.common_due),
            modifier = Modifier.testTag(CustomerTags.DUE),
        )
    } else {
        Row(
            modifier = Modifier.testTag(CustomerTags.DUE),
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            AmountDisplay(amountPaise = 0, tone = AmountTone.Neutral)
            Text(
                text = stringResource(R.string.mobile_search_customer_nothing_due),
                style = MaterialTheme.typography.titleMedium,
                color = Tokens.Color.Text,
            )
        }
    }
    if (customer.includesPhonePayments) {
        InfoLine(
            icon = painterResource(DesignR.drawable.ic_cb_pending),
            tint = CableTheme.semanticColors.pending,
            text = stringResource(R.string.mobile_search_customer_includes_phone_payments),
            modifier = Modifier.testTag(CustomerTags.PHONE_PAYMENTS),
        )
    }
    if (customer.creditPaise > 0) {
        AmountDisplay(
            amountPaise = customer.creditPaise,
            tone = AmountTone.Credit,
            creditLabel = stringResource(R.string.common_credit),
            style = CableTheme.numericTypography.amountSmall,
            modifier = Modifier.testTag(CustomerTags.CREDIT),
        )
    }
}

/** 📞 98765 43210 · Call: opens the dialer (the lineman presses call there). */
@Composable
private fun CallButton(
    phone: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().heightIn(min = CableSizes.TouchMin),
        shape = MaterialTheme.shapes.medium,
    ) {
        Icon(
            painter = painterResource(DesignR.drawable.ic_cb_call),
            contentDescription = null,
            modifier = Modifier.size(CableSizes.Icon),
        )
        Spacer(Modifier.size(CableSpacing.S3))
        Text(
            text = phone,
            style = CableTheme.numericTypography.body,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        Text(text = stringResource(R.string.mobile_search_customer_call), style = MaterialTheme.typography.labelLarge)
    }
}

/** An icon in its colour and a short line of text. */
@Composable
private fun InfoLine(
    icon: Painter,
    tint: Color,
    text: String,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(painter = icon, contentDescription = null, tint = tint, modifier = Modifier.size(CableSizes.Icon))
        Text(text = text, style = MaterialTheme.typography.bodyLarge, color = Tokens.Color.Text)
    }
}
