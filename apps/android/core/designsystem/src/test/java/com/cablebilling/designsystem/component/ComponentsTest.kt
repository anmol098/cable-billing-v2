package com.cablebilling.designsystem.component

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.Dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.NoOpSpeaker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Compose UI tests (Robolectric) for the rest of the kit, plus the size rules of PLAN §2.2 rule 9. */
@RunWith(AndroidJUnit4::class)
class ComponentsTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val speaker = RecordingSpeaker()
    private val clicks = mutableListOf<String>()

    private fun show(content: @Composable () -> Unit) {
        composeRule.setContent {
            CompositionLocalProvider(LocalSpeaker provides speaker) {
                CableTheme(language = "hi") {
                    Column(Modifier.verticalScroll(rememberScrollState())) { content() }
                }
            }
        }
    }

    /** Every component, as a screen would use it. */
    @Composable
    private fun AllComponents() {
        BigButton("पैसे लें", painterResource(R.drawable.ic_cb_collect), { clicks += "big" }, Modifier.testTag("big"))
        BigButton(
            text = "पीछे",
            icon = painterResource(R.drawable.ic_cb_back),
            onClick = { clicks += "secondary" },
            style = BigButtonStyle.Secondary,
        )
        Row {
            MethodButton(PaymentMethod.Cash, "नकद", { clicks += "cash" }, Modifier.weight(1f).testTag("cash"))
            MethodButton(PaymentMethod.Upi, "UPI", { clicks += "upi" }, Modifier.weight(1f).testTag("upi"))
        }
        NumberPad(onKey = {}, deleteLabel = "मिटाएँ", extraKey = NumberPadExtraKey.Letters("ABC"))
        StatusChip(PaymentStatus.SavedOnPhone, "फ़ोन में सेव")
        StatusChip(PaymentStatus.Sent, "ऑफिस पहुँच गया")
        StatusChip(PaymentStatus.NeedsHelp, "दिक्कत")
        CustomerRow(
            name = "रमेश कुमार",
            code = "C-0042",
            balancePaise = 45_000L,
            onClick = { clicks += "row" },
            modifier = Modifier.testTag("row"),
            area = "वार्ड 5",
            dueLabel = "बाकी",
        )
        SyncBanner(SyncState.Updated, "5 मिनट पहले अपडेट हुआ")
        SyncBanner(SyncState.Waiting, "फ़ोन में 3 पेमेंट", Modifier.testTag("banner"), onClick = { clicks += "banner" })
        ConfirmCard(customerName = "रमेश कुमार", amountPaise = 50_000L, method = PaymentMethod.Upi, methodLabel = "UPI")
        ReceiptActionTile(
            text = "प्रिंट",
            icon = painterResource(R.drawable.ic_cb_print),
            onClick = { clicks += "print" },
            modifier = Modifier.testTag("print"),
            stateText = "WhatsApp खुल गया",
        )
        SpeakButton(text = "रमेश कुमार, चार सौ पचास रुपये बाकी", label = "सुनें", modifier = Modifier.testTag("speak"))
        VoiceToggle(onLabel = "आवाज़ चालू", offLabel = "आवाज़ बंद", modifier = Modifier.testTag("voice"))
    }

    @Test
    fun `every tappable thing is at least 56dp and primary buttons 64dp`() {
        show { AllComponents() }
        val tappable = composeRule.onAllNodes(hasClickAction()).fetchSemanticsNodes()
        assertTrue("found ${tappable.size} tappable nodes", tappable.size >= 20)
        tappable.forEach { node ->
            // Layout size, not the visible bounds (most of the column is scrolled off screen).
            val density = node.layoutInfo.density
            val height = with(density) { node.size.height.toDp() }
            val width = with(density) { node.size.width.toDp() }
            assertAtLeast("height of ${node.config}", CableSizes.TouchMin, height)
            assertAtLeast("width of ${node.config}", CableSizes.TouchMin, width)
        }
        composeRule.onNodeWithTag("big").assertHeightIsAtLeast(Tokens.Size.PrimaryButton)
        composeRule.onNodeWithTag("cash").assertHeightIsAtLeast(CableSizes.Tile)
        composeRule.onNodeWithTag("print").assertHeightIsAtLeast(CableSizes.Tile)
    }

    @Test
    fun `no text is smaller than the 18sp body size`() {
        show { AllComponents() }
        val texts =
            composeRule
                .onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsProperties.Text), useUnmergedTree = true)
                .fetchSemanticsNodes()
                .mapNotNull { node -> node.laidOutTextStyle()?.let { node.config[SemanticsProperties.Text] to it } }
        assertTrue("found ${texts.size} texts", texts.size >= 25)
        texts.forEach { (text, style) ->
            assertTrue("$text is ${style.fontSize}", style.fontSize.value >= Tokens.Type.Base.value)
        }
    }

    @Test
    fun `buttons, tiles, rows and the banner call back`() {
        show { AllComponents() }
        listOf("big", "cash", "upi", "row", "banner", "print").forEach {
            composeRule.onNodeWithTag(it).performScrollTo().performClick()
        }
        composeRule.onNodeWithText("पीछे").performScrollTo().performClick()
        assertEquals(listOf("big", "cash", "upi", "row", "banner", "print", "secondary"), clicks)
    }

    @Test
    fun `colours carry the fixed meanings`() {
        show { AllComponents() }
        assertEquals(Tokens.Color.Pending, composeRule.onNodeWithText("फ़ोन में सेव").laidOutTextStyle().color)
        assertEquals(Tokens.Color.Success, composeRule.onNodeWithText("ऑफिस पहुँच गया").laidOutTextStyle().color)
        assertEquals(Tokens.Color.Danger, composeRule.onNodeWithText("दिक्कत").laidOutTextStyle().color)
        assertEquals(Tokens.Color.Pending, composeRule.onNodeWithText("फ़ोन में 3 पेमेंट").laidOutTextStyle().color)
        // UPI is white on the blue tile, and blue on the confirm card.
        assertEquals(listOf(Tokens.Color.OnAccent, Tokens.Color.Upi), textColors("UPI"))
        assertEquals(listOf(Tokens.Color.OnAccent), textColors("नकद"))
        // The customer row's due is red, with its word.
        composeRule.onNodeWithText("बाकी", useUnmergedTree = true).assertExists()
        composeRule.onNodeWithText("₹450", useUnmergedTree = true).assertExists()
    }

    @Test
    fun `disabled buttons cannot be pressed`() {
        show {
            BigButton("सेव करें", painterResource(R.drawable.ic_cb_success), {
                clicks += "save"
            }, Modifier.testTag("save"), enabled = false)
        }
        composeRule.onNodeWithTag("save").assertIsNotEnabled().performClick()
        assertTrue(clicks.isEmpty())
    }

    @Test
    fun `speak button reads aloud, and switches voice back on first`() {
        show { AllComponents() }
        composeRule.onNodeWithTag("speak").performScrollTo().performClick()
        assertEquals(listOf("रमेश कुमार, चार सौ पचास रुपये बाकी"), speaker.said)

        speaker.setMuted(true)
        composeRule.onNodeWithTag("speak").performScrollTo().performClick()
        assertFalse(speaker.isMuted.value)
        assertEquals(2, speaker.said.size)
    }

    @Test
    fun `voice toggle mutes and unmutes the speaker`() {
        show { AllComponents() }
        composeRule.onNodeWithTag("voice").assertIsOn()
        composeRule.onNodeWithText("आवाज़ चालू", useUnmergedTree = true).assertExists()

        composeRule.onNodeWithTag("voice").performScrollTo().performClick()
        assertTrue(speaker.isMuted.value)
        assertEquals(1, speaker.stops)
        composeRule.onNodeWithTag("voice").assertIsOff()
        composeRule.onNodeWithText("आवाज़ बंद", useUnmergedTree = true).assertExists()

        composeRule.onNodeWithTag("voice").performScrollTo().performClick()
        assertFalse(speaker.isMuted.value)
    }

    @Test
    fun `the no-op speaker is silent but keeps the mute state`() {
        val noOp = NoOpSpeaker()
        noOp.say("नमस्ते")
        noOp.stop()
        assertFalse(noOp.isMuted.value)
        noOp.setMuted(true)
        assertTrue(noOp.isMuted.value)
    }

    private fun textColors(text: String) =
        composeRule
            .onAllNodes(SemanticsMatcher.expectValue(SemanticsProperties.Text, listOf(AnnotatedString(text))), true)
            .fetchSemanticsNodes()
            .mapNotNull { it.laidOutTextStyle()?.color }

    private fun assertAtLeast(
        what: String,
        min: Dp,
        actual: Dp,
    ) {
        // Half a pixel of rounding is fine.
        assertTrue("$what: $actual < $min", actual.value >= min.value - ROUNDING)
    }

    private companion object {
        const val ROUNDING = 0.5f
    }
}
