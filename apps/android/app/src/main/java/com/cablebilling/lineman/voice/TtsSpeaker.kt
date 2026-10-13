package com.cablebilling.lineman.voice

import android.content.Context
import android.content.Intent
import android.speech.tts.TextToSpeech
import com.cablebilling.designsystem.voice.NoOpSpeaker
import com.cablebilling.designsystem.voice.Speaker
import com.cablebilling.lineman.locale.AppLanguage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import java.util.Locale

/** What the phone's text-to-speech can do right now ([TtsSpeaker.status]). */
sealed interface VoiceStatus {
    /** Not started yet, or shut down. The next read-out (or [TtsSpeaker.warmUp]) starts it. */
    data object Off : VoiceStatus

    /** Waiting for the engine to answer. A read-out asked for now is spoken when it is ready. */
    data object Starting : VoiceStatus

    /**
     * Speaking works in [languages]. [hindiNeedsDownload] is true when the Hindi voice is missing
     * (the speaker then falls back to English) or its data is not downloaded yet.
     */
    data class Ready(
        val languages: Set<VoiceLanguage>,
        val hindiNeedsDownload: Boolean,
    ) : VoiceStatus

    /**
     * No engine, it failed to start, or it speaks neither language. The speaker is then silent and
     * behaves exactly like [NoOpSpeaker] (T-067 acceptance). [TtsSpeaker.warmUp] tries again.
     */
    data object Unavailable : VoiceStatus
}

/** Creates the Android engine; tests swap it to simulate a phone without TTS. */
fun interface TtsEngineFactory {
    fun create(
        context: Context,
        onInit: TextToSpeech.OnInitListener,
    ): TextToSpeech
}

/**
 * The app's [Speaker] (D-10, PLAN §11.3): Android `TextToSpeech` in Hindi (hi-IN), English when the
 * phone has no Hindi voice, mute remembered in DataStore.
 *
 * - [say] replaces whatever is being spoken (`QUEUE_FLUSH`), never blocks and never throws. While
 *   the engine starts, the latest read-out waits and is spoken once it is ready.
 * - [say] with a [VoiceLine] speaks the app language's text if that voice exists, else the other
 *   one (Hindi → English fallback). Plain Devanagari text needs the Hindi voice (else it is
 *   silent); plain Latin text uses any voice.
 * - The engine starts lazily (first read-out or [warmUp]) and is released by [shutdown];
 *   [VoiceHost] ties both to the activity lifecycle.
 * - Missing or broken TTS: [status] becomes [VoiceStatus.Unavailable] and everything behaves
 *   like [NoOpSpeaker] (mute still works and is remembered).
 *
 * Thread-safe (one lock); TextToSpeech calls back on the main thread.
 */
@Suppress("TooManyFunctions") // One engine behind one lock: the small state machine stays in one class.
class TtsSpeaker(
    context: Context,
    private val settings: VoiceSettings,
    private val scope: CoroutineScope,
    private val preferredLanguage: () -> VoiceLanguage = { VoiceLanguage.forAppLanguage(AppLanguage.current()) },
    private val engineFactory: TtsEngineFactory = TtsEngineFactory { ctx, onInit -> TextToSpeech(ctx, onInit) },
) : Speaker {
    private val appContext: Context = context.applicationContext ?: context
    private val lock = Any()
    private val muted = MutableStateFlow(false)
    private val mutableStatus = MutableStateFlow<VoiceStatus>(VoiceStatus.Off)

    // Everything below is guarded by `lock`.
    private var engine: TextToSpeech? = null
    private var generation = 0
    private val locales = mutableMapOf<VoiceLanguage, Locale>()
    private var engineLanguage: VoiceLanguage? = null
    private var pending: Utterance? = null
    private var current: Utterance? = null
    private var mutedLoaded = false
    private var mutedChangedHere = false
    private var utteranceCount = 0L

    override val isMuted: StateFlow<Boolean> = muted.asStateFlow()

    val status: StateFlow<VoiceStatus> = mutableStatus.asStateFlow()

    /**
     * True while the one-time "download the Hindi voice" prompt should show: the app is in Hindi,
     * the Hindi voice is missing, the phone has a screen to download it, and the prompt was never
     * shown before. Call [markHindiVoiceOffered] once it shows.
     */
    val offerHindiVoice: Flow<Boolean> =
        combine(mutableStatus, settings.hindiVoicePromptShown) { status, shown ->
            !shown &&
                status is VoiceStatus.Ready &&
                status.hindiNeedsDownload &&
                preferredLanguage() == VoiceLanguage.Hindi &&
                hindiVoiceDownloadIntent() != null
        }.distinctUntilChanged()

    init {
        scope.launch { settings.muted.collect(::onStoredMuted) }
    }

    override fun setMuted(muted: Boolean) {
        synchronized(lock) {
            mutedChangedHere = true
            mutedLoaded = true
            this.muted.value = muted
            if (muted) silenceLocked()
        }
        scope.launch { runCatching { settings.setMuted(muted) } }
    }

    override fun say(text: String) = speak(Utterance.Plain(text))

    /** Says [line] in the app language, or in the other language if the phone has no voice for it. */
    fun say(line: VoiceLine) = speak(Utterance.Bilingual(line))

    override fun stop() {
        synchronized(lock) { silenceLocked() }
    }

    /**
     * Stops only if [line] is still the latest read-out, so a screen that leaves does not cut off
     * the next screen's read-out (see `SpeakOnShow`).
     */
    fun stop(line: VoiceLine) {
        synchronized(lock) {
            val utterance = Utterance.Bilingual(line)
            if (pending == utterance || current == utterance) silenceLocked()
        }
    }

    /**
     * The text [say] would speak for [line] right now (for `SpeakButton`, which takes plain text).
     * Before the engine is ready this is the app language's text.
     */
    fun textFor(line: VoiceLine): String {
        val status = mutableStatus.value
        val preferred = preferredLanguage()
        val language =
            (status as? VoiceStatus.Ready)?.let { Utterance.Bilingual(line).languageIn(it.languages, preferred) }
                ?: preferred
        return line.text(language)
    }

    /**
     * Starts the engine if it is off, retries if it was unavailable, and re-checks the voices if
     * Hindi was missing (the lineman may have just downloaded it). Called when the app comes to
     * the front.
     */
    fun warmUp() {
        synchronized(lock) {
            when (val status = mutableStatus.value) {
                VoiceStatus.Off, VoiceStatus.Unavailable -> {
                    startLocked()
                }

                is VoiceStatus.Ready -> {
                    if (status.hindiNeedsDownload) {
                        releaseLocked()
                        startLocked()
                    }
                }

                VoiceStatus.Starting -> {
                    Unit
                }
            }
        }
    }

    /** Releases the engine (the app is closing). The next read-out starts it again. */
    fun shutdown() {
        synchronized(lock) {
            releaseLocked()
            mutableStatus.value = VoiceStatus.Off
        }
    }

    /**
     * The system screen that downloads voice data, aimed at the phone's TTS engine, or null if the
     * phone has no such screen.
     */
    fun hindiVoiceDownloadIntent(): Intent? {
        val enginePackage = synchronized(lock) { runCatching { engine?.defaultEngine }.getOrNull() }
        val intent = Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA)
        if (!enginePackage.isNullOrBlank()) intent.setPackage(enginePackage)
        return intent.takeIf { runCatching { it.resolveActivity(appContext.packageManager) }.getOrNull() != null }
    }

    /** Remembers that the Hindi voice prompt was shown, so it never shows again. */
    fun markHindiVoiceOffered() {
        scope.launch { runCatching { settings.markHindiVoicePromptShown() } }
    }

    private fun onStoredMuted(stored: Boolean) {
        synchronized(lock) {
            if (!mutedChangedHere) muted.value = stored
            mutedLoaded = true
            if (muted.value) pending = null else flushPendingLocked()
        }
    }

    private fun speak(utterance: Utterance) {
        synchronized(lock) {
            if (muted.value) return
            when (val status = mutableStatus.value) {
                is VoiceStatus.Ready -> {
                    if (mutedLoaded) speakLocked(status, utterance) else pending = utterance
                }

                VoiceStatus.Starting -> {
                    pending = utterance
                }

                VoiceStatus.Off -> {
                    pending = utterance
                    startLocked()
                }

                VoiceStatus.Unavailable -> {
                    Unit
                }
            }
        }
    }

    private fun startLocked() {
        val startedGeneration = ++generation
        mutableStatus.value = VoiceStatus.Starting
        var created: TextToSpeech? = null
        var earlyResult: Int? = null
        // Some engines answer inside the TextToSpeech constructor (e.g. none installed): keep the
        // result until the instance exists.
        val onInit =
            TextToSpeech.OnInitListener { result ->
                synchronized(lock) {
                    val tts = created
                    if (tts == null) earlyResult = result else onInitLocked(startedGeneration, tts, result)
                }
            }
        created = runCatching { engineFactory.create(appContext, onInit) }.getOrNull()
        val tts = created
        if (tts == null) {
            becomeUnavailableLocked()
        } else {
            engine = tts
            earlyResult?.let { onInitLocked(startedGeneration, tts, it) }
        }
    }

    private fun onInitLocked(
        startedGeneration: Int,
        tts: TextToSpeech,
        result: Int,
    ) {
        // An engine released before it answered: ignore its late answer.
        if (startedGeneration != generation || engine !== tts) return
        val ready = if (result == TextToSpeech.SUCCESS) runCatching { probeLocked(tts) }.getOrNull() else null
        if (ready == null || ready.languages.isEmpty()) {
            becomeUnavailableLocked()
        } else {
            mutableStatus.value = ready
            flushPendingLocked()
        }
    }

    private fun probeLocked(tts: TextToSpeech): VoiceStatus.Ready {
        locales.clear()
        engineLanguage = null
        for (language in VoiceLanguage.entries) {
            // An exact country match (en-US voice for Locale.US) beats a language-only one.
            val results = language.voiceLocales.associateWith { tts.isLanguageAvailable(it) }
            (
                results.entries.firstOrNull { it.value >= TextToSpeech.LANG_COUNTRY_AVAILABLE }
                    ?: results.entries.firstOrNull { it.value >= TextToSpeech.LANG_AVAILABLE }
            )?.let { locales[language] = it.key }
        }
        val hindiNeedsDownload = hindiNeedsDownloadLocked(tts)
        return VoiceStatus.Ready(languages = locales.keys.toSet(), hindiNeedsDownload = hindiNeedsDownload)
    }

    /** Selects the Hindi voice; true if it is missing or its data still has to be downloaded. */
    private fun hindiNeedsDownloadLocked(tts: TextToSpeech): Boolean {
        val locale = locales[VoiceLanguage.Hindi]
        if (locale == null || tts.setLanguage(locale) < TextToSpeech.LANG_AVAILABLE) {
            locales.remove(VoiceLanguage.Hindi)
            return true
        }
        engineLanguage = VoiceLanguage.Hindi
        val features = runCatching { tts.voice?.features }.getOrNull().orEmpty()
        return TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED in features
    }

    private fun speakLocked(
        ready: VoiceStatus.Ready,
        utterance: Utterance,
    ) {
        val tts = engine ?: return
        val language = utterance.languageIn(ready.languages, preferredLanguage())
        val spoken =
            language != null &&
                runCatching {
                    useLanguageLocked(tts, language) &&
                        tts.speak(utterance.text(language), TextToSpeech.QUEUE_FLUSH, null, nextUtteranceId()) ==
                        TextToSpeech.SUCCESS
                }.getOrDefault(false)
        current = if (spoken) utterance else null
    }

    private fun useLanguageLocked(
        tts: TextToSpeech,
        language: VoiceLanguage,
    ): Boolean {
        if (engineLanguage != language) {
            val locale = locales[language]
            val selected = locale != null && tts.setLanguage(locale) >= TextToSpeech.LANG_AVAILABLE
            engineLanguage = if (selected) language else null
        }
        return engineLanguage == language
    }

    private fun nextUtteranceId(): String = "cb-voice-${++utteranceCount}"

    private fun flushPendingLocked() {
        val ready = mutableStatus.value as? VoiceStatus.Ready
        val utterance = pending
        if (ready != null && mutedLoaded && utterance != null) {
            pending = null
            if (!muted.value) speakLocked(ready, utterance)
        }
    }

    private fun silenceLocked() {
        pending = null
        current = null
        if (mutableStatus.value is VoiceStatus.Ready) runCatching { engine?.stop() }
    }

    private fun becomeUnavailableLocked() {
        releaseLocked()
        mutableStatus.value = VoiceStatus.Unavailable
    }

    private fun releaseLocked() {
        generation++
        val tts = engine
        engine = null
        locales.clear()
        engineLanguage = null
        pending = null
        current = null
        tts?.let {
            runCatching { it.stop() }
            runCatching { it.shutdown() }
        }
    }

    /** A read-out: plain text, or a [VoiceLine] in both languages. */
    private sealed interface Utterance {
        fun text(language: VoiceLanguage): String

        /** The voice to use among [available] ([preferred] first), or null if none can say it. */
        fun languageIn(
            available: Set<VoiceLanguage>,
            preferred: VoiceLanguage,
        ): VoiceLanguage?

        data class Plain(
            val value: String,
        ) : Utterance {
            override fun text(language: VoiceLanguage): String = value

            // An English voice cannot read Devanagari, so Hindi text has no fallback.
            override fun languageIn(
                available: Set<VoiceLanguage>,
                preferred: VoiceLanguage,
            ): VoiceLanguage? =
                if (VoiceLanguage.isDevanagari(value)) {
                    VoiceLanguage.Hindi.takeIf { it in available }
                } else {
                    pickVoice(available, preferred)
                }
        }

        data class Bilingual(
            val line: VoiceLine,
        ) : Utterance {
            override fun text(language: VoiceLanguage): String = line.text(language)

            override fun languageIn(
                available: Set<VoiceLanguage>,
                preferred: VoiceLanguage,
            ): VoiceLanguage? = pickVoice(available, preferred)
        }
    }
}

/** [preferred] if the phone can speak it, else the other language, else null. */
private fun pickVoice(
    available: Set<VoiceLanguage>,
    preferred: VoiceLanguage,
): VoiceLanguage? =
    when {
        preferred in available -> preferred
        preferred.other in available -> preferred.other
        else -> null
    }
