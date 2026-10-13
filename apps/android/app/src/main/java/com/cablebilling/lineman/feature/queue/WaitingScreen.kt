package com.cablebilling.lineman.feature.queue

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.cablebilling.lineman.R
import com.cablebilling.lineman.ui.PlaceholderScreen

/** Payments saved on the phone and problems (PLAN §11.3 "Waiting"). Placeholder until T-066. */
@Composable
fun WaitingScreen() {
    PlaceholderScreen(title = stringResource(R.string.mobile_shell_nav_waiting), testTag = "screen_waiting")
}
