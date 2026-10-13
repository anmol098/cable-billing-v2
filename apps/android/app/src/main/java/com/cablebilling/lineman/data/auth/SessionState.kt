package com.cablebilling.lineman.data.auth

import com.cablebilling.lineman.data.network.generated.OperatorInfo
import com.cablebilling.lineman.data.network.generated.RegisteredDevice
import com.cablebilling.lineman.data.network.generated.UserInfo

/** Who is signed in on this phone. Tokens are not part of it: they never leave the auth layer. */
data class Session(
    /** The lineman (`user.id` is the payment's `collector_id`; `user.name` is printed on receipts). */
    val user: UserInfo,
    /** The operator (name, `office_phone` for "Call office", `receipt_footer`). Refreshed by /app/config. */
    val operator: OperatorInfo,
    /** This phone's registration (`device.id` is the payment's `device_id`, `device_code` the P-ref prefix). */
    val device: RegisteredDevice,
)

/** The app's sign-in state (PLAN §11.6: sign in once per phone; no sign-out on app close). */
sealed interface SessionState {
    /** Not read from storage yet (the first few milliseconds after start). */
    data object Loading : SessionState

    /** Nobody is signed in. [reason] says why the last session ended, null if there was none. */
    data class SignedOut(
        val reason: SignOutReason? = null,
    ) : SessionState

    data class SignedIn(
        val session: Session,
    ) : SessionState
}

/**
 * Why a session ended. Queued payments are never deleted for any of these (PLAN §9.2); they sync
 * after the same lineman signs in again.
 */
enum class SignOutReason {
    /** The lineman signed out on purpose (settings, T-071). */
    SIGNED_OUT,

    /** The refresh token expired, was already used or is unknown (REFRESH_TOKEN_INVALID). */
    SESSION_EXPIRED,

    /** The owner signed this phone out on the web (DEVICE_REVOKED). */
    PHONE_SIGNED_OUT,

    /** The lineman's account (or the operator) is switched off (ACCOUNT_DISABLED). */
    ACCOUNT_DISABLED,

    /** The stored session could not be read (e.g. the phone's key store was reset). */
    STORAGE_RESET,
}
