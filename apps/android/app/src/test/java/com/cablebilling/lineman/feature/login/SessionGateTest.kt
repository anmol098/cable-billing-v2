package com.cablebilling.lineman.feature.login

import android.content.Intent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.data.auth.Session
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.generated.LoginResponse
import com.cablebilling.lineman.feature.update.PlayStore
import com.cablebilling.lineman.feature.update.UpdateScreen
import com.cablebilling.lineman.feature.update.UpdateTags
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** What the app shows in front of the shell: update screen, login or the app (Hindi UI). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi")
class SessionGateTest {
    @get:Rule
    val composeRule = createComposeRule()

    private val session: Session =
        Fixtures
            .decode(
                LoginResponse.serializer(),
                "login.response.json",
            ).let { Session(it.user, it.operator, it.device) }

    private var updateRequired by mutableStateOf(false)
    private var state: SessionState by mutableStateOf(SessionState.Loading)

    private fun showGate() {
        composeRule.setContent {
            CableTheme {
                SessionGateContent(
                    updateRequired = updateRequired,
                    session = state,
                    updateScreen = { UpdateScreen(onUpdate = {}) },
                    loginScreen = { Box(Modifier.fillMaxSize().testTag(LoginTags.SCREEN)) },
                    content = { Box(Modifier.fillMaxSize().testTag(APP)) },
                )
            }
        }
    }

    @Test
    fun `loading, then login, then the app`() {
        showGate()
        composeRule.onNodeWithTag(SESSION_LOADING_TAG).assertIsDisplayed()

        state = SessionState.SignedOut()
        composeRule.onNodeWithTag(LoginTags.SCREEN).assertIsDisplayed()

        state = SessionState.SignedIn(session)
        composeRule.onNodeWithTag(APP).assertIsDisplayed()
        composeRule.onNodeWithTag(LoginTags.SCREEN).assertDoesNotExist()
    }

    @Test
    fun `the update screen wins over everything`() {
        state = SessionState.SignedIn(session)
        updateRequired = true
        showGate()

        composeRule.onNodeWithTag(UpdateTags.SCREEN).assertIsDisplayed()
        composeRule.onNodeWithTag(APP).assertDoesNotExist()
        composeRule.onNodeWithText("ऐप का नया वर्ज़न चाहिए").assertIsDisplayed()
        composeRule.onNodeWithTag(UpdateTags.BUTTON).assert(hasText("ऐप अपडेट करें"))

        state = SessionState.SignedOut()
        composeRule.onNodeWithTag(UpdateTags.SCREEN).assertIsDisplayed()
        composeRule.onNodeWithTag(LoginTags.SCREEN).assertDoesNotExist()

        // After the update the gate opens by itself.
        updateRequired = false
        composeRule.onNodeWithTag(LoginTags.SCREEN).assertIsDisplayed()
    }

    @Test
    fun `update button calls back and the store intents point at this app`() {
        var clicks = 0
        composeRule.setContent { CableTheme { UpdateScreen(onUpdate = { clicks++ }) } }

        composeRule.onNodeWithTag(UpdateTags.BUTTON).performClick()

        assertEquals(1, clicks)
        val intents = PlayStore.intents("com.cablebilling.lineman")
        assertEquals(Intent.ACTION_VIEW, intents.first().action)
        assertEquals("market://details?id=com.cablebilling.lineman", intents.first().data.toString())
        assertEquals(
            "https://play.google.com/store/apps/details?id=com.cablebilling.lineman",
            intents.last().data.toString(),
        )
    }

    private companion object {
        const val APP = "app_shell"
    }
}
