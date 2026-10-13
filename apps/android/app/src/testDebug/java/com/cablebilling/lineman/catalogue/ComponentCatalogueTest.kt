package com.cablebilling.lineman.catalogue

import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.AmountDisplayTags
import com.cablebilling.designsystem.component.NumberPadTags
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The debug-only component catalogue shows every component, in Hindi and in English. (Test names are
 * camelCase here: detekt treats only `src/test` as test code, not `src/testDebug`.)
 */
@RunWith(AndroidJUnit4::class)
class ComponentCatalogueTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val sections =
        listOf(
            "BigButton",
            "MethodButton",
            "AmountDisplay",
            "NumberPad",
            "StatusChip",
            "SyncBanner",
            "CustomerRow",
            "ConfirmCard",
            "ReceiptActionTile",
            "SpeakButton",
        )

    /** The first node showing [value] (some words appear in more than one component). */
    private fun text(value: String): SemanticsNodeInteraction =
        composeRule.onAllNodesWithText(value, useUnmergedTree = true).onFirst().performScrollTo()

    @Test
    fun showsEveryComponentInHindiThenInEnglish() {
        composeRule.setContent { ComponentCatalogue() }

        sections.forEach { composeRule.onNodeWithTag(CatalogueTags.section(it)).performScrollTo() }
        text("कॉम्पोनेंट (टेस्ट)")
        text("पैसे लें")
        text("नकद")
        text("फ़ोन में सेव")
        text("फ़ोन में 3 पेमेंट")
        text("WhatsApp खुल गया")
        text("सुनें")

        composeRule.onNodeWithTag(CatalogueTags.language("en")).performScrollTo().performClick()

        text("Components (test)")
        text("Collect")
        text("Cash")
        text("Saved on phone")
        text("3 payments on phone")
        text("WhatsApp opened")
        text("Listen")
        composeRule.onNodeWithText("पैसे लें", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test
    fun amountPadTypesAnAmount() {
        composeRule.setContent { ComponentCatalogue(initialLanguage = "en") }
        val inAmountEntry = hasAnyAncestor(hasTestTag(CatalogueTags.AMOUNT_ENTRY))
        TYPED_DIGITS.forEach { digit ->
            composeRule
                .onNode(hasTestTag(NumberPadTags.digit(digit)) and inAmountEntry)
                .performScrollTo()
                .performClick()
        }
        composeRule
            .onNode(hasTestTag(AmountDisplayTags.AMOUNT) and inAmountEntry, useUnmergedTree = true)
            .assertTextEquals("₹1,23,456")
    }

    private companion object {
        /** 1 2 3 4 5 6 → ₹1,23,456. */
        val TYPED_DIGITS = (1..6).toList()
    }
}
