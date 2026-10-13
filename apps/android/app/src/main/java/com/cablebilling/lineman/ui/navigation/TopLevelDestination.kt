package com.cablebilling.lineman.ui.navigation

import androidx.annotation.StringRes
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.ui.graphics.vector.ImageVector
import com.cablebilling.lineman.R
import kotlinx.serialization.Serializable

/** Type-safe Navigation Compose routes for the three bottom-bar screens (PLAN §11.2). */
@Serializable
data object SearchRoute

@Serializable
data object TodayRoute

@Serializable
data object WaitingRoute

/**
 * The bottom bar, in order: 🔍 Search (home, D-11) | 📅 Today | ⏳ Waiting.
 * TODO(T-009): swap the Material placeholder icons for the generated ic_cb_* drawables (T-003):
 * search, today, waiting.
 */
enum class TopLevelDestination(
    val route: Any,
    @param:StringRes val label: Int,
    val icon: ImageVector,
    val testTag: String,
) {
    Search(SearchRoute, R.string.mobile_shell_nav_search, Icons.Filled.Search, "nav_search"),
    Today(TodayRoute, R.string.mobile_shell_nav_today, Icons.Filled.DateRange, "nav_today"),
    Waiting(WaitingRoute, R.string.mobile_shell_nav_waiting, Icons.Filled.Refresh, "nav_waiting"),
    ;

    companion object {
        val Start = Search
    }
}
