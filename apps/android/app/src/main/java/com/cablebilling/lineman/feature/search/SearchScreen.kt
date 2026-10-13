package com.cablebilling.lineman.feature.search

import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.cablebilling.lineman.R
import com.cablebilling.lineman.ui.PlaceholderScreen

/** Home: number-pad customer search (PLAN §11.3). Placeholder until T-065. */
@Composable
fun SearchScreen() {
    PlaceholderScreen(title = stringResource(R.string.mobile_shell_nav_search), testTag = "screen_search")
}
