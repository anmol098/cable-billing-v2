package com.cablebilling.lineman.ui.navigation

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import com.cablebilling.lineman.R
import kotlinx.serialization.Serializable
import com.cablebilling.designsystem.R as DesignR

/** Type-safe Navigation Compose routes for the three bottom-bar screens (PLAN §11.2). */
@Serializable
data object SearchRoute

@Serializable
data object TodayRoute

@Serializable
data object WaitingRoute

/**
 * The bottom bar, in order: 🔍 Search (home, D-11) | 📅 Today | ⏳ Waiting. Icons are the shared
 * semantic icons from packages/design-tokens/icons.json (T-003), the same glyphs as on the web.
 */
enum class TopLevelDestination(
    val route: Any,
    @param:StringRes val label: Int,
    @param:DrawableRes val icon: Int,
    val testTag: String,
) {
    Search(SearchRoute, R.string.mobile_shell_nav_search, DesignR.drawable.ic_cb_search, "nav_search"),
    Today(TodayRoute, R.string.mobile_shell_nav_today, DesignR.drawable.ic_cb_today, "nav_today"),
    Waiting(WaitingRoute, R.string.mobile_shell_nav_waiting, DesignR.drawable.ic_cb_waiting, "nav_waiting"),
    ;

    companion object {
        val Start = Search
    }
}
