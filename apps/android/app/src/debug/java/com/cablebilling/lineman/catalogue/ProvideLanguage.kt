package com.cablebilling.lineman.catalogue

import android.annotation.SuppressLint
import android.content.res.Configuration
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalResources
import com.cablebilling.designsystem.theme.CableTheme
import java.util.Locale

/**
 * Resources, configuration and fonts in [language], without changing the app's language.
 * (Lint's AppBundleLocaleChanges is about Play language splits; this screen is debug-only and both
 * languages ship in every APK.)
 */
@SuppressLint("AppBundleLocaleChanges")
@Composable
internal fun ProvideLanguage(
    language: String,
    content: @Composable () -> Unit,
) {
    val base = LocalContext.current
    val baseConfiguration = LocalConfiguration.current
    val localized =
        remember(base, baseConfiguration, language) {
            val configuration = Configuration(baseConfiguration)
            configuration.setLocale(Locale.forLanguageTag(language))
            base.createConfigurationContext(configuration)
        }
    CompositionLocalProvider(
        LocalContext provides localized,
        LocalConfiguration provides localized.resources.configuration,
        LocalResources provides localized.resources,
    ) {
        CableTheme(language = language, content = content)
    }
}
