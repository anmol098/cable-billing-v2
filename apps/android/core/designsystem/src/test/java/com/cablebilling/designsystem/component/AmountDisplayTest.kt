package com.cablebilling.designsystem.component

import androidx.compose.runtime.Composable
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Compose UI tests (Robolectric) for AmountDisplay: ₹, Indian grouping, 44sp tabular figures, due/credit. */
@RunWith(AndroidJUnit4::class)
class AmountDisplayTest {
    @get:Rule
    val composeRule = createComposeRule()

    private fun show(content: @Composable () -> Unit) {
        composeRule.setContent { CableTheme(language = "hi", content = content) }
    }

    private val amount get() = composeRule.onNodeWithTag(AmountDisplayTags.AMOUNT, useUnmergedTree = true)
    private val label get() = composeRule.onNodeWithTag(AmountDisplayTags.LABEL, useUnmergedTree = true)

    @Test
    fun `shows paise as rupees with Indian grouping`() {
        show { AmountDisplay(amountPaise = 12_345_600L) }
        amount.assertTextEquals("₹1,23,456")
    }

    @Test
    fun `uses the amount type token with tabular figures in the text colour`() {
        show { AmountDisplay(amountPaise = 12_345_600L) }
        val style = amount.laidOutTextStyle()
        assertEquals(Tokens.Type.Amount, style.fontSize)
        assertEquals(Tokens.Weight.Strong, style.fontWeight)
        assertEquals(Tokens.Font.NumericFeatureSettings, style.fontFeatureSettings)
        assertEquals(Tokens.Color.Text, style.color)
        label.assertDoesNotExist()
    }

    @Test
    fun `shows paise only when not whole rupees`() {
        show { AmountDisplay(amountPaise = 1_250L) }
        amount.assertTextEquals("₹12.50")
    }

    @Test
    fun `a positive balance is due, in red with its word`() {
        show {
            AmountDisplay(
                amountPaise = 45_000L,
                tone = AmountTone.Balance,
                dueLabel = "बाकी",
                creditLabel = "एडवांस",
            )
        }
        amount.assertTextEquals("₹450")
        assertEquals(Tokens.Color.Due, amount.laidOutTextStyle().color)
        label.assertTextEquals("बाकी")
        assertEquals(Tokens.Color.Due, label.laidOutTextStyle().color)
    }

    @Test
    fun `a negative amount is a credit, in green, without a minus sign`() {
        show {
            AmountDisplay(
                amountPaise = -20_000L,
                tone = AmountTone.Balance,
                dueLabel = "बाकी",
                creditLabel = "एडवांस",
            )
        }
        amount.assertTextEquals("₹200")
        assertEquals(Tokens.Color.Credit, amount.laidOutTextStyle().color)
        label.assertTextEquals("एडवांस")
    }

    @Test
    fun `a zero balance is neutral with no word`() {
        show { AmountDisplay(amountPaise = 0L, tone = AmountTone.Balance, dueLabel = "बाकी") }
        amount.assertTextEquals("₹0")
        assertEquals(Tokens.Color.Text, amount.laidOutTextStyle().color)
        label.assertDoesNotExist()
    }

    @Test
    fun `tones resolve like the web`() {
        assertEquals(AmountTone.Due, AmountTone.Balance.resolve(1))
        assertEquals(AmountTone.Neutral, AmountTone.Balance.resolve(0))
        assertEquals(AmountTone.Credit, AmountTone.Balance.resolve(-1))
        assertEquals(AmountTone.Credit, AmountTone.Due.resolve(-1))
        assertEquals(AmountTone.Due, AmountTone.Due.resolve(0))
        assertEquals(AmountTone.Neutral, AmountTone.Neutral.resolve(5))
    }
}
