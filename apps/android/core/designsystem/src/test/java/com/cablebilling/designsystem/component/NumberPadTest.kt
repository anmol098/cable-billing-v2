package com.cablebilling.designsystem.component

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertContentDescriptionEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.designsystem.theme.CableTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Compose UI tests (Robolectric) for typing on the NumberPad. */
@RunWith(AndroidJUnit4::class)
class NumberPadTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val haptics = RecordingHaptics()
    private val keys = mutableListOf<NumberPadKey>()

    /** An amount entry: the pad plus the AmountDisplay of what was typed. */
    private fun setAmountEntry(
        extraKey: NumberPadExtraKey = NumberPadExtraKey.DoubleZero,
        enabled: Boolean = true,
    ) {
        composeRule.setContent {
            CompositionLocalProvider(LocalHapticFeedback provides haptics) {
                CableTheme(language = "en") {
                    var digits by remember { mutableStateOf("") }
                    Column {
                        AmountDisplay(amountPaise = Rupees.digitsToPaise(digits) ?: 0L)
                        Text(text = digits, modifier = Modifier.testTag("digits"))
                        NumberPad(
                            onKey = { key ->
                                keys += key
                                digits = key.applyTo(digits, maxLength = 7, trimLeadingZeros = true)
                            },
                            deleteLabel = "Delete",
                            extraKey = extraKey,
                            enabled = enabled,
                        )
                    }
                }
            }
        }
    }

    private fun tap(tag: String) {
        composeRule.onNodeWithTag(tag).performClick()
    }

    @Test
    fun `typing digits builds the amount and shows it with Indian grouping`() {
        setAmountEntry()
        listOf(1, 2, 3, 4, 5, 6).forEach { tap(NumberPadTags.digit(it)) }

        composeRule.onNodeWithTag("digits").assertTextEquals("123456")
        composeRule.onNodeWithText("₹1,23,456").assertExists()
        assertEquals((1..6).map { NumberPadKey.Digit(it) }, keys)
    }

    @Test
    fun `every digit key sends its digit`() {
        setAmountEntry()
        (0..9).forEach { tap(NumberPadTags.digit(it)) }

        assertEquals((0..9).map { NumberPadKey.Digit(it) }, keys)
        // The leading 0 is dropped for amounts; the pad stops at 7 digits.
        composeRule.onNodeWithTag("digits").assertTextEquals("1234567")
    }

    @Test
    fun `double zero, backspace and long-press clear`() {
        setAmountEntry()
        tap(NumberPadTags.digit(5))
        tap(NumberPadTags.DOUBLE_ZERO)
        composeRule.onNodeWithText("₹500").assertExists()

        tap(NumberPadTags.BACKSPACE)
        composeRule.onNodeWithTag("digits").assertTextEquals("50")

        composeRule.onNodeWithTag(NumberPadTags.BACKSPACE).performTouchInput { longClick() }
        composeRule.onNodeWithTag("digits").assertTextEquals("")
        composeRule.onNodeWithText("₹0").assertExists()
        assertEquals(
            listOf(NumberPadKey.Digit(5), NumberPadKey.DoubleZero, NumberPadKey.Backspace, NumberPadKey.Clear),
            keys,
        )
    }

    @Test
    fun `every press gives haptic feedback`() {
        setAmountEntry()
        tap(NumberPadTags.digit(7))
        tap(NumberPadTags.DOUBLE_ZERO)
        tap(NumberPadTags.BACKSPACE)
        composeRule.onNodeWithTag(NumberPadTags.BACKSPACE).performTouchInput { longClick() }

        assertEquals(
            listOf(
                HapticFeedbackType.KeyboardTap,
                HapticFeedbackType.KeyboardTap,
                HapticFeedbackType.KeyboardTap,
                HapticFeedbackType.LongPress,
            ),
            haptics.events,
        )
    }

    @Test
    fun `the letters key replaces double zero for search`() {
        setAmountEntry(extraKey = NumberPadExtraKey.Letters("ABC"))
        composeRule.onNodeWithTag(NumberPadTags.DOUBLE_ZERO).assertDoesNotExist()
        composeRule.onNodeWithTag(NumberPadTags.LETTERS).assertTextEquals("ABC").performClick()
        assertEquals(listOf<NumberPadKey>(NumberPadKey.Letters), keys)
    }

    @Test
    fun `keys are big enough and the delete key has a spoken name`() {
        setAmountEntry()
        val tags = (0..9).map { NumberPadTags.digit(it) } + NumberPadTags.DOUBLE_ZERO + NumberPadTags.BACKSPACE
        tags.forEach { tag ->
            composeRule.onNodeWithTag(tag).assertHeightIsAtLeast(Tokens.Size.PrimaryButton)
        }
        composeRule.onNodeWithTag(NumberPadTags.BACKSPACE).assertContentDescriptionEquals("Delete")
        // Digits use the numeric font with tabular figures.
        val style = composeRule.onNodeWithText("5", useUnmergedTree = true).laidOutTextStyle()
        assertEquals(Tokens.Type.Xxl, style.fontSize)
        assertEquals(Tokens.Font.NumericFeatureSettings, style.fontFeatureSettings)
    }

    @Test
    fun `a disabled pad ignores presses`() {
        setAmountEntry(enabled = false)
        tap(NumberPadTags.digit(1))
        assertTrue(keys.isEmpty())
        assertTrue(haptics.events.isEmpty())
    }
}
