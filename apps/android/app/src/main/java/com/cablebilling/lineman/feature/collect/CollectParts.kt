package com.cablebilling.lineman.feature.collect

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import com.cablebilling.designsystem.component.PaymentMethod
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.lineman.R
import com.cablebilling.designsystem.R as DesignR

/** ← Back on the left, [end] (e.g. the speak button) on the right. */
@Composable
internal fun BackRow(
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    end: @Composable () -> Unit = {},
) {
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = CableSpacing.S2, vertical = CableSpacing.S2),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            onClick = onBack,
            modifier = Modifier.heightIn(min = CableSizes.TouchMin).testTag(CollectTags.BACK),
        ) {
            Icon(
                painter = painterResource(DesignR.drawable.ic_cb_back),
                contentDescription = null,
                modifier = Modifier.size(CableSizes.Icon),
            )
            Spacer(Modifier.size(CableSpacing.S2))
            Text(text = stringResource(R.string.common_back), style = MaterialTheme.typography.labelLarge)
        }
        end()
    }
}

/** An icon in its colour and a short line of text (never colour alone, PLAN §2.2 rule 3). */
@Composable
internal fun InfoLine(
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

/** 📞 Call office: a full-width outlined button (opens the dialer; the lineman presses call). */
@Composable
internal fun CallOfficeButton(
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
            text = stringResource(R.string.common_call_office),
            style = MaterialTheme.typography.labelLarge,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** The method's word: नकद / UPI. */
@Composable
internal fun methodLabel(method: PaymentMethod): String =
    stringResource(if (method == PaymentMethod.Upi) R.string.common_upi else R.string.common_cash)
