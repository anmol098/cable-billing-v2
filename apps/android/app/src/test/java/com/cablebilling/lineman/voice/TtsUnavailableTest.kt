package com.cablebilling.lineman.voice

import android.speech.tts.TextToSpeech
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.printToString
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.component.SpeakButton
import com.cablebilling.designsystem.component.VoiceToggle
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.NoOpSpeaker
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.MainActivity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.shadows.ShadowTextToSpeech

/**
 * T-067 acceptance: "With TTS unavailable the app behaves exactly as with NoOpSpeaker". Three ways
 * TTS can be unavailable (engine init fails, the engine cannot be created, it has neither
 * language) are compared step by step with [NoOpSpeaker].
 */
@RunWith(AndroidJUnit4::class)
class TtsUnavailableTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val line = VoiceLine(hindi = "चार सौ पचास रुपये बाकी", english = "four hundred fifty rupees due")

    private fun initFails(): TtsSpeaker =
        newSpeaker().also {
            it.warmUp()
            lastEngine().answer(TextToSpeech.ERROR)
        }

    private fun noEngine(): TtsSpeaker =
        newSpeaker(factory = { _, _ -> throw IllegalStateException("no engine") }).also { it.warmUp() }

    private fun noLanguage(): TtsSpeaker =
        newSpeaker().also {
            phoneHasVoices(java.util.Locale.JAPAN)
            it.warmUp()
            lastEngine().answer(TextToSpeech.SUCCESS)
        }

    /** Drives a speaker through every call a screen makes and records what can be observed. */
    private fun observe(speaker: Speaker): List<String> {
        val seen = mutableListOf<String>()

        fun record(step: String) {
            seen += "$step muted=${speaker.isMuted.value}"
        }
        record("start")
        speaker.say("रमेश कुमार")
        record("say")
        speaker.say(line)
        record("say line")
        speaker.stop(line)
        speaker.stop()
        record("stop")
        speaker.setMuted(true)
        record("mute")
        speaker.say("रमेश कुमार")
        record("say muted")
        speaker.setMuted(false)
        record("unmute")
        if (speaker is TtsSpeaker) {
            speaker.warmUp()
            speaker.shutdown()
            speaker.say("again")
        }
        record("end")
        return seen
    }

    @Test
    fun `an unavailable TtsSpeaker behaves exactly like NoOpSpeaker`() {
        val expected = observe(NoOpSpeaker())
        for ((name, make) in listOf(
            "init fails" to ::initFails,
            "no engine" to ::noEngine,
            "no language" to ::noLanguage,
        )) {
            val speaker = make()
            assertEquals(name, VoiceStatus.Unavailable, speaker.status.value)
            assertEquals(name, line.hindi, speaker.textFor(line))
            assertEquals(name, expected, observe(speaker))
            assertNull(name, ShadowTextToSpeech.getLastTextToSpeechInstance()?.lastSpoken)
        }
    }

    @Test
    fun `the voice buttons and the host look and act the same as with NoOpSpeaker`() {
        var speaker: Speaker by mutableStateOf(NoOpSpeaker())
        composeRule.setContent {
            key(speaker) {
                CompositionLocalProvider(LocalSpeaker provides speaker) {
                    CableTheme {
                        Column {
                            VoiceHost()
                            SpeakOnShow(line)
                            VoiceToggle(onLabel = "Voice on", offLabel = "Voice off")
                            SpeakButton(text = spokenText(line), label = "Listen")
                        }
                    }
                }
            }
        }

        // The semantics tree without node ids and object hashes, which differ between compositions.
        fun tree(): String =
            composeRule
                .onRoot()
                .printToString()
                .replace(Regex("#\\d+"), "#")
                .replace(Regex("@[0-9a-f]+"), "@")

        fun observeUi(): List<String> {
            val seen = mutableListOf(tree())
            composeRule.onNodeWithText("Voice on").performClick()
            seen += tree() + " muted=${speaker.isMuted.value}"
            composeRule.onNodeWithText("Listen").performClick()
            seen += tree() + " muted=${speaker.isMuted.value}"
            assertEquals(0, composeRule.onAllNodesWithTag(HindiVoicePromptTags.PROMPT).fetchSemanticsNodes().size)
            return seen
        }

        val expected = observeUi()
        for (unavailable in listOf(initFails(), noEngine(), noLanguage())) {
            assertEquals(VoiceStatus.Unavailable, unavailable.status.value)
            // (VoiceHost retries the engine when the screen starts; here it never answers.)
            speaker = unavailable
            composeRule.waitForIdle()
            assertEquals(expected, observeUi())
        }
        assertNull(ShadowTextToSpeech.getLastTextToSpeechInstance()?.lastSpoken)
    }
}

/** The real app (Hilt, MainActivity) keeps working when the phone's TTS fails to start. */
@RunWith(AndroidJUnit4::class)
class AppWithoutTtsTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun `the app shows its screens and stays silent`() {
        composeRule.waitForIdle()
        val engine = lastEngine() // VoiceHost started the engine when the activity started
        engine.answer(TextToSpeech.ERROR)
        composeRule.waitForIdle()
        val speaker = composeRule.activity.speaker as TtsSpeaker
        assertEquals(VoiceStatus.Unavailable, speaker.status.value)
        composeRule.onNodeWithTag("nav_today").performClick()
        composeRule.onNodeWithTag("screen_today").assertExists()
        speaker.say(VoiceLine("नमस्ते", "Hello"))
        assertNull(engine.lastSpoken)
        assertEquals(0, composeRule.onAllNodesWithTag(HindiVoicePromptTags.PROMPT).fetchSemanticsNodes().size)
    }
}
