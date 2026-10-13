package com.cablebilling.designsystem.component

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing

/**
 * One of the four big tiles on the Done screen (PLAN §11.3, §11.7): Print, WhatsApp, SMS, Done.
 * Big icon above the word, [CableSizes.Tile] (128dp) tall, white with a hairline border. Lay them
 * out two by two with `Modifier.weight(1f)`.
 *
 * @param icon e.g. `painterResource(DesignR.drawable.ic_cb_print)`.
 * @param stateText what happened after a tap, said honestly: "WhatsApp खुल गया / WhatsApp opened"
 *   (`common_whatsapp_opened`), never "sent" (CLAUDE.md).
 */
@Composable
fun ReceiptActionTile(
    text: String,
    icon: Painter,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    stateText: String? = null,
    enabled: Boolean = true,
) {
    val shape = MaterialTheme.shapes.large
    val color = if (enabled) Tokens.Color.Text else Tokens.Color.TextMuted
    Column(
        modifier =
            modifier
                .heightIn(min = CableSizes.Tile)
                .clip(shape)
                .background(Tokens.Color.Bg, shape)
                .border(Tokens.Border.Strong, Tokens.Color.Border, shape)
                .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
                .padding(CableSpacing.S3),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(CableSpacing.S2, Alignment.CenterVertically),
    ) {
        Icon(painter = icon, contentDescription = null, tint = color, modifier = Modifier.size(CableSizes.IconLarge))
        Text(text = text, style = MaterialTheme.typography.titleMedium, color = color, textAlign = TextAlign.Center)
        if (stateText != null) {
            Text(
                text = stateText,
                style = MaterialTheme.typography.bodyLarge,
                color = Tokens.Color.TextMuted,
                textAlign = TextAlign.Center,
            )
        }
    }
}
