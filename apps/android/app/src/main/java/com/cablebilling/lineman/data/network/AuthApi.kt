package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.network.generated.LoginRequest
import com.cablebilling.lineman.data.network.generated.LoginResponse
import com.cablebilling.lineman.data.network.generated.LogoutRequest
import com.cablebilling.lineman.data.network.generated.LogoutResponse
import com.cablebilling.lineman.data.network.generated.RefreshRequest
import com.cablebilling.lineman.data.network.generated.RefreshResponse
import retrofit2.Call
import retrofit2.http.Body
import retrofit2.http.POST

/**
 * The sign-in endpoints of `/api/mobile/v1` (packages/contracts `auth`). They take no bearer token,
 * so they use the plain client (version header only), not the authenticated one. Paths are
 * relative to `BuildConfig.API_BASE_URL` (no leading slash).
 */
interface AuthApi {
    /** `POST /auth/login` (operationId `login`). Errors: INVALID_CREDENTIALS, ACCOUNT_DISABLED, ROLE_NOT_ALLOWED. */
    @POST("auth/login")
    suspend fun login(
        @Body body: LoginRequest,
    ): LoginResponse

    /**
     * `POST /auth/refresh` (operationId `refreshTokens`). Blocking [Call]: only [TokenRefresher]
     * uses it, from inside an OkHttp interceptor. Errors: REFRESH_TOKEN_INVALID, DEVICE_REVOKED,
     * ACCOUNT_DISABLED.
     */
    @POST("auth/refresh")
    fun refreshTokens(
        @Body body: RefreshRequest,
    ): Call<RefreshResponse>

    /** `POST /auth/logout` (operationId `logout`). Never answers APP_TOO_OLD. */
    @POST("auth/logout")
    suspend fun logout(
        @Body body: LogoutRequest,
    ): LogoutResponse
}
