package com.cablebilling.lineman.feature.login

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.cablebilling.lineman.data.auth.AuthRepository
import com.cablebilling.lineman.data.auth.SessionState
import com.cablebilling.lineman.data.network.AppConfigRepository
import com.cablebilling.lineman.data.network.UpdateGate
import com.cablebilling.lineman.data.network.UpdateState
import com.cablebilling.lineman.feature.update.UpdateRoute
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import javax.inject.Inject

/** Test tag of the blank screen shown while the stored session is read. */
const val SESSION_LOADING_TAG = "screen_session_loading"

/** Reads the stored session at start and fetches `/app/config` whenever someone is signed in. */
@HiltViewModel
class SessionGateViewModel
    @Inject
    constructor(
        auth: AuthRepository,
        gate: UpdateGate,
        appConfig: AppConfigRepository,
    ) : ViewModel() {
        val session: StateFlow<SessionState> = auth.state
        val update: StateFlow<UpdateState> = gate.state

        init {
            viewModelScope.launch {
                gate.load()
                auth.restore()
            }
            viewModelScope.launch {
                session
                    .map { it is SessionState.SignedIn }
                    .distinctUntilChanged()
                    .filter { signedIn -> signedIn }
                    // Best effort: offline it fails quietly; T-064 refreshes it again after each sync.
                    .collect { appConfig.refresh() }
            }
        }
    }

/**
 * The app's front door, around the app shell in MainActivity: the force-update screen if this
 * version is too old (it wins over everything), the login screen if nobody is signed in, else
 * [content]. The content is keyed by the user, so a different lineman starts with fresh screens.
 */
@Composable
fun SessionGate(
    viewModel: SessionGateViewModel = hiltViewModel(),
    content: @Composable () -> Unit,
) {
    val update by viewModel.update.collectAsStateWithLifecycle()
    val session by viewModel.session.collectAsStateWithLifecycle()
    SessionGateContent(
        updateRequired = update.updateRequired,
        session = session,
        updateScreen = { UpdateRoute() },
        loginScreen = { LoginRoute() },
        content = content,
    )
}

/** [SessionGate] without its ViewModel (tests, previews). */
@Composable
fun SessionGateContent(
    updateRequired: Boolean,
    session: SessionState,
    updateScreen: @Composable () -> Unit,
    loginScreen: @Composable () -> Unit,
    content: @Composable () -> Unit,
) {
    when {
        updateRequired -> FullScreen(updateScreen)
        session is SessionState.Loading -> FullScreen { Box(Modifier.fillMaxSize().testTag(SESSION_LOADING_TAG)) }
        session is SessionState.SignedOut -> FullScreen(loginScreen)
        session is SessionState.SignedIn -> key(session.session.user.id) { content() }
    }
}

/** A screen outside the app shell: theme background, kept clear of the system bars and keyboard. */
@Composable
private fun FullScreen(screen: @Composable () -> Unit) {
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize().safeDrawingPadding()) { screen() }
    }
}
