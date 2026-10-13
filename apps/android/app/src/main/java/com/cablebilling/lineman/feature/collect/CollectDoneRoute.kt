package com.cablebilling.lineman.feature.collect

import androidx.navigation.NavController
import com.cablebilling.lineman.ui.navigation.CollectRoute
import kotlinx.serialization.Serializable

/**
 * The Done screen of one saved payment (PLAN §11.2: … → Confirm → Done). It replaces the collect
 * flow on the back stack, so Back from Done returns to the customer and can never reach Save again.
 */
@Serializable
data class CollectDoneRoute(
    val paymentId: String,
)

/** After Save committed: show Done and drop the collect flow ([CollectRoute]) from the back stack. */
fun NavController.navigateToCollectDone(paymentId: String) {
    navigate(CollectDoneRoute(paymentId)) {
        popUpTo<CollectRoute> { inclusive = true }
        launchSingleTop = true
    }
}
