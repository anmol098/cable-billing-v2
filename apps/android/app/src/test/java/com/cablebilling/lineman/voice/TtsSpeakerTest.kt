package com.cablebilling.lineman.voice

import android.speech.tts.TextToSpeech
import android.speech.tts.Voice
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowTextToSpeech

@RunWith(AndroidJUnit4::class)
class TtsSpeakerTest {
    private val due =
        VoiceLine(hindi = "रमेश कुमार, चार सौ पचास रुपये बाकी", english = "Ramesh Kumar, four hundred fifty rupees due")
    private val saved = VoiceLine(hindi = "पैसे फ़ोन में सेव हो गए", english = "Money saved on phone")

    @Test
    fun `starts lazily and speaks Hindi in hi-IN, replacing the queue`() {
        phoneHasVoices(HINDI_IN, ENGLISH_IN)
        val speaker = newSpeaker()
        assertEquals(VoiceStatus.Off, speaker.status.value)
        assertNull(ShadowTextToSpeech.getLastTextToSpeechInstance())

        speaker.say(due)
        assertEquals(VoiceStatus.Starting, speaker.status.value)
        val engine = lastEngine()
        assertNull("nothing is spoken before the engine is ready", engine.lastSpoken)

        engine.answer(TextToSpeech.SUCCESS)
        assertEquals(VoiceStatus.Ready(setOf(VoiceLanguage.Hindi, VoiceLanguage.English), false), speaker.status.value)
        assertEquals(due.hindi, engine.lastSpoken)
        assertEquals(HINDI_IN, shadowOf(engine).currentLanguage)
        assertEquals(TextToSpeech.QUEUE_FLUSH, shadowOf(engine).queueMode)

        speaker.say("रसीद नं. R-2610-00045")
        assertEquals("रसीद नं. R-2610-00045", engine.lastSpoken)
    }

    @Test
    fun `only the latest read-out asked for while starting is spoken`() {
        phoneHasVoices(HINDI_IN)
        val speaker = newSpeaker()
        speaker.say(due)
        speaker.say(saved)
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertEquals(listOf(saved.hindi), shadowOf(lastEngine()).spokenTextList)
    }

    @Test
    fun `falls back to English when the Hindi voice is missing`() {
        phoneHasVoices(ENGLISH_IN)
        val speaker = newSpeaker()
        speaker.warmUp()
        val engine = lastEngine()
        engine.answer(TextToSpeech.SUCCESS)
        assertEquals(VoiceStatus.Ready(setOf(VoiceLanguage.English), hindiNeedsDownload = true), speaker.status.value)

        speaker.say(due)
        assertEquals(due.english, engine.lastSpoken)
        assertEquals(ENGLISH_IN, shadowOf(engine).currentLanguage)
        assertEquals(due.english, speaker.textFor(due))

        // Plain Devanagari text cannot be read by an English voice: silent, no crash.
        speaker.say("पैसे सेव हो गए")
        assertEquals(due.english, engine.lastSpoken)
        // Plain Latin text is fine.
        speaker.say(saved.english)
        assertEquals(saved.english, engine.lastSpoken)
    }

    @Test
    fun `English app language speaks English first and Hindi as the fallback`() {
        phoneHasVoices(HINDI_IN, ENGLISH_IN)
        val speaker = newSpeaker(preferred = VoiceLanguage.English)
        speaker.say(due)
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertEquals(due.english, lastEngine().lastSpoken)
        assertEquals(ENGLISH_IN, shadowOf(lastEngine()).currentLanguage)
        assertEquals(due.english, speaker.textFor(due))
    }

    @Test
    fun `US English counts as English when the phone has no Indian English`() {
        phoneHasVoices(java.util.Locale.US)
        val speaker = newSpeaker()
        speaker.say(due)
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertEquals(due.english, lastEngine().lastSpoken)
        assertEquals(java.util.Locale.US, shadowOf(lastEngine()).currentLanguage)
    }

    @Test
    fun `a Hindi voice whose data is not downloaded is used but still offered for download`() {
        phoneHasVoices(HINDI_IN, ENGLISH_IN)
        val speaker = newSpeaker()
        speaker.warmUp()
        val engine = lastEngine()
        engine.voice =
            Voice(
                "hi-in-x-network",
                HINDI_IN,
                Voice.QUALITY_NORMAL,
                Voice.LATENCY_NORMAL,
                true,
                setOf(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED),
            )
        engine.answer(TextToSpeech.SUCCESS)
        val status = speaker.status.value as VoiceStatus.Ready
        assertTrue(status.hindiNeedsDownload)
        speaker.say(due)
        assertEquals(due.hindi, engine.lastSpoken)
    }

    @Test
    fun `init failure makes the speaker silent and releases the engine`() {
        phoneHasVoices(HINDI_IN)
        val speaker = newSpeaker()
        speaker.say(due)
        val engine = lastEngine()
        engine.answer(TextToSpeech.ERROR)
        assertEquals(VoiceStatus.Unavailable, speaker.status.value)
        assertTrue(shadowOf(engine).isShutdown)

        speaker.say(due)
        speaker.say("नमस्ते")
        speaker.stop()
        assertNull(engine.lastSpoken)
        assertSame("no new engine per read-out", engine, ShadowTextToSpeech.getLastTextToSpeechInstance())
    }

    @Test
    fun `an engine that answers inside its constructor is handled`() {
        phoneHasVoices(HINDI_IN)
        val failing =
            newSpeaker(factory = {
                context,
                onInit,
                ->
                TextToSpeech(context, onInit).also { onInit.onInit(TextToSpeech.ERROR) }
            })
        failing.say(due)
        assertEquals(VoiceStatus.Unavailable, failing.status.value)

        val working =
            newSpeaker(factory = {
                context,
                onInit,
                ->
                TextToSpeech(context, onInit).also { onInit.onInit(TextToSpeech.SUCCESS) }
            })
        working.say(due)
        assertEquals(due.hindi, lastEngine().lastSpoken)
    }

    @Test
    fun `no TTS engine at all (the constructor throws) is silent and never throws`() {
        val speaker = newSpeaker(factory = { _, _ -> throw SecurityException("no TTS service") })
        speaker.say(due)
        speaker.say("नमस्ते")
        speaker.warmUp()
        speaker.stop()
        speaker.shutdown()
        speaker.say(due)
        assertEquals(VoiceStatus.Unavailable, speaker.status.value)
    }

    @Test
    fun `an engine with neither language is unavailable`() {
        phoneHasVoices(java.util.Locale.FRANCE)
        val speaker = newSpeaker()
        speaker.say(due)
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertEquals(VoiceStatus.Unavailable, speaker.status.value)
        assertNull(lastEngine().lastSpoken)
        assertTrue(shadowOf(lastEngine()).isShutdown)
    }

    @Test
    fun `muted is silent, and muting stops the current read-out`() {
        phoneHasVoices(HINDI_IN)
        val settings = FakeVoiceSettings()
        val speaker = newSpeaker(settings)
        speaker.say(due)
        val engine = lastEngine()
        engine.answer(TextToSpeech.SUCCESS)
        assertFalse(shadowOf(engine).isStopped)

        speaker.setMuted(true)
        assertTrue(speaker.isMuted.value)
        assertTrue(settings.mutedState.value)
        assertTrue(shadowOf(engine).isStopped)
        speaker.say(saved)
        assertEquals(listOf(due.hindi), shadowOf(engine).spokenTextList)

        speaker.setMuted(false)
        assertFalse(settings.mutedState.value)
        speaker.say(saved)
        assertEquals(saved.hindi, engine.lastSpoken)
    }

    @Test
    fun `a stored mute is loaded before anything is spoken`() {
        phoneHasVoices(HINDI_IN)
        val speaker = newSpeaker(FakeVoiceSettings(muted = true))
        assertTrue(speaker.isMuted.value)
        speaker.say(due)
        speaker.warmUp()
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertNull(lastEngine().lastSpoken)
    }

    @Test
    fun `stop(line) leaves a newer read-out alone`() {
        phoneHasVoices(HINDI_IN)
        val speaker = newSpeaker()
        speaker.say(due)
        val engine = lastEngine()
        engine.answer(TextToSpeech.SUCCESS)

        speaker.say(saved) // the next screen speaks
        speaker.stop(due) // then the previous screen leaves
        assertFalse(shadowOf(engine).isStopped)

        speaker.stop(saved)
        assertTrue(shadowOf(engine).isStopped)
    }

    @Test
    fun `stop drops a read-out still waiting for the engine`() {
        phoneHasVoices(HINDI_IN)
        val speaker = newSpeaker()
        speaker.say(due)
        speaker.stop()
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertNull(lastEngine().lastSpoken)
    }

    @Test
    fun `shutdown releases the engine and the next read-out starts a new one`() {
        phoneHasVoices(HINDI_IN)
        val speaker = newSpeaker()
        speaker.say(due)
        val first = lastEngine()
        first.answer(TextToSpeech.SUCCESS)

        speaker.shutdown()
        assertEquals(VoiceStatus.Off, speaker.status.value)
        assertTrue(shadowOf(first).isShutdown)
        // A late answer from the released engine is ignored.
        first.answer(TextToSpeech.SUCCESS)
        assertEquals(VoiceStatus.Off, speaker.status.value)

        speaker.say(saved)
        val second = lastEngine()
        assertNotSame(first, second)
        second.answer(TextToSpeech.SUCCESS)
        assertEquals(saved.hindi, second.lastSpoken)
    }

    @Test
    fun `warmUp retries after a failure and re-checks a missing Hindi voice`() {
        val speaker = newSpeaker()
        speaker.warmUp()
        lastEngine().answer(TextToSpeech.ERROR)
        assertEquals(VoiceStatus.Unavailable, speaker.status.value)

        phoneHasVoices(ENGLISH_IN)
        speaker.warmUp()
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertEquals(VoiceStatus.Ready(setOf(VoiceLanguage.English), true), speaker.status.value)

        // The lineman downloads the Hindi voice and comes back to the app.
        phoneHasVoices(HINDI_IN)
        val before = lastEngine()
        speaker.warmUp()
        assertNotSame(before, lastEngine())
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertEquals(VoiceStatus.Ready(setOf(VoiceLanguage.Hindi, VoiceLanguage.English), false), speaker.status.value)

        // Nothing to re-check now: warmUp keeps the ready engine.
        val ready = lastEngine()
        speaker.warmUp()
        assertSame(ready, lastEngine())
    }

    @Test
    fun `the Hindi voice is offered once, only in Hindi, only if the phone can download it`() {
        phoneHasVoices(ENGLISH_IN)
        phoneCanDownloadVoices()
        val settings = FakeVoiceSettings()
        val speaker = newSpeaker(settings)
        assertFalse(runBlocking { speaker.offerHindiVoice.first() })

        speaker.warmUp()
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertTrue(runBlocking { speaker.offerHindiVoice.first() })
        assertEquals(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA, speaker.hindiVoiceDownloadIntent()?.action)

        speaker.markHindiVoiceOffered()
        assertTrue(settings.promptShownState.value)
        assertFalse(runBlocking { speaker.offerHindiVoice.first() })

        val english = newSpeaker(FakeVoiceSettings(), preferred = VoiceLanguage.English)
        english.warmUp()
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertFalse(runBlocking { english.offerHindiVoice.first() })
    }

    @Test
    fun `no download screen, no offer`() {
        phoneHasVoices(ENGLISH_IN)
        val speaker = newSpeaker()
        speaker.warmUp()
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertNull(speaker.hindiVoiceDownloadIntent())
        assertFalse(runBlocking { speaker.offerHindiVoice.first() })
    }
}
