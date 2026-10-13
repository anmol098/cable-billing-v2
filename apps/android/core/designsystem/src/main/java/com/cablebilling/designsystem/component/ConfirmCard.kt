package com.cablebilling.designsystem.component

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
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing

/**
 * The summary shown before money moves (PLAN §2.2 rule 7, §11.3 Confirm): customer name, the
 * amount (44sp) and the method's icon + colour + word, on a surface card with a hairline border.
 * The screen puts the big Save button ([BigButton] with [BigButtonStyle.Success]) under it and
 * reads the summary aloud with the [com.cablebilling.designsystem.voice.Speaker].
 *
 * @param methodLabel `common_cash` / `common_upi`.
 * @param details optional extra lines under the method (e.g. the UPI reference).
 */
@Composable
fun ConfirmCard(
    customerName: String,
    amountPaise: Long,
    method: PaymentMethod,
    methodLabel: String,
    modifier: Modifier = Modifier,
    details: (@Composable ColumnScope.() -> Unit)? = null,
) {
    val shape = MaterialTheme.shapes.large
    Column(
        modifier =
            modifier
                .fillMaxWidth()
                .background(Tokens.Color.Surface, shape)
                .border(Tokens.Border.Hairline, Tokens.Color.Border, shape)
                .padding(CableSpacing.S6),
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S3),
    ) {
        Text(text = customerName, style = MaterialTheme.typography.titleLarge, color = Tokens.Color.Text)
        AmountDisplay(amountPaise = amountPaise)
        Row(
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painter = painterResource(method.icon),
                contentDescription = null,
                tint = method.color,
                modifier = Modifier.size(CableSizes.IconLarge),
            )
            Text(text = methodLabel, style = MaterialTheme.typography.headlineSmall, color = method.color)
        }
        details?.invoke(this)
    }
}
