package com.cablebilling.lineman.voice

import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.ResolveInfo
import android.speech.tts.TextToSpeech
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowTextToSpeech
import java.util.Locale

val HINDI_IN: Locale = Locale.forLanguageTag("hi-IN")
val ENGLISH_IN: Locale = Locale.forLanguageTag("en-IN")

/** In-memory [VoiceSettings]. */
class FakeVoiceSettings(
    muted: Boolean = false,
    promptShown: Boolean = false,
) : VoiceSettings {
    val mutedState = MutableStateFlow(muted)
    val promptShownState = MutableStateFlow(promptShown)

    override val muted: Flow<Boolean> = mutedState

    override suspend fun setMuted(muted: Boolean) {
        mutedState.value = muted
    }

    override val hindiVoicePromptShown: Flow<Boolean> = promptShownState

    override suspend fun markHindiVoicePromptShown() {
        promptShownState.value = true
    }
}

/** A [TtsSpeaker] on the Robolectric app, with coroutines run in place (in-memory settings) by default. */
fun newSpeaker(
    settings: VoiceSettings = FakeVoiceSettings(),
    preferred: VoiceLanguage = VoiceLanguage.Hindi,
    factory: TtsEngineFactory = TtsEngineFactory { context, onInit -> TextToSpeech(context, onInit) },
    scope: CoroutineScope = CoroutineScope(Dispatchers.Unconfined),
): TtsSpeaker =
    TtsSpeaker(
        context = RuntimeEnvironment.getApplication(),
        settings = settings,
        scope = scope,
        preferredLanguage = { preferred },
        engineFactory = factory,
    )

/** The phone's engine speaks these voices (Robolectric's TextToSpeech). */
fun phoneHasVoices(vararg locales: Locale) = locales.forEach(ShadowTextToSpeech::addLanguageAvailability)

/** The TextToSpeech the speaker created last. */
fun lastEngine(): TextToSpeech = checkNotNull(ShadowTextToSpeech.getLastTextToSpeechInstance()) { "no engine created" }

/** The engine finishes starting with [result] (TextToSpeech.SUCCESS / ERROR). */
fun TextToSpeech.answer(result: Int) = shadowOf(this).onInitListener.onInit(result)

val TextToSpeech.lastSpoken: String? get() = shadowOf(this).lastSpokenText

/** The phone has a "download voice data" screen. */
fun phoneCanDownloadVoices() {
    val info =
        ResolveInfo().apply {
            activityInfo =
                ActivityInfo().apply {
                    packageName = "com.example.tts"
                    name = "com.example.tts.DownloadVoices"
                }
        }
    shadowOf(RuntimeEnvironment.getApplication().packageManager)
        .addResolveInfoForIntent(Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA), info)
}
