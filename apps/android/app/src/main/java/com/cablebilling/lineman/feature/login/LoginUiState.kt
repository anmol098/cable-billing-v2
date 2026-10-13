package com.cablebilling.lineman.feature.login

import androidx.annotation.StringRes
import com.cablebilling.lineman.R
import com.cablebilling.lineman.data.auth.SignOutReason
import com.cablebilling.lineman.data.network.ApiFailure
import com.cablebilling.lineman.data.network.generated.ErrorCode

/** Which on-screen keyboard a field asks for: the `123` / `ABC` toggle (PLAN §11.3). */
enum class KeyboardMode {
    Numbers,
    Letters,
    ;

    fun toggled(): KeyboardMode = if (this == Numbers) Letters else Numbers
}

/** Everything the login screen shows. */
data class LoginUiState(
    val login: String = "",
    val password: String = "",
    /** The login is usually the lineman's mobile number, so digits first. */
    val loginKeyboard: KeyboardMode = KeyboardMode.Numbers,
    val passwordKeyboard: KeyboardMode = KeyboardMode.Letters,
    /** "Show password" is on by default (D-07): typing blind is hard for low-literacy users. */
    val passwordVisible: Boolean = true,
    val busy: Boolean = false,
    val message: LoginMessage? = null,
    /** The operator's office phone if this phone has ever known it; "Call office" opens the dialer either way. */
    val officePhone: String? = null,
) {
    val canSubmit: Boolean get() = !busy && login.isNotBlank() && password.isNotEmpty()
}

/** One short sentence above the fields: why sign-in failed, or why the last session ended. */
enum class LoginMessage(
    @param:StringRes val text: Int,
) {
    WrongPassword(R.string.mobile_login_error_wrong_password),
    AccountDisabled(R.string.mobile_login_error_account_disabled),
    NotLineman(R.string.mobile_login_error_not_lineman),
    TooManyTries(R.string.mobile_login_error_too_many_tries),
    NoInternet(R.string.mobile_login_error_no_internet),
    SomethingWentWrong(R.string.common_something_went_wrong),
    SessionExpired(R.string.mobile_login_signed_out_session_expired),
    PhoneSignedOut(R.string.mobile_login_signed_out_phone_signed_out),
    AccountSwitchedOff(R.string.mobile_login_signed_out_account_disabled),
    StorageReset(R.string.mobile_login_signed_out_storage_reset),
    ;

    companion object {
        /** The message for a failed sign-in; null when another screen takes over (update screen). */
        fun forFailure(failure: ApiFailure): LoginMessage? =
            when (failure) {
                is ApiFailure.Offline -> NoInternet
                is ApiFailure.AppTooOld -> null
                is ApiFailure.Server -> forServer(failure)
                is ApiFailure.Malformed, is ApiFailure.SignedOut -> SomethingWentWrong
            }

        private fun forServer(failure: ApiFailure.Server): LoginMessage =
            when (failure.knownCode) {
                ErrorCode.INVALID_CREDENTIALS, ErrorCode.VALIDATION -> {
                    WrongPassword
                }

                ErrorCode.ACCOUNT_DISABLED -> {
                    AccountDisabled
                }

                ErrorCode.ROLE_NOT_ALLOWED -> {
                    NotLineman
                }

                ErrorCode.RATE_LIMITED -> {
                    TooManyTries
                }

                // A code newer than this app: go by the HTTP status (contract README).
                null -> {
                    when (failure.httpStatus) {
                        ApiFailure.HTTP_UNAUTHORIZED -> WrongPassword
                        ApiFailure.HTTP_FORBIDDEN -> AccountDisabled
                        ApiFailure.HTTP_TOO_MANY_REQUESTS -> TooManyTries
                        else -> SomethingWentWrong
                    }
                }

                else -> {
                    SomethingWentWrong
                }
            }

        /** The message for why the last session ended; null for a first sign-in or a chosen sign-out. */
        fun forSignOut(reason: SignOutReason?): LoginMessage? =
            when (reason) {
                null, SignOutReason.SIGNED_OUT -> null
                SignOutReason.SESSION_EXPIRED -> SessionExpired
                SignOutReason.PHONE_SIGNED_OUT -> PhoneSignedOut
                SignOutReason.ACCOUNT_DISABLED -> AccountSwitchedOff
                SignOutReason.STORAGE_RESET -> StorageReset
            }
    }
}
