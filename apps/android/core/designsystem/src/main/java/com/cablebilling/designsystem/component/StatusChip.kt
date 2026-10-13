package com.cablebilling.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme

/**
 * A payment's state: icon + colour + word in a pill with a hairline outline. Not tappable (put it in
 * a row that is).
 *
 * @param text the state's word from string resources (see [PaymentStatus]).
 */
@Composable
fun StatusChip(
    status: PaymentStatus,
    text: String,
    modifier: Modifier = Modifier,
) {
    val color = status.color
    Row(
        modifier =
            modifier
                .border(Tokens.Border.Hairline, color, RoundedCornerShape(Tokens.Radius.Full))
                .padding(horizontal = CableSpacing.S3, vertical = CableSpacing.S1),
        horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            painter = painterResource(status.icon),
            contentDescription = null,
            tint = color,
            modifier = Modifier.size(CableSizes.Icon),
        )
        Text(text = text, style = MaterialTheme.typography.labelLarge, color = color)
    }
}
