package com.cablebilling.lineman.feature.printer

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.printing.FakeBluetoothPrinters
import com.cablebilling.lineman.printing.FakePrinterSettings
import com.cablebilling.lineman.printing.FakeReceiptPrinter
import com.cablebilling.lineman.printing.PRINTER_DEVICE
import com.cablebilling.lineman.printing.PrintProblem
import com.cablebilling.lineman.printing.PrintResult
import com.cablebilling.lineman.printing.SAVED_PRINTER
import com.cablebilling.lineman.printing.SavedPrinter
import com.cablebilling.lineman.printing.bluetooth.BluetoothAvailability
import com.cablebilling.lineman.printing.bluetooth.PrinterDevice
import com.cablebilling.lineman.voice.VoiceLines
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Printer setup in Hindi (Compose UI on Robolectric): the steps, then the real ViewModel with fakes. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi")
class PrinterSetupScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val found = PrinterDevice("AA:BB:CC:DD:EE:01", "RPP02N", looksLikePrinter = true)

    private class RecordingSpeaker : Speaker {
        val said = mutableListOf<String>()
        override val isMuted: StateFlow<Boolean> = MutableStateFlow(false)

        override fun setMuted(muted: Boolean) = Unit

        override fun say(text: String) {
            said += text
        }

        override fun stop() = Unit
    }

    private var calls = mutableListOf<String>()

    private fun showScreen(state: PrinterSetupUiState) {
        composeRule.setContent {
            CableTheme {
                PrinterSetupScreen(
                    state = state,
                    onBack = { calls += "back" },
                    onAllow = { calls += "allow" },
                    onOpenSettings = { calls += "settings" },
                    onTurnOnBluetooth = { calls += "turnOn" },
                    onFind = { calls += "find" },
                    onCancelFind = { calls += "cancelFind" },
                    onChoose = { calls += "choose ${it.address}" },
                    onPair = { calls += "pair ${it.address}" },
                    onTestPrint = { calls += "test" },
                )
            }
        }
    }

    private fun assertMinHeight(
        tag: String,
        min: Dp,
    ) {
        val bounds = composeRule.onNodeWithTag(tag).getUnclippedBoundsInRoot()
        assertTrue("$tag is ${bounds.bottom - bounds.top}", bounds.bottom - bounds.top >= min)
    }

    @Test
    fun explainsBeforeAskingForBluetoothPermission() {
        showScreen(PrinterSetupUiState(canPrint = false))
        composeRule.onNodeWithText("रसीद प्रिंट करने के लिए ऐप को ब्लूटूथ चलाने दें").assertIsDisplayed()
        composeRule.onNodeWithText("इजाज़त दें").assertIsDisplayed()
        assertMinHeight(PrinterSetupTags.ALLOW, CableSizes.PrimaryButton)
        composeRule.onNodeWithTag(PrinterSetupTags.ALLOW).performClick()
        assertEquals(listOf("allow"), calls)
        composeRule.onNodeWithTag(PrinterSetupTags.OPEN_SETTINGS).assertDoesNotExist()
    }

    @Test
    fun deniedForGoodOffersTheSettingsScreen() {
        showScreen(PrinterSetupUiState(canPrint = false, permissionBlocked = true))
        composeRule.onNodeWithText("ब्लूटूथ की इजाज़त बंद है। सेटिंग में चालू करें।").assertIsDisplayed()
        composeRule.onNodeWithTag(PrinterSetupTags.OPEN_SETTINGS).performClick()
        assertEquals(listOf("settings"), calls)
    }

    @Test
    fun bluetoothOffAndMissing() {
        var state by mutableStateOf(PrinterSetupUiState(canPrint = true, bluetooth = BluetoothAvailability.Off))
        composeRule.setContent {
            CableTheme {
                PrinterSetupScreen(
                    state = state,
                    onBack = {},
                    onAllow = {},
                    onOpenSettings = {},
                    onTurnOnBluetooth = { calls += "turnOn" },
                    onFind = {},
                    onCancelFind = {},
                    onChoose = {},
                    onPair = {},
                    onTestPrint = {},
                )
            }
        }
        composeRule.onNodeWithText("ब्लूटूथ बंद है").assertIsDisplayed()
        composeRule.onNodeWithTag(PrinterSetupTags.TURN_ON).performClick()
        assertEquals(listOf("turnOn"), calls)

        state = PrinterSetupUiState(bluetooth = BluetoothAvailability.Missing)
        composeRule.onNodeWithTag(PrinterSetupTags.NO_BLUETOOTH).assertIsDisplayed()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).assertDoesNotExist()
    }

    @Test
    fun choosingScreenListsPrintersWithBigTargets() {
        showScreen(
            PrinterSetupUiState(
                canPrint = true,
                canFind = true,
                saved = SAVED_PRINTER,
                paired = listOf(PRINTER_DEVICE),
                found = listOf(found),
                test = TestPrint.Failed(PrintProblem.NoPaper),
            ),
        )
        composeRule.onNodeWithText("आपका प्रिंटर").assertIsDisplayed()
        composeRule.onNodeWithText("प्रिंटर में कागज़ नहीं है").assertIsDisplayed()
        composeRule.onNodeWithText("नए प्रिंटर").performScrollTo().assertIsDisplayed()
        // Every tappable thing is at least 56dp tall (PLAN §2.2), the main buttons 64dp.
        composeRule
            .onAllNodes(SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick))
            .fetchSemanticsNodes()
            .forEach { node ->
                val height = with(composeRule.density) { node.size.height.toDp() }
                assertTrue("tappable node is $height", height >= CableSizes.TouchMin)
            }
        assertMinHeight(PrinterSetupTags.TEST_PRINT, CableSizes.PrimaryButton)
        assertMinHeight(PrinterSetupTags.FIND, CableSizes.PrimaryButton)

        composeRule.onNodeWithTag(PrinterSetupTags.TEST_PRINT).performClick()
        composeRule.onNodeWithTag(PrinterSetupTags.paired(PRINTER_DEVICE.address)).performScrollTo().performClick()
        composeRule.onNodeWithTag(PrinterSetupTags.found(found.address)).performScrollTo().performClick()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).performScrollTo().performClick()
        composeRule.onNodeWithTag(PrinterSetupTags.BACK).performScrollTo().performClick()
        assertEquals(listOf("test", "choose ${PRINTER_DEVICE.address}", "pair ${found.address}", "find", "back"), calls)
    }

    @Test
    fun buttonsWaitWhilePrinting() {
        showScreen(PrinterSetupUiState(canPrint = true, saved = SAVED_PRINTER, test = TestPrint.Printing))
        composeRule.onNodeWithText("प्रिंट हो रहा है…").assertIsDisplayed()
        composeRule.onNodeWithTag(PrinterSetupTags.TEST_PRINT).assertIsNotEnabled()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).assertIsNotEnabled()
    }

    // --- With the real ViewModel -------------------------------------------------------------

    private val bluetooth = FakeBluetoothPrinters()
    private val settings = FakePrinterSettings()
    private val printer = FakeReceiptPrinter()
    private val speaker = RecordingSpeaker()

    private fun showWithViewModel(): PrinterSetupViewModel {
        val viewModel =
            PrinterSetupViewModel(
                bluetooth,
                settings,
                printer,
                speaker,
                VoiceLines(RuntimeEnvironment.getApplication()),
            )
        composeRule.setContent {
            CableTheme {
                val state by viewModel.state.collectAsStateWithLifecycle()
                PrinterSetupScreen(
                    state = state,
                    onBack = {},
                    onAllow = {},
                    onOpenSettings = {},
                    onTurnOnBluetooth = {},
                    onFind = viewModel::find,
                    onCancelFind = viewModel::dismissFindExplainer,
                    onChoose = viewModel::choose,
                    onPair = viewModel::pairAndChoose,
                    onTestPrint = viewModel::testPrint,
                )
            }
        }
        return viewModel
    }

    @Test
    fun tappingAPairedPrinterRemembersItAndPrintsTheTestPage() {
        showWithViewModel()
        composeRule
            .onNodeWithText(
                "अभी कोई प्रिंटर नहीं। प्रिंटर चालू करें और 'प्रिंटर खोजें' दबाएँ।",
            ).assertIsDisplayed()
        composeRule.onNodeWithTag(PrinterSetupTags.paired(PRINTER_DEVICE.address)).performClick()
        composeRule.waitForIdle()
        assertEquals(SAVED_PRINTER, settings.state.value)
        assertEquals(listOf<SavedPrinter?>(SAVED_PRINTER), printer.testPages)
        composeRule.onNodeWithText("प्रिंटर को मिल गया। कागज़ देखें।").assertIsDisplayed()
        assertEquals(listOf("प्रिंटर को मिल गया। कागज़ देखें।"), speaker.said)
    }

    @Test
    fun aFailedTestPrintIsShownAndSpoken() {
        settings.state.value = SAVED_PRINTER
        printer.next = PrintResult.Failed(PrintProblem.Unreachable)
        showWithViewModel()
        composeRule.onNodeWithTag(PrinterSetupTags.TEST_PRINT).performClick()
        composeRule.waitForIdle()
        val message = "प्रिंटर नहीं मिला। क्या प्रिंटर चालू और पास में है?"
        composeRule.onNodeWithText(message).assertIsDisplayed()
        assertEquals(listOf(message), speaker.said)
        // Try again: the same button prints again.
        printer.next = PrintResult.Printed
        composeRule.onNodeWithTag(PrinterSetupTags.TEST_PRINT).performClick()
        composeRule.waitForIdle()
        assertEquals(2, printer.testPages.size)
    }

    @Test
    fun findPairAndPrint() {
        bluetooth.pairedDevices = emptyList()
        showWithViewModel()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).performClick()
        composeRule.onNodeWithText("प्रिंटर खोज रहे हैं…").assertIsDisplayed()
        runBlocking {
            bluetooth.discover(found)
            // A device seen twice is listed once.
            bluetooth.discover(found)
            bluetooth.finishFinding()
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(PrinterSetupTags.found(found.address)).performScrollTo().performClick()
        composeRule.waitForIdle()
        assertEquals(listOf(found.address), bluetooth.pairRequests)
        assertEquals(SavedPrinter(found.address, found.name), settings.state.value)
        assertEquals(1, printer.testPages.size)
        composeRule.onNodeWithTag(PrinterSetupTags.paired(found.address)).performScrollTo().assertIsDisplayed()
    }

    @Test
    fun failedPairingSaysSo() {
        bluetooth.pairedDevices = emptyList()
        bluetooth.pairResult = false
        showWithViewModel()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).performClick()
        runBlocking {
            bluetooth.discover(found)
            bluetooth.finishFinding()
        }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(PrinterSetupTags.found(found.address)).performScrollTo().performClick()
        composeRule.waitForIdle()
        composeRule.onNodeWithText("प्रिंटर से नहीं जुड़ा। फिर से करें।").performScrollTo().assertIsDisplayed()
        assertEquals(null, settings.state.value)
        assertTrue(printer.testPages.isEmpty())
    }

    @Test
    fun nothingFoundSaysSo() {
        showWithViewModel()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).performClick()
        runBlocking { bluetooth.finishFinding() }
        composeRule.waitForIdle()
        composeRule
            .onNodeWithText(
                "कोई प्रिंटर नहीं मिला। क्या प्रिंटर चालू और पास में है?",
            ).performScrollTo()
            .assertIsDisplayed()
    }

    @Test
    fun findingWithoutPermissionExplainsFirst() {
        bluetooth.canFind = false
        val viewModel = showWithViewModel()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).performClick()
        composeRule.onNodeWithTag(PrinterSetupTags.ALLOW).assertIsDisplayed()
        // Granted: the search starts by itself.
        bluetooth.canFind = true
        composeRule.runOnIdle { viewModel.onPermissionResult(granted = true, canAskAgain = true) }
        composeRule.onNodeWithText("प्रिंटर खोज रहे हैं…").assertIsDisplayed()
        // "Back" from the explainer returns to the list.
        bluetooth.canFind = false
        runBlocking { bluetooth.finishFinding() }
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).performScrollTo().performClick()
        composeRule.onNodeWithTag(PrinterSetupTags.CANCEL).performScrollTo().performClick()
        composeRule.onNodeWithTag(PrinterSetupTags.FIND).assertIsDisplayed()
    }
}
