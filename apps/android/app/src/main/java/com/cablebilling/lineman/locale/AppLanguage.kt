package com.cablebilling.lineman.locale

import android.os.Build
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat

/**
 * App language (D-06): Hindi by default, English on request, independent of the phone's language.
 * Uses the per-app language API (AppCompatDelegate.setApplicationLocales): the system setting on
 * API 33+ (offered through res/xml/locales_config.xml), AppCompat's own storage below that.
 */
object AppLanguage {
    const val HINDI = "hi"
    const val ENGLISH = "en"

    /** Same as ANDROID_DEFAULT_LOCALE in packages/i18n/src/locales.ts. */
    const val DEFAULT = HINDI
    val SUPPORTED = listOf(HINDI, ENGLISH)

    /**
     * The language to switch to when the app has [currentTags] (BCP 47, comma-separated, as
     * `LocaleListCompat.toLanguageTags()`), or null to leave it. Only an unset app language changes.
     */
    fun defaultToApply(currentTags: String): String? = if (currentTags.isBlank()) DEFAULT else null

    /**
     * From Application.onCreate: on API 33+ the system holds the app language, so the default can be
     * set before the first activity starts (no recreate). Below API 33 AppCompat loads its stored
     * choice only when an activity is created, so this does nothing there; [applyDefaultIfUnset]
     * in the activity covers it.
     */
    fun applyDefaultAtAppStart() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) applyDefaultIfUnset()
    }

    /**
     * Applies [DEFAULT] if the user never picked a language. Call from an AppCompatActivity's
     * onCreate after super.onCreate(): before that, API < 33 has not loaded the stored choice yet.
     * Returns true if it changed the language (the activity is then recreated in that language).
     */
    fun applyDefaultIfUnset(): Boolean {
        val language = defaultToApply(AppCompatDelegate.getApplicationLocales().toLanguageTags()) ?: return false
        set(language)
        return true
    }

    /** The app language now, e.g. "hi". */
    fun current(): String = AppCompatDelegate.getApplicationLocales()[0]?.language ?: DEFAULT

    /** Switches the app language (settings screen, T-071). Recreates running activities. */
    fun set(language: String) {
        require(language in SUPPORTED) { "Unsupported app language: $language" }
        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(language))
    }
}
