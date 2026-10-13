package com.cablebilling.lineman.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.navigation.NavDestination
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.lineman.feature.queue.WaitingScreen
import com.cablebilling.lineman.feature.search.SearchScreen
import com.cablebilling.lineman.feature.today.TodayScreen
import com.cablebilling.lineman.ui.navigation.SearchRoute
import com.cablebilling.lineman.ui.navigation.TodayRoute
import com.cablebilling.lineman.ui.navigation.TopLevelDestination
import com.cablebilling.lineman.ui.navigation.WaitingRoute

/** App shell: the three top-level screens behind a bottom bar (PLAN §11.2). Login (T-063) goes in front. */
@Composable
fun CableApp(navController: NavHostController = rememberNavController()) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = backStackEntry?.destination
    Scaffold(
        bottomBar = {
            CableBottomBar(
                currentDestination = currentDestination,
                onSelect = { destination -> navController.navigateToTopLevel(destination) },
            )
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = TopLevelDestination.Start.route,
            modifier = Modifier.padding(padding),
        ) {
            composable<SearchRoute> { SearchScreen() }
            composable<TodayRoute> { TodayScreen() }
            composable<WaitingRoute> { WaitingScreen() }
        }
    }
}

@Composable
private fun CableBottomBar(
    currentDestination: NavDestination?,
    onSelect: (TopLevelDestination) -> Unit,
) {
    // Flat bar (PLAN §6.3: no shadows / tonal elevation).
    NavigationBar(tonalElevation = Tokens.Elevation.None) {
        TopLevelDestination.entries.forEach { destination ->
            val selected = currentDestination.isOn(destination)
            NavigationBarItem(
                selected = selected,
                onClick = { if (!selected) onSelect(destination) },
                icon = { Icon(painterResource(destination.icon), contentDescription = null) },
                label = { Text(stringResource(destination.label), style = MaterialTheme.typography.labelLarge) },
                alwaysShowLabel = true,
                modifier = Modifier.testTag(destination.testTag),
            )
        }
    }
}

private fun NavDestination?.isOn(destination: TopLevelDestination): Boolean =
    this?.hierarchy?.any { it.hasRoute(destination.route::class) } == true

/** Bottom-bar navigation: one copy of each tab, state kept when switching back. */
private fun NavHostController.navigateToTopLevel(destination: TopLevelDestination) {
    navigate(destination.route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}
