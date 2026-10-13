package com.cablebilling.lineman.data.network

import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.Response

/**
 * Sends `x-app-version-code: <versionCode>` on every request (the contract requires it everywhere,
 * sign-in included) and reports an APP_TOO_OLD (426) answer to the [UpdateGate]. The response is
 * returned unchanged; [apiCall] maps it to [ApiFailure.AppTooOld].
 */
class AppVersionInterceptor(
    private val versionCode: Long,
    private val gate: UpdateGate,
    private val errors: ApiErrorParser,
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request =
            chain
                .request()
                .newBuilder()
                .header(HEADER, versionCode.toString())
                .build()
        val response = chain.proceed(request)
        if (response.code == ApiFailure.HTTP_UPGRADE_REQUIRED) {
            val minimum = errors.peek(response)?.minAppVersionCode
            runBlocking { gate.onAppTooOld(minimum) }
        }
        return response
    }

    companion object {
        /** packages/contracts `APP_VERSION_HEADER`. */
        const val HEADER = "x-app-version-code"
    }
}
