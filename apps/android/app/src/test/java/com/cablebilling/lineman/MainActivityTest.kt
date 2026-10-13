package com.cablebilling.lineman

import android.os.Build
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.diagnostics.CrashReporting
import com.cablebilling.lineman.feature.login.LoginTags
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * App start on the JVM (Robolectric, the real Hilt application) at minSdk and targetSdk: the app
 * language is set to Hindi and, with nobody signed in yet, the login screen shows in front of the
 * app shell (T-063; the bottom bar itself is covered by CableAppNavigationTest). Not a substitute
 * for the emulator check in T-008's acceptance criteria.
 */
@RunWith(AndroidJUnit4::class)
@Config(sdk = [26, 36])
class MainActivityTest {
    @get:Rule
    val composeRule = createAndroidComposeRule<MainActivity>()

    @Test
    fun `starts in Hindi with the login screen`() {
        assertEquals("hi", AppCompatDelegate.getApplicationLocales().toLanguageTags())
        composeRule.waitUntil(TIMEOUT_MS) {
            composeRule.onAllNodesWithTag(LoginTags.SCREEN).fetchSemanticsNodes().isNotEmpty()
        }
        val signIn = composeRule.onNodeWithTag(LoginTags.SIGN_IN).assertIsDisplayed()
        // Below API 33 AppCompat applies the language itself (recreating the activity), so the
        // Hindi words show here too. On API 33+ the system applies it, which Robolectric's
        // LocaleManager does not emulate; LoginScreenTest covers the Hindi UI there.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) signIn.assert(hasText("लॉग इन करें"))
        composeRule.onNodeWithTag(LoginTags.LOGIN).assertIsDisplayed()
        composeRule.onNodeWithTag(LoginTags.PASSWORD).assertIsDisplayed()
        composeRule.onNodeWithTag("nav_search").assertDoesNotExist()
    }

    @Test
    fun `Sentry stays off without a DSN`() {
        if (BuildConfig.SENTRY_DSN.isBlank()) assertFalse(CrashReporting.isEnabled)
    }

    private companion object {
        const val TIMEOUT_MS = 10_000L
    }
}
