package com.cablebilling.lineman.voice

import com.cablebilling.lineman.locale.AppLanguage
import java.util.Locale

/** A language the phone can speak in (D-10). Hindi first; English is the fallback (PLAN §11.3). */
enum class VoiceLanguage(
    /** Text-to-speech locales to try, best first. */
    val voiceLocales: List<Locale>,
    /** Locale for reading this language's strings from the app resources. */
    val resourceLocale: Locale,
) {
    Hindi(
        voiceLocales = listOf(Locale.forLanguageTag("hi-IN")),
        resourceLocale = Locale.forLanguageTag(AppLanguage.HINDI),
    ),
    English(
        // Indian English first: it reads Indian names best.
        voiceLocales = listOf(Locale.forLanguageTag("en-IN"), Locale.US, Locale.UK, Locale.ENGLISH),
        resourceLocale = Locale.forLanguageTag(AppLanguage.ENGLISH),
    ),
    ;

    /** The language to fall back to. */
    val other: VoiceLanguage get() = if (this == Hindi) English else Hindi

    companion object {
        /** The voice language for an app language tag ("hi" / "en"); Hindi unless the app is in English. */
        fun forAppLanguage(language: String): VoiceLanguage = if (language == AppLanguage.ENGLISH) English else Hindi

        /** True if [text] contains Devanagari letters (so only a Hindi voice can read it). */
        fun isDevanagari(text: String): Boolean = text.any { it in DEVANAGARI_FIRST..DEVANAGARI_LAST }

        private const val DEVANAGARI_FIRST = 'ऀ'
        private const val DEVANAGARI_LAST = 'ॿ'
    }
}

/**
 * One read-out in both languages, so the speaker can fall back to English when the phone has no
 * Hindi voice (PLAN §11.3). Build it with [VoiceLines]; speak it with `Speaker.say(line)`.
 */
data class VoiceLine(
    val hindi: String,
    val english: String,
) {
    fun text(language: VoiceLanguage): String =
        when (language) {
            VoiceLanguage.Hindi -> hindi
            VoiceLanguage.English -> english
        }
}
