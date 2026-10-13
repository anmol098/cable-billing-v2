package com.cablebilling.lineman.feature.login

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.core.net.toUri

/**
 * "Call office": opens the phone's dialer with the operator's number filled in (ACTION_DIAL needs
 * no permission; the lineman presses call). Without a known number (a phone that never signed in)
 * it opens an empty dialer.
 */
object OfficeDialer {
    fun intent(phone: String?): Intent {
        val digits = phone?.filter { it.isDigit() || it == '+' }.orEmpty()
        return Intent(Intent.ACTION_DIAL).apply {
            if (digits.isNotEmpty()) data = "tel:$digits".toUri()
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
    }

    /** Returns false if the phone has no dialer (some tablets). */
    fun dial(
        context: Context,
        phone: String?,
    ): Boolean =
        try {
            context.startActivity(intent(phone))
            true
        } catch (ignored: ActivityNotFoundException) {
            false
        }
}
