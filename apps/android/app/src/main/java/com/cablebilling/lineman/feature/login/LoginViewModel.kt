package com.cablebilling.lineman.feature.login

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.cablebilling.lineman.data.auth.AuthRepository
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.auth.SessionStore
import com.cablebilling.lineman.data.network.ApiResult
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/** The login screen (PLAN §11.3, D-07): two fields, sign in, call office. */
@HiltViewModel
class LoginViewModel
    @Inject
    constructor(
        private val auth: AuthRepository,
        store: SessionStore,
    ) : ViewModel() {
        private val mutableState = MutableStateFlow(LoginUiState())
        val state: StateFlow<LoginUiState> = mutableState.asStateFlow()

        init {
            viewModelScope.launch {
                store.officePhone.collect { phone -> mutableState.update { it.copy(officePhone = phone) } }
            }
            viewModelScope.launch {
                auth.state.collect { session ->
                    // A session that ended by itself (refresh refused, phone signed out by the owner):
                    // say why, and ask for the password again. The login stays filled in.
                    if (session is SessionState.SignedOut) {
                        val message = LoginMessage.forSignOut(session.reason)
                        mutableState.update { it.copy(password = "", busy = false, message = message ?: it.message) }
                    }
                }
            }
        }

        fun onLoginChange(value: String) = mutableState.update { it.copy(login = value) }

        fun onPasswordChange(value: String) = mutableState.update { it.copy(password = value) }

        fun onToggleLoginKeyboard() = mutableState.update { it.copy(loginKeyboard = it.loginKeyboard.toggled()) }

        fun onTogglePasswordKeyboard() =
            mutableState.update { it.copy(passwordKeyboard = it.passwordKeyboard.toggled()) }

        fun onTogglePasswordVisible() = mutableState.update { it.copy(passwordVisible = !it.passwordVisible) }

        fun signIn() {
            val current = mutableState.value
            if (!current.canSubmit) return
            mutableState.update { it.copy(busy = true, message = null) }
            viewModelScope.launch {
                val result = auth.signIn(current.login, current.password)
                mutableState.update {
                    when (result) {
                        // The session gate swaps this screen for the app; clear the password from memory.
                        is ApiResult.Success -> it.copy(busy = false, password = "", message = null)

                        is ApiResult.Failure -> it.copy(busy = false, message = LoginMessage.forFailure(result.failure))
                    }
                }
            }
        }
    }
