package com.cablebilling.lineman.voice

import com.cablebilling.designsystem.voice.NoOpSpeaker
import com.cablebilling.designsystem.voice.Speaker
import dagger.Module
import dagger.Provides
import dagger.hilt.InstallIn
import dagger.hilt.components.SingletonComponent
import javax.inject.Singleton

/**
 * The app's one [Speaker]. Silent ([NoOpSpeaker]) until T-067 provides the TextToSpeech one here.
 * Inject `Speaker` in ViewModels; composables read `LocalSpeaker` (provided by MainActivity).
 */
@Module
@InstallIn(SingletonComponent::class)
object SpeakerModule {
    @Provides
    @Singleton
    fun provideSpeaker(): Speaker = NoOpSpeaker()
}
