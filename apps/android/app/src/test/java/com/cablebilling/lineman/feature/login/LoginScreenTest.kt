package com.cablebilling.lineman.feature.login

import android.content.Intent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.AnnotatedString
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.designsystem.theme.CableSizes
import com.cablebilling.designsystem.theme.CableTheme
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.LoginRequest
import kotlinx.serialization.json.Json
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The login screen in Hindi (Compose UI on Robolectric), first on its own, then with its
 * ViewModel and the real auth stack against MockWebServer answering with the contract fixtures.
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = "hi")
class LoginScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private lateinit var network: TestNetwork

    @Volatile
    private var loginAnswer = "login.response.json"

    @Volatile
    private var refreshAnswer = "refreshTokens.response.json"

    private val routes =
        Routes { request ->
            when (request.apiPath) {
                "/auth/login" -> Fixtures.response(loginAnswer)
                "/auth/refresh" -> Fixtures.response(refreshAnswer)
                "/app/config" -> Fixtures.response("error.UNAUTHENTICATED.json")
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.auth.restore() }
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
    }

    /** The screen with plain state, wired like the ViewModel does it. */
    private fun showStatelessScreen(initial: LoginUiState = LoginUiState()) {
        composeRule.setContent {
            var state by remember { mutableStateOf(initial) }
            CableTheme {
                LoginScreen(
                    state = state,
                    onLoginChange = { state = state.copy(login = it) },
                    onPasswordChange = { state = state.copy(password = it) },
                    onToggleLoginKeyboard = { state = state.copy(loginKeyboard = state.loginKeyboard.toggled()) },
                    onTogglePasswordKeyboard = {
                        state =
                            state.copy(
                                passwordKeyboard = state.passwordKeyboard.toggled(),
                            )
                    },
                    onTogglePasswordVisible = { state = state.copy(passwordVisible = !state.passwordVisible) },
                    onSignIn = {},
                    onCallOffice = {},
                )
            }
        }
    }

    private fun showRealScreen(): LoginViewModel {
        val viewModel = LoginViewModel(network.auth, network.store)
        composeRule.setContent { CableTheme { LoginRoute(viewModel) } }
        return viewModel
    }

    /** What the field shows (EditableText is the transformed text: bullets when hidden). */
    private fun shows(text: String) =
        SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString(text))

    /** Waits for [condition], letting the main looper (ViewModel coroutines) run between checks. */
    private fun waitFor(condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + TIMEOUT_MS
        while (true) {
            composeRule.waitForIdle()
            if (condition()) return
            check(System.currentTimeMillis() < deadline) { "condition not met in $TIMEOUT_MS ms" }
            Thread.sleep(POLL_MS)
        }
    }

    @Test
    fun `shows the Hindi words, with show password on by default`() {
        showStatelessScreen()

        composeRule.onNodeWithText("लॉग इन").assertIsDisplayed()
        composeRule.onNodeWithText("मोबाइल नंबर या यूज़र नेम").assertIsDisplayed()
        composeRule.onNodeWithText("पासवर्ड").assertIsDisplayed()
        composeRule.onNodeWithTag(LoginTags.SIGN_IN).assert(hasText("लॉग इन करें"))
        composeRule.onNodeWithTag(LoginTags.CALL_OFFICE).performScrollTo().assert(hasText("ऑफिस को फ़ोन करें"))

        composeRule.onNodeWithTag(LoginTags.PASSWORD).performTextInput("abc123")
        composeRule.onNodeWithTag(LoginTags.PASSWORD).assert(shows("abc123"))
        composeRule.onNodeWithTag(LoginTags.SHOW_PASSWORD).assert(hasText("छिपाएँ")).performClick()
        composeRule.onNodeWithTag(LoginTags.PASSWORD).assert(shows("••••••"))
        composeRule.onNodeWithTag(LoginTags.SHOW_PASSWORD).assert(hasText("दिखाएँ")).performClick()
        composeRule.onNodeWithTag(LoginTags.PASSWORD).assert(shows("abc123"))
    }

    @Test
    fun `123 and ABC switch each field's keyboard`() {
        showStatelessScreen()

        // Login starts on digits (the toggle offers letters), password on letters.
        composeRule.onNodeWithTag(LoginTags.LOGIN_KEYBOARD).assert(hasText("ABC"))
        composeRule.onNodeWithTag(LoginTags.PASSWORD_KEYBOARD).assert(hasText("123"))
        composeRule.onNodeWithTag(LoginTags.LOGIN_KEYBOARD).performClick().assert(hasText("123"))
        composeRule.onNodeWithTag(LoginTags.LOGIN_KEYBOARD).performClick().assert(hasText("ABC"))
        composeRule.onNodeWithTag(LoginTags.PASSWORD_KEYBOARD).performClick().assert(hasText("ABC"))
        composeRule
            .onNodeWithTag(LoginTags.PASSWORD_KEYBOARD)
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("अक्षर वाला कीबोर्ड")))
    }

    @Test
    fun `sign in is enabled only with a login and a password`() {
        showStatelessScreen()

        composeRule.onNodeWithTag(LoginTags.SIGN_IN).assertIsNotEnabled()
        composeRule.onNodeWithTag(LoginTags.LOGIN).performTextInput("9876501234")
        composeRule.onNodeWithTag(LoginTags.SIGN_IN).assertIsNotEnabled()
        composeRule.onNodeWithTag(LoginTags.PASSWORD).performTextInput("x")
        composeRule.onNodeWithTag(LoginTags.SIGN_IN).assertIsEnabled()
    }

    @Test
    fun `every tappable thing is at least the minimum touch size`() {
        showStatelessScreen(LoginUiState(login = "9876501234", password = "x"))

        val tappable =
            composeRule
                .onAllNodes(
                    SemanticsMatcher.keyIsDefined(SemanticsActions.OnClick),
                ).fetchSemanticsNodes()
        assertTrue(tappable.size >= MIN_TAPPABLE)
        for (node in tappable) {
            val size = with(composeRule.density) { node.size.width.toDp() to node.size.height.toDp() }
            assertTrue(
                "$size too small: ${node.config}",
                size.first >= CableSizes.TouchMin && size.second >= CableSizes.TouchMin,
            )
        }
        val signIn = composeRule.onNodeWithTag(LoginTags.SIGN_IN).getUnclippedBoundsInRoot()
        assertTrue(signIn.bottom - signIn.top >= CableSizes.PrimaryButton)
    }

    @Test
    fun `signing in with the real stack opens the session`() {
        showRealScreen()

        composeRule.onNodeWithTag(LoginTags.LOGIN).performTextInput("9876501234")
        composeRule.onNodeWithTag(LoginTags.PASSWORD).performTextInput("example-password")
        composeRule.onNodeWithTag(LoginTags.SIGN_IN).assertHasClickAction().performClick()

        waitFor { network.auth.state.value is SessionState.SignedIn }
        val sent = Json.decodeFromString(LoginRequest.serializer(), routes.requestsTo("/auth/login").single().bodyText)
        assertEquals("9876501234", sent.login)
        assertEquals("example-password", sent.password)
        assertEquals(
            "Suresh Yadav",
            network.store.session
                ?.user
                ?.name,
        )
    }

    @Test
    fun `a wrong password shows the message in Hindi`() {
        loginAnswer = "error.INVALID_CREDENTIALS.json"
        showRealScreen()

        composeRule.onNodeWithTag(LoginTags.LOGIN).performTextInput("9876501234")
        composeRule.onNodeWithTag(LoginTags.PASSWORD).performTextInput("wrong")
        composeRule.onNodeWithTag(LoginTags.SIGN_IN).performClick()

        composeRule.waitUntil(TIMEOUT_MS) {
            composeRule.onAllNodes(hasText("यूज़र नेम या पासवर्ड गलत है।")).fetchSemanticsNodes().isNotEmpty()
        }
        composeRule.onNodeWithTag(LoginTags.MESSAGE).assertIsDisplayed()
        composeRule.onNodeWithTag(LoginTags.SIGN_IN).assertIsEnabled()
        assertTrue(network.auth.state.value is SessionState.SignedOut)
    }

    @Test
    fun `a phone signed out by the owner says so on the login screen`() {
        await { network.auth.signIn("9876501234", "example-password") }
        showRealScreen()
        refreshAnswer = "error.DEVICE_REVOKED.json"

        await { apiCall(network.errors) { network.mobileApi.getAppConfig() } }

        assertEquals(SessionState.SignedOut(SignOutReason.PHONE_SIGNED_OUT), network.auth.state.value)
        composeRule.waitUntil(TIMEOUT_MS) {
            composeRule
                .onAllNodes(
                    hasText("ऑफिस ने इस फ़ोन से लॉग आउट कर दिया है।", substring = true),
                ).fetchSemanticsNodes()
                .isNotEmpty()
        }
    }

    @Test
    fun `call office dials the operator's number`() {
        // The number comes from the last sign-in and survives sign-out.
        await { network.auth.signIn("9876501234", "example-password") }
        await { network.auth.signOut() }
        val viewModel = showRealScreen()
        waitFor { viewModel.state.value.officePhone != null }

        composeRule.onNodeWithTag(LoginTags.CALL_OFFICE).performScrollTo().performClick()

        val started = shadowOf(RuntimeEnvironment.getApplication()).nextStartedActivity
        assertEquals(Intent.ACTION_DIAL, started.action)
        assertEquals("tel:9800000001", started.data.toString())
        // Never signed in: an empty dialer.
        assertEquals(null, OfficeDialer.intent(null).data)
    }

    private companion object {
        const val TIMEOUT_MS = 10_000L
        const val POLL_MS = 20L
        const val MIN_TAPPABLE = 5
    }
}
