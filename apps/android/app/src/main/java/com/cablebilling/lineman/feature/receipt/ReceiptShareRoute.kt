package com.cablebilling.lineman.feature.receipt

import androidx.lifecycle.compose.dropUnlessResumed
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import androidx.navigation.toRoute
import kotlinx.serialization.Serializable

/**
 * Giving a saved payment's receipt by WhatsApp or SMS (PLAN §11.7). Opened from the Done screen's
 * tiles; later screens (e.g. Today's payment rows) can open it for any payment on the phone.
 */
@Serializable
data class ReceiptShareRoute(
    val paymentId: String,
    val channel: ShareChannel,
)

/** Registers [ReceiptShareRoute] in the app's NavHost (CableApp). Back / Done return to the screen below. */
fun NavGraphBuilder.receiptShareScreen(navController: NavController) {
    composable<ReceiptShareRoute> { entry ->
        val route = entry.toRoute<ReceiptShareRoute>()
        ReceiptShareScreen(
            paymentId = route.paymentId,
            channel = route.channel,
            onClose = dropUnlessResumed { navController.popBackStack() },
        )
    }
}

fun NavController.navigateToReceiptShare(
    paymentId: String,
    channel: ShareChannel,
) {
    navigate(ReceiptShareRoute(paymentId, channel)) { launchSingleTop = true }
}
