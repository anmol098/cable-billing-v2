package com.cablebilling.designsystem.component

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme

/**
 * A search result (PLAN §11.3 Search): name, code and area on the left, the balance large on the
 * right (due in red with its word, credit in green). The whole row is tappable, at least
 * [CableSizes.TouchMin] tall, with a hairline under it.
 *
 * @param balancePaise the customer's balance in paise: positive = due, negative = credit.
 * @param dueLabel / creditLabel words under the amount (`common_due` / `common_credit`).
 */
@Composable
fun CustomerRow(
    name: String,
    code: String,
    balancePaise: Long,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    area: String? = null,
    dueLabel: String? = null,
    creditLabel: String? = null,
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier =
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = CableSizes.TouchMin)
                    .clickable(role = Role.Button, onClick = onClick)
                    .padding(horizontal = CableSpacing.S4, vertical = CableSpacing.S3),
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = name,
                    style = MaterialTheme.typography.titleMedium,
                    color = Tokens.Color.Text,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(CableSpacing.S3)) {
                    Text(text = code, style = CableTheme.numericTypography.body, color = Tokens.Color.TextMuted)
                    if (area != null) {
                        Text(
                            text = area,
                            style = MaterialTheme.typography.bodyLarge,
                            color = Tokens.Color.TextMuted,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }
            }
            AmountDisplay(
                amountPaise = balancePaise,
                tone = AmountTone.Balance,
                dueLabel = dueLabel,
                creditLabel = creditLabel,
                style = CableTheme.numericTypography.amountSmall,
                labelStyle = MaterialTheme.typography.bodyLarge,
                labelBelow = true,
            )
        }
        HorizontalDivider(thickness = Tokens.Border.Hairline, color = Tokens.Color.Border)
    }
}
