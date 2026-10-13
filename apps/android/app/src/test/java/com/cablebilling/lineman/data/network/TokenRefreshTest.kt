package com.cablebilling.lineman.data.network

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.network.TestNetwork.Companion.await
import com.cablebilling.lineman.data.network.generated.RefreshRequest
import com.cablebilling.lineman.data.network.generated.TenantMode
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.Json
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import mockwebserver3.SocketEffect
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The authenticated client against MockWebServer: bearer token, 401 → one refresh → one retry,
 * single-flight refresh under concurrent 401s, session end on refused refresh, APP_TOO_OLD, and
 * the version header on every request. Bodies are the contract fixtures: login gives
 * `example-access-token-1`, refresh gives `example-access-token-2`.
 */
@RunWith(AndroidJUnit4::class)
class TokenRefreshTest {
    @get:Rule
    val folder = TemporaryFolder()

    private val server = MockWebServer()
    private lateinit var network: TestNetwork

    /** What /auth/refresh answers (a fixture name), or null to drop the connection. */
    @Volatile
    private var refreshAnswer: String? = "refreshTokens.response.json"

    /** What /app/config answers. */
    @Volatile
    private var configAnswer = "getAppConfig.response.json"

    /** Access tokens the API accepts. */
    @Volatile
    private var validTokens = setOf("example-access-token-2")

    /** Holds every 401 until this many requests have arrived, so they really race. */
    @Volatile
    private var unauthenticatedGate: CountDownLatch? = null

    private val refreshCalls = AtomicInteger()

    private val routes =
        Routes { request ->
            when (request.apiPath) {
                "/auth/login" -> {
                    Fixtures.response("login.response.json")
                }

                "/auth/refresh" -> {
                    refreshCalls.incrementAndGet()
                    refreshAnswer?.let { Fixtures.response(it) } ?: dropConnection()
                }

                "/app/config" -> {
                    authorized(request) { Fixtures.response(configAnswer) }
                }

                "/sync/customers" -> {
                    authorized(request) { Fixtures.response("syncCustomers.response.json") }
                }

                "/payments:batch" -> {
                    authorized(request) { Fixtures.response("postPaymentBatch.response.json") }
                }

                else -> {
                    Fixtures.response("error.NOT_FOUND.json")
                }
            }
        }

    private fun authorized(
        request: RecordedRequest,
        answer: () -> MockResponse,
    ): MockResponse {
        val token = request.headers["Authorization"]?.removePrefix("Bearer ")
        if (token in validTokens) return answer()
        unauthenticatedGate?.let {
            it.countDown()
            it.await(LATCH_SECONDS, TimeUnit.SECONDS)
        }
        return Fixtures.response("error.UNAUTHENTICATED.json")
    }

    private fun dropConnection(): MockResponse =
        MockResponse.Builder().onRequestStart(SocketEffect.ShutdownConnection).build()

    @Before
    fun setUp() {
        server.dispatcher = routes
        server.start()
        network = TestNetwork(server, folder.root)
        await { network.auth.signIn("9876501234", "example-password") }
    }

    @After
    fun tearDown() {
        network.close()
        server.close()
    }

    private fun appConfig() = await { apiCall(network.errors) { network.mobileApi.getAppConfig() } }

    @Test
    fun `an expired access token is refreshed once and the request retried`() {
        val result = appConfig()

        assertEquals(TenantMode.NORMAL, (result as ApiResult.Success).value.tenantMode)
        assertEquals(1, refreshCalls.get())
        val calls = routes.requestsTo("/app/config").map { it.headers["Authorization"] }
        assertEquals(listOf("Bearer example-access-token-1", "Bearer example-access-token-2"), calls)

        val refresh = routes.requestsTo("/auth/refresh").single()
        val body = Json.decodeFromString(RefreshRequest.serializer(), refresh.bodyText)
        assertEquals(RefreshRequest("example-refresh-token-1", await { network.installId.get() }), body)
        assertEquals(null, refresh.headers["Authorization"])

        // The new pair replaced the old one, also on disk.
        assertEquals("example-refresh-token-2", network.store.tokensBlocking()?.refreshToken)
        network = network.restart()
        await { network.auth.restore() }
        assertEquals("example-access-token-2", network.store.tokensBlocking()?.accessToken)
    }

    @Test
    fun `concurrent 401s cause a single refresh`() {
        // OkHttp runs at most 5 calls per host at once (Dispatcher.maxRequestsPerHost).
        val parallel = 5
        unauthenticatedGate = CountDownLatch(parallel)

        val results =
            await {
                coroutineScope {
                    List(parallel) { index ->
                        async {
                            if (index % 2 == 0) {
                                apiCall(network.errors) { network.mobileApi.getAppConfig() }
                            } else {
                                apiCall(network.errors) { network.mobileApi.syncCustomers(cursor = null, limit = 500) }
                            }
                        }
                    }.awaitAll()
                }
            }

        assertTrue(results.toString(), results.all { it is ApiResult.Success })
        assertEquals("one refresh for $parallel concurrent 401s", 1, refreshCalls.get())
        val retried = routes.requests.filter { it.headers["Authorization"] == "Bearer example-access-token-2" }
        assertEquals(parallel, retried.size)
        assertEquals("example-refresh-token-2", network.store.tokensBlocking()?.refreshToken)
    }

    @Test
    fun `a refused refresh signs out once and fails every waiting request`() {
        refreshAnswer = "error.REFRESH_TOKEN_INVALID.json"
        val parallel = 5
        unauthenticatedGate = CountDownLatch(parallel)

        val results =
            await {
                coroutineScope {
                    List(parallel) { async { apiCall(network.errors) { network.mobileApi.getAppConfig() } } }.awaitAll()
                }
            }

        val expired = ApiResult.Failure(ApiFailure.SignedOut(SignOutReason.SESSION_EXPIRED))
        assertEquals(List(parallel) { expired }, results)
        assertEquals(1, refreshCalls.get())
        assertEquals(SessionState.SignedOut(SignOutReason.SESSION_EXPIRED), network.auth.state.value)
        assertEquals(null, network.store.tokensBlocking())
    }

    @Test
    fun `a revoked phone or disabled account ends the session with its reason`() {
        refreshAnswer = "error.DEVICE_REVOKED.json"
        assertEquals(ApiResult.Failure(ApiFailure.SignedOut(SignOutReason.PHONE_SIGNED_OUT)), appConfig())
        assertEquals(SessionState.SignedOut(SignOutReason.PHONE_SIGNED_OUT), network.auth.state.value)

        await { network.auth.signIn("9876501234", "example-password") }
        refreshAnswer = "error.ACCOUNT_DISABLED.json"
        assertEquals(ApiResult.Failure(ApiFailure.SignedOut(SignOutReason.ACCOUNT_DISABLED)), appConfig())
    }

    @Test
    fun `no internet or a server error during refresh keeps the session`() {
        refreshAnswer = null
        assertTrue((appConfig() as ApiResult.Failure).failure is ApiFailure.Offline)
        assertTrue(network.auth.state.value is SessionState.SignedIn)

        refreshAnswer = "error.INTERNAL.json"
        assertTrue((appConfig() as ApiResult.Failure).failure is ApiFailure.Offline)
        assertTrue(network.auth.state.value is SessionState.SignedIn)
        assertEquals("example-refresh-token-1", network.store.tokensBlocking()?.refreshToken)

        // Back online: the same refresh token still works.
        refreshAnswer = "refreshTokens.response.json"
        assertTrue(appConfig() is ApiResult.Success)
    }

    @Test
    fun `a second 401 after refreshing is returned, not retried in a loop`() {
        validTokens = emptySet()

        val failure = (appConfig() as ApiResult.Failure).failure

        assertEquals(401, (failure as ApiFailure.Server).httpStatus)
        assertEquals("UNAUTHENTICATED", failure.code)
        assertEquals(1, refreshCalls.get())
        assertEquals(2, routes.requestsTo("/app/config").size)
        assertTrue(network.auth.state.value is SessionState.SignedIn)
    }

    @Test
    fun `payment batch uses the dot-slash path and retries with the body after a refresh`() {
        val batch =
            Fixtures.decode(
                com.cablebilling.lineman.data.network.generated.PaymentBatchRequest
                    .serializer(),
                "postPaymentBatch.request.json",
            )

        val result = await { apiCall(network.errors) { network.mobileApi.postPaymentBatch(batch) } }

        assertTrue(result is ApiResult.Success)
        val calls = routes.requestsTo("/payments:batch")
        assertEquals("/api/mobile/v1/payments:batch", calls.last().url.encodedPath)
        assertEquals(2, calls.size)
        assertEquals(calls[0].bodyText, calls[1].bodyText)
    }

    @Test
    fun `APP_TOO_OLD on any endpoint opens the update gate`() {
        validTokens = setOf("example-access-token-1")
        server.dispatcher =
            Routes { request ->
                if (request.apiPath ==
                    "/sync/customers"
                ) {
                    Fixtures.response("error.APP_TOO_OLD.json")
                } else {
                    routes.dispatch(request)
                }
            }

        val result = await { apiCall(network.errors) { network.mobileApi.syncCustomers() } }

        assertEquals(ApiResult.Failure(ApiFailure.AppTooOld), result)
        assertTrue(network.gate.state.value.updateRequired)
        assertEquals(3L, network.gate.state.value.minimumVersionCode)
        // The session is untouched: the queue syncs after the update.
        assertTrue(network.auth.state.value is SessionState.SignedIn)
    }

    @Test
    fun `app config feeds the update gate, the operator and the flags`() {
        validTokens = setOf("example-access-token-1")
        configAnswer = "getAppConfig.response.json"
        assertTrue(await { network.appConfig.refresh() } is ApiResult.Success)
        assertEquals(false, network.gate.state.value.updateRequired)
        assertEquals(TenantMode.NORMAL, network.appConfig.tenantMode)
        assertEquals(
            "9800000001",
            network.store.session
                ?.operator
                ?.officePhone,
        )

        // Read-only tenant (D-13), a newer minimum version and a feature flag.
        configAnswer = "getAppConfig.response.read-only.json"
        assertTrue(await { network.appConfig.refresh() } is ApiResult.Success)
        assertEquals(TenantMode.READ_ONLY, network.appConfig.tenantMode)
        assertTrue(network.appConfig.isFeatureOn("example_flag"))
        assertEquals(false, network.appConfig.isFeatureOn("unknown_flag"))
        assertTrue(network.gate.state.value.updateRequired)
        assertEquals(3L, network.gate.state.value.minimumVersionCode)
        assertEquals(
            null,
            network.store.session
                ?.operator
                ?.officePhone,
        )
        // The session is kept: payments stay queued and sync after the update.
        assertTrue(network.auth.state.value is SessionState.SignedIn)

        // The server can lower the minimum again (e.g. a rollback): the gate opens.
        configAnswer = "getAppConfig.response.json"
        await { network.appConfig.refresh() }
        assertEquals(false, network.gate.state.value.updateRequired)
    }

    @Test
    fun `every request carries the app version header`() {
        appConfig()
        await { apiCall(network.errors) { network.mobileApi.syncCustomers() } }
        await { network.auth.signOut() }

        val requests = synchronized(routes.requests) { routes.requests.toList() }
        assertTrue(
            requests
                .map {
                    it.apiPath
                }.containsAll(listOf("/auth/login", "/auth/refresh", "/app/config", "/auth/logout")),
        )
        for (request in requests) assertEquals(request.apiPath, "1", request.headers[AppVersionInterceptor.HEADER])
    }

    private companion object {
        const val LATCH_SECONDS = 5L
    }
}
