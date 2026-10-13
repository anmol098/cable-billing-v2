package com.cablebilling.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme

/**
 * The strip at the top of Search (PLAN §11.3, PRD §10): when data was last updated, or how many
 * payments are waiting on the phone. Icon and text take the state's colour on the surface grey,
 * with a hairline under it. With [onClick] (e.g. open the Waiting tab) it is a [CableSizes.TouchMin]
 * tall button.
 *
 * @param text the full sentence, already formatted by the screen.
 */
@Composable
fun SyncBanner(
    state: SyncState,
    text: String,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
) {
    val color = state.color
    Column(modifier = modifier.fillMaxWidth().background(Tokens.Color.Surface)) {
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = CableSizes.TouchMin)
                    .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
                    .padding(horizontal = CableSpacing.S4, vertical = CableSpacing.S2),
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                painter = painterResource(state.icon),
                contentDescription = null,
                tint = color,
                modifier = Modifier.size(CableSizes.Icon),
            )
            val textColor = if (state == SyncState.Updated) Tokens.Color.Text else color
            Text(text = text, style = MaterialTheme.typography.labelLarge, color = textColor)
        }
        HorizontalDivider(thickness = Tokens.Border.Hairline, color = Tokens.Color.Border)
    }
}

private val SyncState.color: Color
    @Composable get() =
        when (this) {
            SyncState.Updated -> CableTheme.semanticColors.success
            SyncState.Waiting -> CableTheme.semanticColors.pending
            SyncState.Problem -> CableTheme.semanticColors.danger
        }
