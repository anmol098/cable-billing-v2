package com.cablebilling.lineman.feature.settings

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.locale.AppLanguage
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Where the sign-out stands. */
enum class SignOutStep {
    /** The "Sign out" button. */
    Idle,

    /** Looking for this lineman's payments on the phone. */
    Checking,

    /** No payments of this lineman on the phone: "Sign out of this phone?" Yes / Cancel. */
    Confirm,

    /** This lineman still has payments on the phone: explain, "Try now", "Open Waiting". */
    Blocked,

    /** Signing out (the login screen follows by itself). */
    SigningOut,
}

/** Everything the settings screen shows. */
data class SettingsUiState(
    /** `hi` or `en` (AppLanguage). */
    val language: String = AppLanguage.DEFAULT,
    /** The chosen printer's name, or null before printer setup. */
    val printerName: String? = null,
    /** The signed-in lineman's name (their own phone; never written to the diagnostic log). */
    val userName: String? = null,
    /** `0.1.0 (1)`. */
    val version: String = "",
    /** This lineman's payments still on the phone (another lineman's held ones do not count). */
    val waiting: Int = 0,
    val signOut: SignOutStep = SignOutStep.Idle,
)

/**
 * Settings (PLAN §11.3): language, voice (the shared `Speaker`, shown with `VoiceToggle`), printer,
 * sign out, app version and the app report. Sign-out is refused while this lineman has payments on
 * the phone (PLAN §9.2), and checked again right before it happens. It never deletes payments.
 */
@HiltViewModel
class SettingsViewModel
    @Inject
    constructor(
        private val data: SettingsData,
    ) : ViewModel() {
        private val language = MutableStateFlow(data.language)
        private val step = MutableStateFlow(SignOutStep.Idle)

        @OptIn(ExperimentalCoroutinesApi::class)
        private val waiting =
            data.session().flatMapLatest { session ->
                val userId = (session as? SessionState.SignedIn)?.session?.user?.id
                if (userId == null) flowOf(0) else data.waitingCount(userId)
            }

        val state: StateFlow<SettingsUiState> =
            combine(
                language,
                data.session(),
                data.printer(),
                waiting,
                step,
            ) { language, session, printer, waiting, step ->
                SettingsUiState(
                    language = language,
                    printerName = printer?.name,
                    userName = (session as? SessionState.SignedIn)?.session?.user?.name,
                    version = data.version,
                    waiting = waiting,
                    signOut = step,
                )
            }.stateIn(
                viewModelScope,
                SharingStarted.WhileSubscribed(STOP_TIMEOUT_MS),
                SettingsUiState(language = data.language, version = data.version),
            )

        /** Switches the whole app's language (remembered; the screen is redrawn in it). */
        fun setLanguage(newLanguage: String) {
            if (newLanguage !in AppLanguage.SUPPORTED || newLanguage == language.value) return
            data.setLanguage(newLanguage)
            language.value = newLanguage
        }

        /** "Sign out": first make sure none of this lineman's payments are only on the phone. */
        fun signOut() {
            if (step.value == SignOutStep.Checking || step.value == SignOutStep.SigningOut) return
            step.value = SignOutStep.Checking
            viewModelScope.launch {
                val userId = signedInUserId()
                step.value =
                    when {
                        userId == null -> SignOutStep.Idle
                        data.hasPaymentsOnPhone(userId) -> blocked()
                        else -> SignOutStep.Confirm
                    }
            }
        }

        /** "Yes, sign out": checked once more (a payment may have been saved meanwhile), then signed out. */
        fun confirmSignOut() {
            if (step.value != SignOutStep.Confirm) return
            step.value = SignOutStep.SigningOut
            viewModelScope.launch {
                val userId = signedInUserId()
                if (userId != null && data.hasPaymentsOnPhone(userId)) {
                    step.value = blocked()
                    return@launch
                }
                data.signOut()
                step.value = SignOutStep.Idle
            }
        }

        fun cancelSignOut() {
            if (step.value == SignOutStep.Confirm || step.value == SignOutStep.Blocked) step.value = SignOutStep.Idle
        }

        /** "Try now" on the blocked explanation: push this lineman's payments at once. */
        fun tryNow() = data.tryNow()

        /** The app report to share (plain text, no personal data). */
        suspend fun report(): String = data.report()

        private suspend fun signedInUserId(): String? =
            (data.session().first() as? SessionState.SignedIn)?.session?.user?.id

        private fun blocked(): SignOutStep {
            data.note("sign_out_blocked")
            return SignOutStep.Blocked
        }

        private companion object {
            const val STOP_TIMEOUT_MS = 5_000L
        }
    }
