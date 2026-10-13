package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.auth.InstallId
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.RefreshRequest
import com.cablebilling.lineman.data.network.generated.TokenPair
import kotlinx.coroutines.runBlocking
import java.io.IOException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Rotates the token pair with `POST /auth/refresh`, **one refresh at a time** (single flight).
 *
 * Refresh tokens are single use: if two requests that both got UNAUTHENTICATED refreshed with the
 * same refresh token, the second would be refused (REFRESH_TOKEN_INVALID) and sign the lineman
 * out. So every caller passes the tokens its request used; under one lock, the first caller does
 * the network refresh and the others find the tokens already replaced and just reuse them.
 *
 * Outcomes: refused with 401/403 (REFRESH_TOKEN_INVALID, DEVICE_REVOKED, ACCOUNT_DISABLED, or an
 * unknown code) ends the session; APP_TOO_OLD shows the update screen; no internet, 429 and 5xx
 * keep the session and fail only this request (it stays queued and is retried later).
 *
 * Blocking: called from OkHttp threads (AuthInterceptor).
 */
class TokenRefresher(
    private val store: SessionStore,
    private val authApi: AuthApi,
    private val installId: InstallId,
    private val errors: ApiErrorParser,
) {
    private val lock = ReentrantLock()

    sealed interface Outcome {
        data class Refreshed(
            val tokens: TokenPair,
        ) : Outcome

        data class Ended(
            val reason: SignOutReason,
        ) : Outcome

        data class AppTooOld(
            val minAppVersionCode: Long?,
        ) : Outcome

        data class Failed(
            val cause: IOException,
        ) : Outcome
    }

    /** Refreshes unless someone already replaced [used]. Returns the tokens to retry with, or why not. */
    fun refresh(used: TokenPair): Outcome =
        lock.withLock {
            val current = store.tokensBlocking() ?: return Outcome.Ended(store.signOutReason())
            if (current.accessToken != used.accessToken) return Outcome.Refreshed(current)

            val response =
                try {
                    authApi.refreshTokens(RefreshRequest(current.refreshToken, installId.getBlocking())).execute()
                } catch (e: IOException) {
                    return Outcome.Failed(e)
                }
            val body = response.body()
            if (response.isSuccessful && body != null) {
                val stored = runBlocking { store.replaceTokens(used = current, fresh = body.tokens) }
                if (stored) return Outcome.Refreshed(body.tokens)
                // Signed out (or in again) while refreshing: use whatever session there is now.
                return store.tokensBlocking()?.let(Outcome::Refreshed) ?: Outcome.Ended(store.signOutReason())
            }
            val error = errors.decode(response.errorBody()?.string())
            val status = response.code()
            when {
                status == ApiFailure.HTTP_UPGRADE_REQUIRED || error?.code == ErrorCode.APP_TOO_OLD.wire -> {
                    Outcome.AppTooOld(error?.minAppVersionCode)
                }

                status == ApiFailure.HTTP_UNAUTHORIZED || status == ApiFailure.HTTP_FORBIDDEN -> {
                    val reason = reasonFor(error?.code)
                    runBlocking { store.end(reason, onlyIfTokens = current) }
                    Outcome.Ended(reason)
                }

                else -> {
                    Outcome.Failed(IOException("refresh failed: HTTP $status ${error?.code.orEmpty()}".trim()))
                }
            }
        }

    private fun reasonFor(code: String?): SignOutReason =
        when (code?.let(ErrorCode::fromWire)) {
            ErrorCode.DEVICE_REVOKED -> SignOutReason.PHONE_SIGNED_OUT
            ErrorCode.ACCOUNT_DISABLED, ErrorCode.ROLE_NOT_ALLOWED -> SignOutReason.ACCOUNT_DISABLED
            else -> SignOutReason.SESSION_EXPIRED
        }
}
