package com.cablebilling.lineman.feature.settings

import android.content.Intent
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasAnyDescendant
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.navigation.NavHostController
import androidx.navigation.compose.rememberNavController
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.NoOpSpeaker
import com.cablebilling.lineman.data.payments.PaymentFixtures
import com.cablebilling.lineman.feature.search.SearchContent
import com.cablebilling.lineman.feature.search.SearchUiState
import com.cablebilling.lineman.printing.SavedPrinter
import com.cablebilling.lineman.ui.CableApp
import com.cablebilling.lineman.ui.PlaceholderScreen
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The settings screen in Hindi (Compose UI on Robolectric) with its ViewModel over [FakeSettingsData]:
 * words, language, voice, printer, sign-out blocked → Try now / Waiting → possible → confirm, the app
 * report on the share sheet, touch targets, and the ways in (the gear on the search home, the route).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi-w360dp-h800dp")
class SettingsScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val data = FakeSettingsData()
    private val speaker = NoOpSpeaker()
    private var printerSetups = 0
    private var waitingOpened = 0
    private var backs = 0

    private fun show() {
        val viewModel = SettingsViewModel(data)
        composeRule.setContent {
            CompositionLocalProvider(LocalSpeaker provides speaker) {
                CableTheme {
                    Settings(
                        onBack = { backs++ },
                        onPrinterSetup = { printerSetups++ },
                        onOpenWaiting = { waitingOpened++ },
                        viewModel = viewModel,
                    )
                }
            }
        }
    }

    private fun node(tag: String): SemanticsNodeInteraction = composeRule.onNodeWithTag(tag).performScrollTo()

    private fun SemanticsNodeInteraction.hasTextInside(text: String) =
        assert(hasText(text, substring = true) or hasAnyDescendant(hasText(text, substring = true)))

    @Test
    fun `Hindi words, language, voice, printer and version`() {
        data.printer.value = SavedPrinter("00:11:22:33:44:55", "RPP02N")
        show()

        composeRule.onNodeWithTag(SettingsTags.SCREEN).hasTextInside("सेटिंग")
        // Each language in its own script; the current one is marked.
        node(SettingsTags.LANGUAGE_HINDI).hasTextInside("हिंदी").assertIsSelected()
        node(SettingsTags.LANGUAGE_ENGLISH).hasTextInside("English").assertIsNotSelected()
        node(SettingsTags.VOICE).hasTextInside("आवाज़ चालू")
        node(SettingsTags.PRINTER_NAME).assert(hasText("RPP02N"))
        node(SettingsTags.SIGNED_IN).assert(hasText("लॉग इन: ${PaymentFixtures.login.user.name}"))
        node(SettingsTags.VERSION).assert(hasText("ऐप वर्ज़न 0.1.0-dev (1)"))
        assertTouchTargets()

        node(SettingsTags.LANGUAGE_ENGLISH).performClick()
        assertEquals(listOf("en"), data.languageChanges)
        node(SettingsTags.LANGUAGE_ENGLISH).assertIsSelected()

        node(SettingsTags.VOICE).performClick()
        assertTrue(speaker.isMuted.value)
        node(SettingsTags.VOICE).hasTextInside("आवाज़ बंद")

        node(SettingsTags.PRINTER_SET_UP).hasTextInside("प्रिंटर लगाएँ").performClick()
        assertEquals(1, printerSetups)
        composeRule.onNodeWithTag(SettingsTags.BACK).performClick()
        assertEquals(1, backs)
    }

    @Test
    fun `no printer yet`() {
        show()
        node(SettingsTags.PRINTER_NAME).assert(hasText("अभी कोई प्रिंटर नहीं"))
    }

    @Test
    fun `sign-out waits for the payments on the phone, explains why, then asks and signs out`() {
        data.waiting.value = 2
        show()

        node(SettingsTags.SIGN_OUT).hasTextInside("लॉग आउट करें").performClick()
        node(SettingsTags.BLOCKED)
            .hasTextInside("अभी लॉग आउट नहीं हो सकता")
            .hasTextInside("2 पेमेंट अभी फ़ोन में हैं")
            .hasTextInside("लॉग आउट से ये कभी नहीं मिटते")
        assertEquals(0, data.signOuts)
        assertTouchTargets()

        node(SettingsTags.TRY_NOW).hasTextInside("अभी भेजें").performClick()
        assertEquals(1, data.tries)
        node(SettingsTags.OPEN_WAITING).hasTextInside("इंतज़ार में देखें").performClick()
        assertEquals(1, waitingOpened)

        // The push got them to the office: the screen says so, and sign-out is possible.
        data.waiting.value = 0
        composeRule.waitForIdle()
        node(SettingsTags.NOW_POSSIBLE).hasTextInside("आपके सब पेमेंट ऑफिस पहुँच गए")
        node(SettingsTags.SIGN_OUT).performClick()
        node(SettingsTags.CONFIRM).hasTextInside("इस फ़ोन से लॉग आउट करें?")
        node(SettingsTags.CONFIRM_YES).hasTextInside("हाँ, लॉग आउट करें").performClick()
        composeRule.waitForIdle()
        assertEquals(1, data.signOuts)
    }

    @Test
    fun `cancel at the question keeps the lineman signed in`() {
        show()
        node(SettingsTags.SIGN_OUT).performClick()
        node(SettingsTags.CONFIRM_CANCEL).hasTextInside("रद्द करें").performClick()
        node(SettingsTags.SIGN_OUT).assertIsDisplayed()
        assertEquals(0, data.signOuts)
    }

    @Test
    fun `the app report opens the share sheet as text - shared, never sent`() {
        data.reportText = "Cable Billing lineman app report\nlog lines=0"
        show()

        node(SettingsTags.SHARE_REPORT).hasTextInside("ऐप रिपोर्ट शेयर करें").performClick()
        composeRule.waitForIdle()
        val chooser = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertEquals(Intent.ACTION_CHOOSER, chooser.action)
        @Suppress("DEPRECATION")
        val send = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
        assertEquals(data.reportText, send.getStringExtra(Intent.EXTRA_TEXT))
        assertEquals("केबल बिलिंग ऐप रिपोर्ट", send.getStringExtra(Intent.EXTRA_SUBJECT))
    }

    @Test
    fun `the search home has a small gear that opens settings`() {
        var opened = 0
        composeRule.setContent {
            CableTheme {
                SearchContent(
                    state = SearchUiState(),
                    onKey = {},
                    onTextChange = {},
                    onShowNumberPad = {},
                    onBannerClick = {},
                    onOpenCustomer = {},
                    onOpenSettings = { opened++ },
                )
            }
        }
        composeRule
            .onNodeWithTag(SettingsTags.OPEN)
            .assert(hasContentDescription("सेटिंग"))
            .performClick()
        assertEquals(1, opened)
        assertTouchTargets()
    }

    @Test
    fun `the settings route sits on the Search tab and Open Waiting switches to the Waiting tab`() {
        lateinit var nav: NavHostController
        composeRule.setContent {
            nav = rememberNavController()
            CableTheme {
                CableApp(
                    navController = nav,
                    searchHome = { _, _ -> PlaceholderScreen(title = "search", testTag = "screen_search") },
                    waitingScreen = { PlaceholderScreen(title = "waiting", testTag = "screen_waiting") },
                    settingsScreen = { _, onOpenWaiting, _ ->
                        PlaceholderScreen(title = "settings", testTag = "stand_in_settings")
                        onOpenWaitingFromSettings = onOpenWaiting
                    },
                )
            }
        }
        composeRule.runOnUiThread { nav.navigate(SettingsRoute) }
        composeRule.onNodeWithTag("stand_in_settings").assertIsDisplayed()
        composeRule.onNodeWithTag("nav_search").assertIsSelected()

        composeRule.runOnUiThread { onOpenWaitingFromSettings() }
        composeRule.onNodeWithTag("screen_waiting").assertIsDisplayed()
        composeRule.onNodeWithTag("nav_waiting").assertIsSelected()
    }

    private var onOpenWaitingFromSettings: () -> Unit = {}

    private fun assertTouchTargets() {
        val minimum = CableSizes.TouchMin
        val tappable =
            composeRule.onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick)).fetchSemanticsNodes()
        assertTrue(tappable.isNotEmpty())
        for (node in tappable) {
            val (width, height) = with(composeRule.density) { node.size.width.toDp() to node.size.height.toDp() }
            assertTrue("$width x $height too small: ${node.config}", width >= minimum && height >= minimum)
        }
    }
}
