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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation.NavDestination
import androidx.navigation.NavDestination.Companion.hasRoute
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import com.cablebilling.designsystem.generated.Tokens
import com.cablebilling.lineman.R
import com.cablebilling.lineman.feature.collect.CollectDoneRoute
import com.cablebilling.lineman.feature.collect.CollectDoneScreen
import com.cablebilling.lineman.feature.collect.CollectScreen
import com.cablebilling.lineman.feature.collect.navigateToCollectDone
import com.cablebilling.lineman.feature.customer.CustomerRoute
import com.cablebilling.lineman.feature.customer.CustomerScreen
import com.cablebilling.lineman.feature.customer.navigateToCustomer
import com.cablebilling.lineman.feature.printer.PrinterSetup
import com.cablebilling.lineman.feature.printer.PrinterSetupRoute
import com.cablebilling.lineman.feature.search.SearchScreen
import com.cablebilling.lineman.feature.settings.Settings
import com.cablebilling.lineman.feature.settings.SettingsRoute
import com.cablebilling.lineman.feature.today.TodayScreen
import com.cablebilling.lineman.feature.waiting.WaitingScreen
import com.cablebilling.lineman.ui.navigation.CollectRoute
import com.cablebilling.lineman.ui.navigation.SearchRoute
import com.cablebilling.lineman.ui.navigation.TodayRoute
import com.cablebilling.lineman.ui.navigation.TopLevelDestination
import com.cablebilling.lineman.ui.navigation.WaitingRoute
import kotlin.reflect.KClass

/** The search home (T-065): opens a customer, or the Waiting tab from the sync strip. */
typealias SearchHomeSlot = @Composable (onOpenCustomer: (customerId: String) -> Unit, onOpenWaiting: () -> Unit) -> Unit

/** The customer screen (T-065): Collect opens the collect flow (T-066), back returns to search. */
typealias CustomerSlot =
    @Composable (customerId: String, onCollect: (customerId: String) -> Unit, onBack: () -> Unit) -> Unit

/** The collect flow (T-066): Amount → Method → Confirm; `onSaved` once the payment is committed on the phone. */
typealias CollectSlot =
    @Composable (customerId: String, onSaved: (paymentId: String) -> Unit, onBack: () -> Unit) -> Unit

/** The Done screen of a saved payment (T-066): printer setup, and Done back to the search home. */
typealias CollectDoneSlot =
    @Composable (paymentId: String, onPrinterSetup: () -> Unit, onFinish: () -> Unit) -> Unit

/** The Waiting tab (T-066). */
typealias WaitingSlot = @Composable () -> Unit

/** Settings (T-071): printer setup, the Waiting tab (sign-out blocked by payments on the phone), back. */
typealias SettingsSlot =
    @Composable (onPrinterSetup: () -> Unit, onOpenWaiting: () -> Unit, onBack: () -> Unit) -> Unit

/**
 * App shell: the three top-level screens behind a bottom bar (PLAN §11.2). Login (T-063) goes in front.
 * Search → Customer → Collect → Done sit above the search home on the Search tab's stack. The slots
 * default to the Hilt screens; tests that run the shell without Hilt pass their own.
 */
@Composable
fun CableApp(
    navController: NavHostController = rememberNavController(),
    searchHome: SearchHomeSlot = { onOpenCustomer, onOpenWaiting ->
        // T-071: the search home's small gear opens settings.
        SearchScreen(
            onOpenCustomer,
            onOpenWaiting,
            onOpenSettings = dropUnlessResumed { navController.navigate(SettingsRoute) },
        )
    },
    customerScreen: CustomerSlot = { customerId, onCollect, onBack -> CustomerScreen(customerId, onCollect, onBack) },
    collectScreen: CollectSlot = { customerId, onSaved, onBack -> CollectScreen(customerId, onSaved, onBack) },
    collectDone: CollectDoneSlot = { paymentId, onPrinterSetup, onFinish ->
        CollectDoneScreen(paymentId, onPrinterSetup, onFinish)
    },
    waitingScreen: WaitingSlot = { WaitingScreen() },
    settingsScreen: SettingsSlot = { onPrinterSetup, onOpenWaiting, onBack ->
        Settings(onBack = onBack, onPrinterSetup = onPrinterSetup, onOpenWaiting = onOpenWaiting)
    },
) {
    val backStackEntry by navController.currentBackStackEntryAsState()
    val currentDestination = backStackEntry?.destination
    Scaffold(
        bottomBar = {
            CableBottomBar(
                currentDestination = currentDestination,
                onSelect = { destination -> navController.navigateToTopLevel(destination) },
                // The tab is already on but shows a sub-screen (e.g. a customer): back to the tab's first screen.
                onReselect = { destination -> navController.popBackStack(destination.route, inclusive = false) },
            )
        },
    ) { padding ->
        NavHost(
            navController = navController,
            startDestination = TopLevelDestination.Start.route,
            modifier = Modifier.padding(padding),
        ) {
            composable<SearchRoute> {
                searchHome(
                    dropUnlessResumedWith { customerId -> navController.navigateToCustomer(customerId) },
                    dropUnlessResumed { navController.navigateToTopLevel(TopLevelDestination.Waiting) },
                )
            }
            composable<CustomerRoute> { entry ->
                customerScreen(
                    entry.toRoute<CustomerRoute>().customerId,
                    dropUnlessResumedWith { customerId -> navController.navigate(CollectRoute(customerId)) },
                    dropUnlessResumed { navController.popBackStack() },
                )
            }
            // T-066: Amount → Method → (UPI ref) → Confirm in one destination; Save replaces it with Done.
            composable<CollectRoute> { entry ->
                collectScreen(
                    entry.toRoute<CollectRoute>().customerId,
                    { paymentId -> navController.navigateToCollectDone(paymentId) },
                    dropUnlessResumed { navController.popBackStack() },
                )
            }
            composable<CollectDoneRoute> { entry ->
                collectDone(
                    entry.toRoute<CollectDoneRoute>().paymentId,
                    dropUnlessResumed { navController.navigate(PrinterSetupRoute) },
                    // Done: next customer, from the search home.
                    dropUnlessResumed { navController.popBackStack(SearchRoute, inclusive = false) },
                )
            }
            composable<TodayRoute> { TodayScreen() }
            composable<WaitingRoute> { waitingScreen() }
            // Printer setup (T-068): opened from settings (T-071) and the receipt screen (T-069).
            composable<PrinterSetupRoute> { PrinterSetup(onBack = { navController.popBackStack() }) }
            // Settings (T-071), above the search home on the Search tab.
            composable<SettingsRoute> {
                settingsScreen(
                    dropUnlessResumed { navController.navigate(PrinterSetupRoute) },
                    dropUnlessResumed { navController.navigateToTopLevel(TopLevelDestination.Waiting) },
                    dropUnlessResumed { navController.popBackStack() },
                )
            }
        }
    }
}

@Composable
private fun CableBottomBar(
    currentDestination: NavDestination?,
    onSelect: (TopLevelDestination) -> Unit,
    onReselect: (TopLevelDestination) -> Unit,
) {
    // Flat bar (PLAN §6.3: no shadows / tonal elevation).
    NavigationBar(tonalElevation = Tokens.Elevation.None) {
        TopLevelDestination.entries.forEach { destination ->
            val selected = currentDestination.isOn(destination)
            NavigationBarItem(
                selected = selected,
                onClick = { if (selected) onReselect(destination) else onSelect(destination) },
                icon = { Icon(painterResource(destination.icon), contentDescription = null) },
                label = { Text(stringResource(destination.label), style = MaterialTheme.typography.labelLarge) },
                alwaysShowLabel = true,
                modifier = Modifier.testTag(destination.testTag),
            )
        }
    }
}

/** [dropUnlessResumed] for a callback with an argument: ignores a second tap while the screen changes. */
@Composable
private fun <T> dropUnlessResumedWith(block: (T) -> Unit): (T) -> Unit {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    return { value -> if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) block(value) }
}

private fun NavDestination?.isOn(destination: TopLevelDestination): Boolean =
    this?.hierarchy?.any { node ->
        node.hasRoute(destination.route::class) || destination.subScreens.any { node.hasRoute(it) }
    } == true

/** Screens on a tab's stack above its first screen: the tab stays highlighted on them. */
private val TopLevelDestination.subScreens: List<KClass<*>>
    get() =
        when (this) {
            TopLevelDestination.Search -> {
                listOf(CustomerRoute::class, CollectRoute::class, CollectDoneRoute::class, SettingsRoute::class)
            }

            TopLevelDestination.Today, TopLevelDestination.Waiting -> {
                emptyList()
            }
        }

/** Bottom-bar navigation: one copy of each tab, state kept when switching back. */
private fun NavHostController.navigateToTopLevel(destination: TopLevelDestination) {
    navigate(destination.route) {
        popUpTo(graph.findStartDestination().id) { saveState = true }
        launchSingleTop = true
        restoreState = true
    }
}
