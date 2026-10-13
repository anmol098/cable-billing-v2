package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.TokenPair
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Request
import okhttp3.Response

/**
 * Adds `Authorization: Bearer <access_token>` and handles an expired access token: on 401
 * UNAUTHENTICATED it refreshes once through [TokenRefresher] (single flight, so concurrent 401s
 * cause one refresh) and retries the request once with the new token. A second 401 is returned
 * as is (no loop).
 *
 * Refresh is reactive only (no early refresh from `access_token_expires_at`): a phone with a wrong
 * clock would otherwise refresh before every request. It costs one extra round trip about every
 * 15 minutes.
 *
 * Without a session it does not call the server: it throws [SessionEndedException], which
 * [apiCall] maps to [ApiFailure.SignedOut]. Only for the authenticated client (MobileApi).
 */
class AuthInterceptor(
    private val store: SessionStore,
    private val refresher: TokenRefresher,
    private val errors: ApiErrorParser,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val tokens = store.tokensBlocking() ?: throw SessionEndedException(store.signOutReason())
        val response = chain.proceed(chain.request().withBearer(tokens.accessToken))
        if (response.code != ApiFailure.HTTP_UNAUTHORIZED) return response

        // Bearer endpoints answer UNAUTHENTICATED for a stale token. A revoked phone or a disabled
        // account may also come back here; those end the session without a refresh.
        when (errors.peek(response)?.code?.let(ErrorCode::fromWire)) {
            ErrorCode.DEVICE_REVOKED -> endSession(response, SignOutReason.PHONE_SIGNED_OUT, tokens)
            ErrorCode.ACCOUNT_DISABLED -> endSession(response, SignOutReason.ACCOUNT_DISABLED, tokens)
            else -> Unit
        }
        response.close()
        return when (val outcome = refresher.refresh(used = tokens)) {
            is TokenRefresher.Outcome.Refreshed -> chain.proceed(chain.request().withBearer(outcome.tokens.accessToken))
            is TokenRefresher.Outcome.Ended -> throw SessionEndedException(outcome.reason)
            is TokenRefresher.Outcome.AppTooOld -> throw AppTooOldException(outcome.minAppVersionCode)
            is TokenRefresher.Outcome.Failed -> throw outcome.cause
        }
    }

    private fun endSession(
        response: Response,
        reason: SignOutReason,
        tokens: TokenPair,
    ): Nothing {
        response.close()
        runBlocking { store.end(reason, onlyIfTokens = tokens) }
        throw SessionEndedException(reason)
    }

    private fun Request.withBearer(accessToken: String): Request =
        newBuilder().header(AUTHORIZATION, "Bearer $accessToken").build()

    companion object {
        const val AUTHORIZATION = "Authorization"
    }
}
