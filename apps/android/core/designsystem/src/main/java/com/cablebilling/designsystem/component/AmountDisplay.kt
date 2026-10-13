package com.cablebilling.designsystem.component

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.designsystem.theme.CableSpacing
import com.cablebilling.designsystem.theme.CableTheme

/**
 * What an amount means (same as the web's `<Amount tone>`):
 * - [Neutral]: plain text colour.
 * - [Balance]: a customer balance; more than zero is money due (red), zero is neutral.
 * - [Due] / [Credit]: force that meaning.
 *
 * Whatever the tone, a negative amount is a credit (the customer paid extra): it is shown as the
 * positive amount in the credit colour, never with a minus sign.
 */
enum class AmountTone { Neutral, Balance, Due, Credit }

/** The tone actually shown for [paise] (resolves [AmountTone.Balance] and negatives). */
fun AmountTone.resolve(paise: Long): AmountTone =
    when {
        paise < 0 -> AmountTone.Credit
        this == AmountTone.Balance -> if (paise > 0) AmountTone.Due else AmountTone.Neutral
        else -> this
    }

/** Test tags inside an [AmountDisplay]. */
object AmountDisplayTags {
    const val AMOUNT = "amount_value"
    const val LABEL = "amount_label"
}

/**
 * A rupee amount, the biggest thing on a screen (PLAN §2.2 rule 2): `₹1,23,456` with Indian
 * grouping in Inter with tabular figures, `Tokens.Type.Amount` (44sp) by default. Paise show only
 * when the amount is not whole rupees.
 *
 * @param amountPaise integer paise (never a float).
 * @param dueLabel word after a due amount (`R.string.common_due`, "बाकी"). Never colour alone
 *   (PLAN §2.2 rule 3): pass it wherever a due amount can appear without other words around it.
 * @param creditLabel word after a credit (`R.string.common_credit`); pass it whenever the amount can
 *   be negative.
 * @param style `CableTheme.numericTypography.amount` (default) or `.amountSmall` for list rows.
 * @param labelStyle style of the word; keep it smaller than the number.
 * @param labelBelow put the word under the number instead of after it (narrow places, e.g. rows).
 */
@Composable
fun AmountDisplay(
    amountPaise: Long,
    modifier: Modifier = Modifier,
    tone: AmountTone = AmountTone.Neutral,
    dueLabel: String? = null,
    creditLabel: String? = null,
    style: TextStyle = CableTheme.numericTypography.amount,
    labelStyle: TextStyle = MaterialTheme.typography.titleMedium,
    labelBelow: Boolean = false,
) {
    val resolved = tone.resolve(amountPaise)
    val color = resolved.color()
    val label =
        when (resolved) {
            AmountTone.Due -> dueLabel
            AmountTone.Credit -> creditLabel
            else -> null
        }
    val amount: @Composable () -> Unit = {
        Text(
            text = Rupees.format(amountPaise),
            style = style,
            color = color,
            maxLines = 1,
            modifier = Modifier.testTag(AmountDisplayTags.AMOUNT),
        )
    }
    val word: @Composable () -> Unit = {
        if (label != null) {
            Text(
                text = label,
                style = labelStyle,
                color = color,
                modifier = Modifier.testTag(AmountDisplayTags.LABEL),
            )
        }
    }
    if (labelBelow) {
        Column(modifier = modifier, horizontalAlignment = Alignment.End) {
            amount()
            word()
        }
    } else {
        Row(
            modifier = modifier,
            horizontalArrangement = Arrangement.spacedBy(CableSpacing.S2),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            amount()
            word()
        }
    }
}

@Composable
private fun AmountTone.color(): Color =
    when (this) {
        AmountTone.Due -> CableTheme.semanticColors.due
        AmountTone.Credit -> CableTheme.semanticColors.credit
        else -> Tokens.Color.Text
    }
