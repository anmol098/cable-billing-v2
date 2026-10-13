package com.cablebilling.lineman.voice

import android.speech.tts.TextToSpeech
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File

/**
 * Mute and the one-time prompt survive an app restart. A restart is modelled the way it happens:
 * the DataStore is closed and a new one reads the same file, with a new speaker on top.
 */
@RunWith(AndroidJUnit4::class)
class VoicePersistenceTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val file by lazy { File(folder.root, "settings.preferences_pb") }
    private val scopes = mutableListOf<CoroutineScope>()

    @After
    fun tearDown() = scopes.forEach { it.cancel() }

    private fun <T> await(block: suspend () -> T): T =
        runBlocking(Dispatchers.IO) { withTimeout(TIMEOUT_MS) { block() } }

    /** An app start: a DataStore on the settings file, its settings, and a speaker. */
    private inner class AppStart {
        private val storeScope = CoroutineScope(SupervisorJob() + Dispatchers.IO).also(scopes::add)
        val store: DataStore<Preferences> = PreferenceDataStoreFactory.create(scope = storeScope) { file }
        val settings = RecordingSettings(DataStoreVoiceSettings(store))
        val speaker =
            newSpeaker(settings, scope = CoroutineScope(SupervisorJob() + Dispatchers.Default).also(scopes::add))

        /** The process ends: waits for the speaker's writes, then closes the DataStore. */
        fun end(expectedWrites: Int) {
            await { repeat(expectedWrites) { settings.writes.receive() } }
            await { storeScope.coroutineContext.job.cancelAndJoin() }
        }
    }

    @Test
    fun `mute is remembered across app starts`() {
        val first = AppStart()
        await { first.speaker.isMuted.first { !it } }
        first.speaker.setMuted(true)
        first.end(expectedWrites = 1)

        phoneHasVoices(HINDI_IN)
        val second = AppStart()
        await { second.speaker.isMuted.first { it } }
        second.speaker.say(VoiceLine("नमस्ते", "Hello"))
        second.speaker.warmUp()
        lastEngine().answer(TextToSpeech.SUCCESS)
        assertNull("muted after restart: silent", lastEngine().lastSpoken)
        second.speaker.setMuted(false)
        second.end(expectedWrites = 1)

        val third = AppStart()
        await { third.speaker.isMuted.first { !it } }
        assertFalse(third.speaker.isMuted.value)
    }

    @Test
    fun `the Hindi voice prompt is remembered`() {
        val first = AppStart()
        assertEquals(false, await { first.settings.hindiVoicePromptShown.first() })
        first.speaker.markHindiVoiceOffered()
        first.end(expectedWrites = 1)

        val second = AppStart()
        assertTrue(await { second.settings.hindiVoicePromptShown.first() })
    }

    /** Signals each completed write, so a test can wait for the speaker's background writes. */
    private class RecordingSettings(
        private val delegate: VoiceSettings,
    ) : VoiceSettings {
        val writes = Channel<Unit>(Channel.UNLIMITED)

        override val muted: Flow<Boolean> = delegate.muted

        override suspend fun setMuted(muted: Boolean) {
            delegate.setMuted(muted)
            writes.send(Unit)
        }

        override val hindiVoicePromptShown: Flow<Boolean> = delegate.hindiVoicePromptShown

        override suspend fun markHindiVoicePromptShown() {
            delegate.markHindiVoicePromptShown()
            writes.send(Unit)
        }
    }

    private companion object {
        const val TIMEOUT_MS = 10_000L
    }
}
