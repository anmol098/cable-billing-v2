package com.cablebilling.lineman.voice

import android.speech.tts.TextToSpeech
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.LocalSpeaker
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** VoiceHost (lifecycle + one-time Hindi prompt), SpeakOnShow and spokenText, in the Hindi UI. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi")
class VoiceHostTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val due = VoiceLine(hindi = "चार सौ पचास रुपये बाकी", english = "four hundred fifty rupees due")
    private val saved = VoiceLine(hindi = "पैसे फ़ोन में सेव हो गए", english = "Money saved on phone")

    private fun promptCount() = composeRule.onAllNodesWithTag(HindiVoicePromptTags.PROMPT).fetchSemanticsNodes().size

    private fun host(speaker: TtsSpeaker) =
        composeRule.setContent {
            CompositionLocalProvider(LocalSpeaker provides speaker) {
                CableTheme { VoiceHost() }
            }
        }

    @Test
    fun `starts the engine when shown and prompts once for the missing Hindi voice`() {
        phoneHasVoices(ENGLISH_IN)
        phoneCanDownloadVoices()
        val settings = FakeVoiceSettings()
        val speaker = newSpeaker(settings)
        host(speaker)
        composeRule.waitForIdle()
        assertEquals("the engine starts with the screen", VoiceStatus.Starting, speaker.status.value)
        assertEquals(0, promptCount())

        lastEngine().answer(TextToSpeech.SUCCESS)
        composeRule.waitForIdle()
        composeRule.onNodeWithTag(HindiVoicePromptTags.PROMPT).assertIsDisplayed()
        composeRule.onNodeWithText("फ़ोन में हिंदी आवाज़ नहीं है").assertIsDisplayed()
        assertTrue("remembered as soon as it shows", settings.promptShownState.value)
        composeRule
            .onNodeWithTag(HindiVoicePromptTags.DOWNLOAD)
            .assert(hasText("डाउनलोड करें"))
            .assertHeightIsAtLeast(CableSizes.PrimaryButton)
        composeRule
            .onNodeWithTag(HindiVoicePromptTags.LATER)
            .assert(hasText("बाद में"))
            .assertHeightIsAtLeast(CableSizes.PrimaryButton)

        composeRule.onNodeWithTag(HindiVoicePromptTags.LATER).performClick()
        composeRule.waitForIdle()
        assertEquals(0, promptCount())
        assertNull(shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity)

        // Coming back to the app re-checks the voices, but the prompt never shows again.
        speaker.warmUp()
        lastEngine().answer(TextToSpeech.SUCCESS)
        composeRule.waitForIdle()
        assertEquals(0, promptCount())
    }

    @Test
    fun `download opens the phone's voice download screen`() {
        phoneHasVoices(ENGLISH_IN)
        phoneCanDownloadVoices()
        val speaker = newSpeaker()
        host(speaker)
        composeRule.waitForIdle()
        lastEngine().answer(TextToSpeech.SUCCESS)
        composeRule.waitForIdle()

        composeRule.onNodeWithTag(HindiVoicePromptTags.DOWNLOAD).performClick()
        composeRule.waitForIdle()
        assertEquals(0, promptCount())
        val started = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertEquals(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA, started?.action)
    }

    @Test
    fun `no prompt when the Hindi voice is there`() {
        phoneHasVoices(HINDI_IN, ENGLISH_IN)
        phoneCanDownloadVoices()
        host(newSpeaker())
        composeRule.waitForIdle()
        lastEngine().answer(TextToSpeech.SUCCESS)
        composeRule.waitForIdle()
        assertEquals(0, promptCount())
    }

    @Test
    fun `no prompt after the next app start once it was shown`() {
        phoneHasVoices(ENGLISH_IN)
        phoneCanDownloadVoices()
        host(newSpeaker(FakeVoiceSettings(promptShown = true)))
        composeRule.waitForIdle()
        lastEngine().answer(TextToSpeech.SUCCESS)
        composeRule.waitForIdle()
        assertEquals(0, promptCount())
    }

    @Test
    fun `SpeakOnShow speaks on entry and stops on leaving, without cutting off the next screen`() {
        phoneHasVoices(HINDI_IN)
        val speaker = newSpeaker()
        speaker.warmUp()
        val engine = lastEngine()
        engine.answer(TextToSpeech.SUCCESS)
        var screen by mutableStateOf("customer")
        composeRule.setContent {
            CompositionLocalProvider(LocalSpeaker provides speaker) {
                CableTheme {
                    Column {
                        when (screen) {
                            "customer" -> SpeakOnShow(due)
                            "done" -> SpeakOnShow(saved)
                            else -> Text("search")
                        }
                    }
                }
            }
        }
        composeRule.waitForIdle()
        assertEquals(due.hindi, engine.lastSpoken)

        screen = "done"
        composeRule.waitForIdle()
        assertEquals(saved.hindi, engine.lastSpoken)
        assertFalse("leaving Customer must not stop Done's read-out", shadowOf(engine).isStopped)

        screen = "search"
        composeRule.waitForIdle()
        assertTrue("leaving Done stops its read-out", shadowOf(engine).isStopped)
    }

    @Test
    fun `spokenText follows the voice the phone has`() {
        phoneHasVoices(ENGLISH_IN)
        val speaker = newSpeaker()
        var text = ""
        composeRule.setContent {
            CompositionLocalProvider(LocalSpeaker provides speaker) { text = spokenText(due) }
        }
        composeRule.waitForIdle()
        assertEquals(due.hindi, text)
        speaker.warmUp()
        lastEngine().answer(TextToSpeech.SUCCESS)
        composeRule.waitForIdle()
        assertEquals(due.english, text)
    }
}
