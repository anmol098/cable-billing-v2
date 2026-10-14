package com.cablebilling.lineman.feature.today

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import com.cablebilling.designsystem.component.AmountDisplay
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.designsystem.component.color
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.R
import com.cablebilling.lineman.feature.collect.InfoLine
import com.cablebilling.lineman.printing.receipt.ReceiptDates
import java.time.Instant
import com.cablebilling.designsystem.R as DesignR
import com.cablebilling.lineman.data.network.generated.PaymentMethod as WireMethod

/** A white card with a hairline border (no shadow, PLAN §6.3). */
@Composable
internal fun TodayCard(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
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
        content = content,
    )
}

/**
 * One method's big tile (PLAN §11.3 Today): its icon and word in its colour, and its amount. Cash and UPI
 * always get a tile each; there is never one tile for both (PRD §15 #12).
 */
@Composable
internal fun MethodTile(
    method: PaymentMethod,
    amountPaise: Long,
    modifier: Modifier = Modifier,
) {
    val shape = MaterialTheme.shapes.large
    Column(
        modifier =
            modifier
                .background(Tokens.Color.Surface, shape)
                .border(Tokens.Border.Strong, method.color, shape)
                .padding(CableSpacing.S3),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S2),
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painter = painterResource(method.icon),
                contentDescription = null,
                tint = method.color,
                modifier = Modifier.size(CableSizes.IconLarge),
            )
            Text(text = methodWord(method), style = MaterialTheme.typography.titleLarge, color = method.color)
        }
        AmountDisplay(amountPaise = amountPaise, style = CableTheme.numericTypography.amountSmall)
    }
}

/**
 * A line of totals with cash and UPI side by side, each with its own icon and colour, never added up:
 * `💵 ₹100   📱 ₹50`.
 */
@Composable
internal fun SplitAmounts(
    totals: MethodTotals,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(CableSpacing.S4),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        MethodAmount(PaymentMethod.Cash, totals.cashPaise)
        MethodAmount(PaymentMethod.Upi, totals.upiPaise)
    }
}

@Composable
private fun MethodAmount(
    method: PaymentMethod,
    amountPaise: Long,
) {
    Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S1), verticalAlignment = Alignment.CenterVertically) {
        Icon(
            painter = painterResource(method.icon),
            contentDescription = methodWord(method),
            tint = method.color,
            modifier = Modifier.size(CableSizes.Icon),
        )
        Text(text = Rupees.format(amountPaise), style = CableTheme.numericTypography.body, color = Tokens.Color.Text)
    }
}

/** "₹50 कम / ₹50 short", "₹50 ज़्यादा / ₹50 extra" (red) or "कैश पूरा है / Cash matches" (green). */
@Composable
internal fun DifferenceLine(
    discrepancyPaise: Long,
    modifier: Modifier = Modifier,
) {
    val amount = Rupees.format(kotlin.math.abs(discrepancyPaise))
    when {
        discrepancyPaise < 0 -> {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_short),
                tint = CableTheme.semanticColors.danger,
                text = stringResource(R.string.mobile_today_status_short, amount),
                modifier = modifier,
            )
        }

        discrepancyPaise > 0 -> {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_extra),
                tint = CableTheme.semanticColors.danger,
                text = stringResource(R.string.mobile_today_status_extra, amount),
                modifier = modifier,
            )
        }

        else -> {
            InfoLine(
                icon = painterResource(DesignR.drawable.ic_cb_success),
                tint = CableTheme.semanticColors.success,
                text = stringResource(R.string.mobile_today_status_matches),
                modifier = modifier,
            )
        }
    }
}

/** नकद / UPI. */
@Composable
internal fun methodWord(method: PaymentMethod): String =
    stringResource(if (method == PaymentMethod.Upi) R.string.common_upi else R.string.common_cash)

internal val WireMethod.ui: PaymentMethod get() = if (this == WireMethod.UPI) PaymentMethod.Upi else PaymentMethod.Cash

/** `4:05 PM` in India time. */
@Composable
internal fun clockText(epochMillis: Long): String {
    val time = ReceiptDates.time(Instant.ofEpochMilli(epochMillis))
    return stringResource(
        if (time.afterNoon) R.string.mobile_printer_receipt_time_pm else R.string.mobile_printer_receipt_time_am,
        time.text,
    )
}
