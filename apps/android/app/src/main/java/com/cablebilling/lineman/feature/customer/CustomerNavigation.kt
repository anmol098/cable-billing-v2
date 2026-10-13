package com.cablebilling.lineman.feature.customer

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri
import androidx.navigation.NavController
import kotlinx.serialization.Serializable

/** Type-safe route of the customer screen (PLAN §11.2: Search → Customer → Amount …). */
@Serializable
data class CustomerRoute(
    val customerId: String,
)

/** Opens the customer screen above the search home. */
fun NavController.navigateToCustomer(customerId: String) {
    navigate(CustomerRoute(customerId)) { launchSingleTop = true }
}

/** Tap-to-call: the phone's dialer with the number filled in (ACTION_DIAL: no CALL_PHONE permission). */
object CustomerDialer {
    fun intent(phone: String): Intent {
        val digits = phone.filter { it.isDigit() || it == '+' }
        return Intent(Intent.ACTION_DIAL).apply {
            if (digits.isNotEmpty()) data = "tel:$digits".toUri()
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /** Returns false if the phone has no dialer (some tablets). */
    fun dial(
        context: Context,
        phone: String,
    ): Boolean =
        try {
            context.startActivity(intent(phone))
            true
        } catch (ignored: ActivityNotFoundException) {
            false
        }
}
