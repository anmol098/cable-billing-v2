package com.cablebilling.lineman.feature.receipt

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent

/**
 * Opens another app for a receipt: tries the candidate intents in order (e.g. WhatsApp, then
 * WhatsApp Business) and returns true when one opened. "Opened" is all the app can know (RULE-19).
 */
fun interface ShareLauncher {
    fun launch(candidates: List<Intent>): Boolean
}

/** [ShareLauncher] with `startActivity` on the screen's [context] (an Activity). */
class ActivityShareLauncher(
    private val context: Context,
) : ShareLauncher {
    override fun launch(candidates: List<Intent>): Boolean =
        candidates.any { intent ->
            try {
                context.startActivity(intent)
                true
            } catch (ignored: ActivityNotFoundException) {
                false // Not installed (or no app for this intent): try the next one.
            } catch (ignored: SecurityException) {
                false // The app refused to be opened from here.
            }
        }
}
