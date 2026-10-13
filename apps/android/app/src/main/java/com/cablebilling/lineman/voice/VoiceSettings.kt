package com.cablebilling.lineman.voice

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import java.io.IOException

/** What the voice remembers between app starts. */
interface VoiceSettings {
    /** Voice switched off by the lineman (`VoiceToggle`). */
    val muted: Flow<Boolean>

    suspend fun setMuted(muted: Boolean)

    /** The one-time "download the Hindi voice" prompt was already shown. */
    val hindiVoicePromptShown: Flow<Boolean>

    suspend fun markHindiVoicePromptShown()
}

/** [VoiceSettings] in the app's `settings` DataStore (StorageModule). A read error counts as "not set". */
class DataStoreVoiceSettings(
    private val store: DataStore<Preferences>,
) : VoiceSettings {
    private val preferences: Flow<Preferences> =
        store.data.catch { error -> if (error is IOException) emit(emptyPreferences()) else throw error }

    override val muted: Flow<Boolean> = preferences.map { it[MUTED] ?: false }.distinctUntilChanged()

    override suspend fun setMuted(muted: Boolean) {
        store.edit { it[MUTED] = muted }
    }

    override val hindiVoicePromptShown: Flow<Boolean> =
        preferences.map { it[HINDI_PROMPT_SHOWN] ?: false }.distinctUntilChanged()

    override suspend fun markHindiVoicePromptShown() {
        store.edit { it[HINDI_PROMPT_SHOWN] = true }
    }

    companion object {
        val MUTED = booleanPreferencesKey("voice_muted")
        val HINDI_PROMPT_SHOWN = booleanPreferencesKey("voice_hindi_prompt_shown")
    }
}
