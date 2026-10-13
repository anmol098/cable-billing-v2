package com.cablebilling.lineman.data.network

import com.cablebilling.lineman.data.auth.SignOutReason
import java.io.IOException

// Interceptors may only throw IOExceptions: OkHttp rethrows anything else on its dispatcher thread
// (a crash). apiCall() turns these two into ApiFailure.SignedOut / ApiFailure.AppTooOld.

/** The session ended while making the call (refresh refused, or no session at all). */
class SessionEndedException(
    val reason: SignOutReason,
) : IOException("session ended: $reason")

/** The server refused this app version (APP_TOO_OLD) while refreshing the session. */
class AppTooOldException(
    val minAppVersionCode: Long?,
) : IOException("app too old; minimum version code $minAppVersionCode")
