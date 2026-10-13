package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.network.generated.ApiError
import com.cablebilling.lineman.data.network.generated.ErrorCode
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.SerializationException
import retrofit2.HttpException
import java.io.IOException

/** The outcome of one call to `/api/mobile/v1`: the decoded body, or why there is none. */
sealed interface ApiResult<out T> {
    data class Success<out T>(
        val value: T,
    ) : ApiResult<T>

    data class Failure(
        val failure: ApiFailure,
    ) : ApiResult<Nothing>
}

/**
 * Why a call failed. Screens map this to words and icons; they never show [ApiError.message].
 *
 * Retry guide for queues (payments, receipt actions): [Offline], [Malformed] and a [Server] failure
 * with [Server.isTemporary] stay on the phone and are retried later. [AppTooOld] and [SignedOut]
 * stay on the phone too: the update or login screen is already showing, and the queue syncs after.
 */
sealed interface ApiFailure {
    /**
     * No answer from the server: no internet, timeout, or the connection dropped. The request may
     * or may not have reached the server (idempotency keys make a retry safe).
     */
    data class Offline(
        val cause: IOException,
    ) : ApiFailure

    /** The server answered with an error body (`ErrorResponse`), or at least an error status. */
    data class Server(
        val httpStatus: Int,
        /** `error.code` as sent (an open enum: may be a code this app does not know). */
        val code: String,
        /** The decoded error, or null if the body was not an `ErrorResponse`. */
        val error: ApiError?,
    ) : ApiFailure {
        /** [code] as a known [ErrorCode], or null for a code newer than this app (use [httpStatus]). */
        val knownCode: ErrorCode? get() = ErrorCode.fromWire(code)

        /** 429 and 5xx: nothing was done, try again later. */
        val isTemporary: Boolean get() = httpStatus == HTTP_TOO_MANY_REQUESTS || httpStatus >= HTTP_SERVER_ERROR

        /** For RATE_LIMITED: how long to wait, if the server said. */
        val retryAfterSeconds: Long? get() = error?.retryAfterSeconds
    }

    /** The server refused this app version (APP_TOO_OLD). The update screen is showing. */
    data object AppTooOld : ApiFailure

    /** The session ended (refresh refused, phone signed out by the owner). The login screen is showing. */
    data class SignedOut(
        val reason: SignOutReason,
    ) : ApiFailure

    /** The server answered 2xx but the body did not match the contract (a bug on one side). */
    data class Malformed(
        val cause: Exception,
    ) : ApiFailure

    companion object {
        const val HTTP_TOO_MANY_REQUESTS = 429
        const val HTTP_SERVER_ERROR = 500
        const val HTTP_UPGRADE_REQUIRED = 426
        const val HTTP_UNAUTHORIZED = 401
        const val HTTP_FORBIDDEN = 403
    }
}

/**
 * Runs one Retrofit call and maps every failure to an [ApiFailure]. Use it around every
 * [MobileApi] / [AuthApi] call:
 *
 * ```
 * when (val result = apiCall(errors) { mobileApi.getCustomer(id) }) {
 *     is ApiResult.Success -> show(result.value.customer)
 *     is ApiResult.Failure -> showProblem(result.failure)
 * }
 * ```
 *
 * Coroutine cancellation is rethrown, never turned into a failure.
 */
suspend fun <T> apiCall(
    errors: ApiErrorParser,
    block: suspend () -> T,
): ApiResult<T> =
    try {
        ApiResult.Success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: SessionEndedException) {
        ApiResult.Failure(ApiFailure.SignedOut(e.reason))
    } catch (ignored: AppTooOldException) {
        ApiResult.Failure(ApiFailure.AppTooOld)
    } catch (e: IOException) {
        ApiResult.Failure(ApiFailure.Offline(e))
    } catch (e: HttpException) {
        ApiResult.Failure(errors.fromHttpException(e))
    } catch (e: SerializationException) {
        // A 2xx body that does not match the DTO (missing field, wrong type): a contract bug.
        ApiResult.Failure(ApiFailure.Malformed(e))
    }

/** Shortcut for `(this as? ApiResult.Success)?.value`. */
fun <T> ApiResult<T>.valueOrNull(): T? = (this as? ApiResult.Success)?.value
