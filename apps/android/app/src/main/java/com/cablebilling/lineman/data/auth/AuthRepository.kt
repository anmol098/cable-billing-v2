package com.cablebilling.lineman.data.auth

import com.cablebilling.lineman.data.network.ApiErrorParser
import com.cablebilling.lineman.data.network.ApiResult
import com.cablebilling.lineman.data.network.AuthApi
import com.cablebilling.lineman.data.network.apiCall
import com.cablebilling.lineman.data.network.generated.LoginRequest
import com.cablebilling.lineman.data.network.generated.LogoutRequest
import kotlinx.coroutines.flow.StateFlow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Signing in and out (D-07, PLAN §11.6). The session itself lives in [SessionStore]; token refresh
 * happens on its own inside the authenticated HTTP client (AuthInterceptor + TokenRefresher).
 */
@Singleton
class AuthRepository
    @Inject
    constructor(
        private val authApi: AuthApi,
        private val store: SessionStore,
        private val installId: InstallId,
        private val deviceInfo: DeviceInfoSource,
        private val errors: ApiErrorParser,
    ) {
        /** Loading → SignedOut / SignedIn. Collect it to react to a session that ends by itself. */
        val state: StateFlow<SessionState> = store.state

        /** Reads the stored session (call once at start; cheap afterwards). */
        suspend fun restore(): SessionState = store.load()

        /**
         * `POST /auth/login` with this phone's [DeviceInfoSource] description. On success the
         * session is stored (sealed) and [state] becomes [SessionState.SignedIn]. Failures:
         * INVALID_CREDENTIALS, ACCOUNT_DISABLED, ROLE_NOT_ALLOWED, RATE_LIMITED (Server), Offline,
         * AppTooOld (the update screen takes over).
         */
        suspend fun signIn(
            login: String,
            password: String,
        ): ApiResult<Session> {
            val request =
                LoginRequest(login = login.trim(), password = password, device = deviceInfo.deviceInfo(installId.get()))
            return when (val result = apiCall(errors) { authApi.login(request) }) {
                is ApiResult.Success -> ApiResult.Success(store.signIn(result.value))
                is ApiResult.Failure -> result
            }
        }

        /**
         * Signs this phone out: the session is removed at once, then the refresh token is revoked on
         * the server (`POST /auth/logout`, best effort: offline, the token simply expires unused).
         * Queued payments are not touched; T-071 warns before calling this while payments wait.
         */
        suspend fun signOut() {
            val tokens = store.currentTokens()
            store.end(SignOutReason.SIGNED_OUT)
            if (tokens != null) apiCall(errors) { authApi.logout(LogoutRequest(refreshToken = tokens.refreshToken)) }
        }
    }
