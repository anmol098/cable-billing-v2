package com.cablebilling.lineman.voice

import android.content.Context
import android.content.Intent
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.LifecycleStartEffect
import com.cablebilling.designsystem.voice.LocalSpeaker
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.locale.AppLanguage

/**
 * Says [line] in the app language, falling back to the other language when the phone has no voice
 * for it ([TtsSpeaker]). Other speakers get the app language's text.
 */
fun Speaker.say(line: VoiceLine) {
    if (this is TtsSpeaker) say(line) else say(line.text(VoiceLanguage.forAppLanguage(AppLanguage.current())))
}

/** Stops [line] if it is still being spoken (or waiting); a later read-out is left alone. */
fun Speaker.stop(line: VoiceLine) {
    if (this is TtsSpeaker) stop(line) else stop()
}

/**
 * Speaks [line] when the screen shows (again whenever [line] changes) and stops it when the screen
 * leaves, so read-outs never pile up across screens (queue flush on navigation). Use it on the
 * Customer / Confirm / Done screens (PLAN §11.3):
 *
 * ```
 * SpeakOnShow(voiceLines.customerDue(customer.name, customer.duePaise))
 * ```
 */
@Composable
fun SpeakOnShow(
    line: VoiceLine?,
    speaker: Speaker = LocalSpeaker.current,
) {
    LaunchedEffect(speaker, line) { line?.let(speaker::say) }
    DisposableEffect(speaker, line) {
        onDispose { line?.let(speaker::stop) }
    }
}

/**
 * The text to hand to `SpeakButton` for [line]: the app language's text, or the other language's
 * if the phone can only speak that one. Recomposes when the voices change.
 */
@Composable
fun spokenText(
    line: VoiceLine,
    speaker: Speaker = LocalSpeaker.current,
): String {
    val tts = speaker as? TtsSpeaker ?: return line.text(VoiceLanguage.forAppLanguage(AppLanguage.current()))
    // Read the status so a change of voices recomposes the caller.
    tts.status.collectAsState().value
    return tts.textFor(line)
}

/**
 * Mount once, inside `CableTheme`, in the activity (MainActivity). Ties the [TtsSpeaker] to the
 * activity lifecycle (start the engine when the app shows, stop speaking when it hides, release
 * the engine when the activity finishes) and shows the one-time Hindi voice prompt. Does nothing
 * for other speakers.
 */
@Composable
fun VoiceHost(speaker: Speaker = LocalSpeaker.current) {
    val tts = speaker as? TtsSpeaker ?: return
    val activity = LocalActivity.current
    LifecycleStartEffect(tts) {
        tts.warmUp()
        onStopOrDispose { tts.stop() }
    }
    DisposableEffect(tts, activity) {
        onDispose {
            if (activity != null && activity.isFinishing && !activity.isChangingConfigurations) tts.shutdown()
        }
    }
    HindiVoicePromptHost(tts)
}

/** Shows [HindiVoicePrompt] once (remembered in DataStore) when the Hindi voice is missing. */
@Composable
private fun HindiVoicePromptHost(tts: TtsSpeaker) {
    val offer by tts.offerHindiVoice.collectAsState(initial = false)
    var showing by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(offer) {
        if (offer) {
            showing = true
            tts.markHindiVoiceOffered()
        }
    }
    if (!showing) return
    val context = LocalContext.current
    HindiVoicePrompt(
        onDownload = {
            showing = false
            tts.hindiVoiceDownloadIntent()?.let { intent -> startQuietly(context, intent) }
        },
        onLater = { showing = false },
    )
}

/** Opens the download screen; if the phone refuses, nothing happens (the prompt never blocks). */
private fun startQuietly(
    context: Context,
    intent: Intent,
) {
    runCatching { context.startActivity(intent) }
}
