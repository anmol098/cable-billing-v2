package com.cablebilling.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme

/**
 * A giant Cash / UPI tile for the Method screen (PLAN §11.3): filled with the method's colour, big
 * icon above the word, [CableSizes.Tile] (128dp) tall. Put two side by side with
 * `Modifier.weight(1f)`.
 *
 * @param text the method's word: `R.string.common_cash` / `R.string.common_upi`.
 */
@Composable
fun MethodButton(
    method: PaymentMethod,
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        modifier = modifier.heightIn(min = CableSizes.Tile),
        enabled = enabled,
        shape = MaterialTheme.shapes.large,
        colors =
            ButtonDefaults.buttonColors(
                containerColor = method.color,
                contentColor = Tokens.Color.OnAccent,
                disabledContainerColor = Tokens.Color.Border,
                disabledContentColor = Tokens.Color.TextMuted,
            ),
        elevation = null,
        contentPadding = PaddingValues(CableSpacing.S4),
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(CableSpacing.S2),
        ) {
            Icon(
                painter = painterResource(method.icon),
                contentDescription = null,
                modifier = Modifier.size(CableSizes.IconLarge),
            )
            Text(text = text, style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
        }
    }
}
