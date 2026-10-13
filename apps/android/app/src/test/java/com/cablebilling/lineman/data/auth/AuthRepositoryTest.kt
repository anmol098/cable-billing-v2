package com.cablebilling.lineman.data.auth

import androidx.datastore.preferences.core.edit
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.AppVersionInterceptor
import com.cablebilling.lineman.data.network.Fixtures
import com.cablebilling.lineman.data.network.Routes
import com.cablebilling.lineman.data.network.TestNetwork
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.apiPath
import com.cablebilling.lineman.data.network.bodyText
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.LoginRequest
import com.cablebilling.lineman.data.network.generated.LogoutRequest
import com.cablebilling.lineman.feature.login.LoginMessage
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.Json
import mockwebserver3.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/** Sign in, session storage, install id and sign out, against MockWebServer with the contract fixtures. */
@RunWith(AndroidJUnit4::class)
class AuthRepositoryTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private lateinit var network: TestNetwork
    private var loginAnswer = "login.response.json"
    private val routes =
        Routes { request ->
            when (request.apiPath) {
                "/auth/login" -> Fixtures.response(loginAnswer)
                "/auth/logout" -> Fixtures.response("logout.response.json")
                "/app/config" -> Fixtures.response("getAppConfig.response.json")
                else -> Fixtures.response("error.NOT_FOUND.json")
            }
        }

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
    }

    @Test
    fun `sign in sends the contract request and stores the session`() {
        assertEquals(SessionState.SignedOut(), await { network.auth.restore() })

        val result = await { network.auth.signIn(" 9876501234 ", "example-password") }

        val session = (result as ApiResult.Success).value
        assertEquals("Suresh Yadav", session.user.name)
        assertEquals("K7Q", session.device.deviceCode)
        assertEquals(SessionState.SignedIn(session), network.auth.state.value)
        assertEquals("9800000001", await { network.store.officePhone.first() })

        val request = routes.requestsTo("/auth/login").single()
        assertEquals("1", request.headers[AppVersionInterceptor.HEADER])
        assertEquals(null, request.headers["Authorization"])
        val sent = Json.decodeFromString(LoginRequest.serializer(), request.bodyText)
        val installId = await { network.installId.get() }
        // Same body as the contract's login.request.json, with this install's id and a trimmed login.
        val expected = Fixtures.decode(LoginRequest.serializer(), "login.request.json")
        assertEquals(expected.copy(device = expected.device.copy(installId = installId)), sent)
        UUID.fromString(installId)
    }

    @Test
    fun `the session survives a restart and is sealed on disk`() {
        await { network.auth.signIn("9876501234", "example-password") }
        val installId = await { network.installId.get() }

        network = network.restart()

        val restored = await { network.auth.restore() }
        assertTrue(restored is SessionState.SignedIn)
        assertEquals("example-access-token-1", network.store.tokensBlocking()?.accessToken)
        assertEquals(installId, await { network.installId.get() })
        val onDisk = File(folder.root, "session.preferences_pb").readBytes().decodeToString()
        assertFalse("tokens must be encrypted", onDisk.contains("example-access-token-1"))
        assertFalse("tokens must be encrypted", onDisk.contains("example-refresh-token-1"))
        assertFalse(onDisk.contains("Suresh"))
    }

    @Test
    fun `a session that cannot be decrypted asks for a new sign in`() {
        await { network.auth.signIn("9876501234", "example-password") }
        network.close()
        // A new key (e.g. the Keystore was reset): the stored blob no longer opens.
        network = TestNetwork(server, folder.root, aead = TestNetwork.testAead())

        assertEquals(SessionState.SignedOut(SignOutReason.STORAGE_RESET), await { network.auth.restore() })
        assertEquals(null, network.store.tokensBlocking())
    }

    @Test
    fun `wrong password maps to its message and keeps the phone signed out`() {
        loginAnswer = "error.INVALID_CREDENTIALS.json"
        await { network.auth.restore() }

        val failure = ((await { network.auth.signIn("9876501234", "nope") }) as ApiResult.Failure).failure

        assertEquals(ErrorCode.INVALID_CREDENTIALS, (failure as ApiFailure.Server).knownCode)
        assertEquals(401, failure.httpStatus)
        assertEquals(LoginMessage.WrongPassword, LoginMessage.forFailure(failure))
        assertEquals(SessionState.SignedOut(), network.auth.state.value)
    }

    @Test
    fun `sign-in errors map to plain messages`() {
        val cases =
            mapOf(
                "error.ACCOUNT_DISABLED.json" to LoginMessage.AccountDisabled,
                "error.ROLE_NOT_ALLOWED.json" to LoginMessage.NotLineman,
                "error.RATE_LIMITED.json" to LoginMessage.TooManyTries,
                "error.INTERNAL.json" to LoginMessage.SomethingWentWrong,
            )
        for ((fixture, message) in cases) {
            loginAnswer = fixture
            val failure = ((await { network.auth.signIn("9876501234", "x") }) as ApiResult.Failure).failure
            assertEquals(fixture, message, LoginMessage.forFailure(failure))
        }
        val rateLimited = ApiFailure.Server(429, "RATE_LIMITED", Fixtures.decodeError("error.RATE_LIMITED.json"))
        assertEquals(30L, rateLimited.retryAfterSeconds)
        assertTrue(rateLimited.isTemporary)
        // A code newer than this app is mapped by its HTTP status.
        assertEquals(LoginMessage.AccountDisabled, LoginMessage.forFailure(ApiFailure.Server(403, "NEW_CODE", null)))
    }

    @Test
    fun `no internet is reported as offline`() {
        server.close()
        val failure = ((await { network.auth.signIn("9876501234", "x") }) as ApiResult.Failure).failure
        assertTrue(failure is ApiFailure.Offline)
        assertEquals(LoginMessage.NoInternet, LoginMessage.forFailure(failure))
    }

    @Test
    fun `an app too old at sign in shows the update screen`() {
        loginAnswer = "error.APP_TOO_OLD.json"

        val failure = ((await { network.auth.signIn("9876501234", "x") }) as ApiResult.Failure).failure

        assertEquals(ApiFailure.AppTooOld, failure)
        assertEquals(null, LoginMessage.forFailure(failure))
        assertTrue(network.gate.state.value.updateRequired)
        assertEquals(3L, network.gate.state.value.minimumVersionCode)
        // Remembered: still blocked after a restart without internet.
        network = network.restart()
        await { network.gate.load() }
        assertTrue(network.gate.state.value.updateRequired)
    }

    @Test
    fun `sign out revokes the refresh token and keeps the install id and office phone`() {
        await { network.auth.signIn("9876501234", "example-password") }
        val installId = await { network.installId.get() }

        await { network.auth.signOut() }

        assertEquals(SessionState.SignedOut(SignOutReason.SIGNED_OUT), network.auth.state.value)
        val logout = routes.requestsTo("/auth/logout").single()
        assertEquals(
            LogoutRequest("example-refresh-token-1"),
            Json.decodeFromString(LogoutRequest.serializer(), logout.bodyText),
        )
        assertEquals("1", logout.headers[AppVersionInterceptor.HEADER])
        assertEquals(installId, await { network.installId.get() })
        assertEquals("9800000001", await { network.store.officePhone.first() })

        // Authenticated calls now fail at once, without reaching the server.
        val before = routes.requests.size
        val failure =
            (
                await {
                    apiCall(
                        network.errors,
                    ) { network.mobileApi.getAppConfig() }
                } as ApiResult.Failure
            ).failure
        assertEquals(ApiFailure.SignedOut(SignOutReason.SIGNED_OUT), failure)
        assertEquals(before, routes.requests.size)
    }

    @Test
    fun `install id is made once and kept`() {
        val first = await { network.installId.get() }
        assertEquals(first, network.installId.getBlocking())
        network = network.restart()
        assertEquals(first, await { network.installId.get() })

        // A broken stored value is replaced by a fresh UUID.
        network.close()
        val other = File(folder.root, "other").apply { mkdirs() }
        val fresh = TestNetwork(server, other)
        await { fresh.prefs.edit { it[InstallId.KEY] = "not-a-uuid" } }
        val replaced = await { fresh.installId.get() }
        assertNotEquals("not-a-uuid", replaced)
        UUID.fromString(replaced)
        fresh.close()
        network = TestNetwork(server, folder.root, aead = network.aead)
    }
}

private fun Fixtures.decodeError(name: String) =
    decode(
        com.cablebilling.lineman.data.network.generated.ErrorResponse
            .serializer(),
        name,
    ).error
