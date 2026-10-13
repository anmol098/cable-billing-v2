package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.network.generated.ApiError
import com.cablebilling.lineman.data.network.generated.ErrorCode
import com.cablebilling.lineman.data.network.generated.ErrorResponse
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import okhttp3.Response
import retrofit2.HttpException
import java.io.IOException
import javax.inject.Inject

/**
 * Reads the contract's error body (`{ server_time, error: { code, message, request_id, … } }`).
 * `error.code` is an open enum, so it stays a `String`; a body that is not an `ErrorResponse`
 * (a proxy's HTML page, an empty 502) still gives a [ApiFailure.Server] with code `HTTP_<status>`.
 */
class ApiErrorParser
    @Inject
    constructor(
        private val json: Json,
    ) {
        /** The [ApiError] in [body], or null if it is not a contract error body. */
        fun decode(body: String?): ApiError? {
            if (body.isNullOrBlank()) return null
            return try {
                json.decodeFromString(ErrorResponse.serializer(), body).error
            } catch (ignored: SerializationException) {
                null
            } catch (ignored: IllegalArgumentException) {
                null
            }
        }

        /** The failure for an error status and its body. */
        fun failure(
            httpStatus: Int,
            body: String?,
        ): ApiFailure {
            val error = decode(body)
            if (httpStatus == ApiFailure.HTTP_UPGRADE_REQUIRED || error?.code == ErrorCode.APP_TOO_OLD.wire) {
                return ApiFailure.AppTooOld
            }
            return ApiFailure.Server(httpStatus, error?.code ?: "HTTP_$httpStatus", error)
        }

        fun fromHttpException(e: HttpException): ApiFailure {
            val body =
                try {
                    e.response()?.errorBody()?.string()
                } catch (ignored: IOException) {
                    null
                }
            return failure(e.code(), body)
        }

        /** Reads an OkHttp error response without consuming it (for interceptors). */
        fun peek(response: Response): ApiError? =
            try {
                decode(response.peekBody(MAX_ERROR_BODY_BYTES).string())
            } catch (ignored: IOException) {
                null
            }

        private companion object {
            /** Error bodies are small; never buffer more than this from an interceptor. */
            const val MAX_ERROR_BODY_BYTES = 64L * 1024
        }
    }
