package com.cablebilling.lineman.voice

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import com.cablebilling.designsystem.voice.Speaker
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.android.qualifiers.ApplicationContext
import dagger.hilt.components.SingletonComponent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import javax.inject.Singleton

/**
 * The app's one [Speaker]: [TtsSpeaker] (T-067), silent like `NoOpSpeaker` when the phone has no
 * text-to-speech. Inject `Speaker` (or `TtsSpeaker` for [VoiceLine]s and the voice status) in
 * ViewModels; composables read `LocalSpeaker` (provided by MainActivity).
 */
@Module
@InstallIn(SingletonComponent::class)
object SpeakerModule {
    @Provides
    @Singleton
    fun provideTtsSpeaker(
        @ApplicationContext context: Context,
        settings: DataStore<Preferences>,
    ): TtsSpeaker =
        TtsSpeaker(
            context = context,
            settings = DataStoreVoiceSettings(settings),
            // App-wide: the speaker lives as long as the process. TextToSpeech calls back on main.
            scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate),
        )

    @Provides
    @Singleton
    fun provideSpeaker(tts: TtsSpeaker): Speaker = tts
}
