package com.cablebilling.lineman

import android.os.Build
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.diagnostics.CrashReporting
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * App start on the JVM (Robolectric, the real Hilt application) at minSdk and targetSdk: the app
 * language is set to Hindi and the bottom bar shows. Not a substitute for the emulator check in
 * T-008's acceptance criteria.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [26, 36])
class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun `starts in Hindi with the bottom bar`() {
        assertEquals("hi", AppCompatDelegate.getApplicationLocales().toLanguageTags())
        val searchTab = composeRule.onNodeWithTag("nav_search").assertIsDisplayed()
        // Below API 33 AppCompat applies the language itself (recreating the activity), so the
        // Hindi labels show here too. On API 33+ the system applies it, which Robolectric's
        // LocaleManager does not emulate; CableAppNavigationTest covers the Hindi UI there.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) searchTab.assert(hasText("खोजें"))
        composeRule.onNodeWithTag("nav_today").assertIsDisplayed()
        composeRule.onNodeWithTag("nav_waiting").assertIsDisplayed()
    }

    @Test
    fun `Sentry stays off without a DSN`() {
        if (BuildConfig.SENTRY_DSN.isBlank()) assertFalse(CrashReporting.isEnabled)
    }
}
