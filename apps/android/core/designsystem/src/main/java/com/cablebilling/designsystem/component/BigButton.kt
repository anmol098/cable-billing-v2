package com.cablebilling.designsystem.component

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonColors
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.text.style.TextAlign
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme

/**
 * The big full-width button: icon + short word (PLAN §2.2 rule 3), at least
 * [CableSizes.PrimaryButton] (64dp) tall, text `titleMedium` (22sp). Put it at the bottom of the
 * screen, where the thumb reaches.
 *
 * @param text the word, from string resources (e.g. `R.string.common_collect`).
 * @param icon e.g. `painterResource(DesignR.drawable.ic_cb_collect)`; decorative (the word is read).
 */
@Composable
fun BigButton(
    text: String,
    icon: Painter,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    style: BigButtonStyle = BigButtonStyle.Primary,
    enabled: Boolean = true,
) {
    Button(
        onClick = onClick,
        modifier = modifier.fillMaxWidth().heightIn(min = CableSizes.PrimaryButton),
        enabled = enabled,
        shape = MaterialTheme.shapes.medium,
        colors = bigButtonColors(style),
        elevation = null,
        border = if (style == BigButtonStyle.Secondary) BorderStroke(Tokens.Border.Strong, Tokens.Color.Text) else null,
        contentPadding = PaddingValues(horizontal = CableSpacing.S4, vertical = CableSpacing.S3),
    ) {
        Icon(painter = icon, contentDescription = null, modifier = Modifier.size(CableSizes.Icon))
        Spacer(Modifier.width(CableSpacing.S3))
        Text(text = text, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
    }
}

@Composable
private fun bigButtonColors(style: BigButtonStyle): ButtonColors {
    val container =
        when (style) {
            BigButtonStyle.Primary -> Tokens.Color.Accent
            BigButtonStyle.Success -> CableTheme.semanticColors.success
            BigButtonStyle.Secondary -> Tokens.Color.Bg
        }
    val content = if (style == BigButtonStyle.Secondary) Tokens.Color.Text else Tokens.Color.OnAccent
    return ButtonDefaults.buttonColors(
        containerColor = container,
        contentColor = content,
        disabledContainerColor = Tokens.Color.Border,
        disabledContentColor = Tokens.Color.TextMuted,
    )
}
