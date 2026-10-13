package com.cablebilling.designsystem.voice

import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Voice read-out (D-10, PLAN §11.3 "Voice" column). Screens call [say] at key moments ("रमेश कुमार,
 * चार सौ पचास रुपये बाकी"); the phrasing is the caller's job.
 *
 * Contract for every implementation:
 * - [say] replaces whatever is being spoken (no queue build-up) and never blocks or throws.
 * - While [isMuted] is `true`, [say] is silent. [setMuted] is remembered by the implementation.
 * - [stop] silences the current speech (call it when leaving a screen).
 *
 * The app binds [NoOpSpeaker] with Hilt until T-067 binds the TextToSpeech one
 * (`com.cablebilling.lineman.voice.SpeakerModule`). In Compose, read it from [LocalSpeaker].
 */
interface Speaker {
    /** Whether read-outs are switched off. Shown by `VoiceToggle` and `SpeakButton`. */
    val isMuted: StateFlow<Boolean>

    fun setMuted(muted: Boolean)

    /** Speaks [text] (already in the app language), replacing anything still being spoken. */
    fun say(text: String)

    fun stop()
}

/** A [Speaker] that never makes a sound but keeps the mute state, so the UI behaves the same. */
class NoOpSpeaker : Speaker {
    private val muted = MutableStateFlow(false)

    override val isMuted: StateFlow<Boolean> = muted.asStateFlow()

    override fun setMuted(muted: Boolean) {
        this.muted.value = muted
    }

    override fun say(text: String) = Unit

    override fun stop() = Unit
}

/**
 * The app's [Speaker] for composables. `MainActivity` provides the Hilt-bound one; previews and
 * tests get a [NoOpSpeaker] unless they provide their own.
 */
val LocalSpeaker = staticCompositionLocalOf<Speaker> { NoOpSpeaker() }
