package com.cablebilling.lineman.feature.today

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.cablebilling.lineman.R
import com.cablebilling.lineman.ui.PlaceholderScreen

/** Today's cash / UPI totals and cash handover (PLAN §11.3). Placeholder until T-070. */
@Composable
fun TodayScreen() {
    PlaceholderScreen(title = stringResource(R.string.mobile_shell_nav_today), testTag = "screen_today")
}
