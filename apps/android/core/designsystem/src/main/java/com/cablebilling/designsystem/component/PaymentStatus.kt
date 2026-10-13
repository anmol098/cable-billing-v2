package com.cablebilling.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.theme.CableTheme

/**
 * Where a payment is, said honestly (BR-11/BR-12, PLAN §2.2 rule 8). Each has a fixed icon and colour.
 */
enum class PaymentStatus(
    @param:DrawableRes val icon: Int,
) {
    /** "फ़ोन में सेव / Saved on phone" (`common_saved_on_phone`): clock, amber. Not yet at the office. */
    SavedOnPhone(R.drawable.ic_cb_pending),

    /** "ऑफिस पहुँच गया / Sent to office" (`common_sent_to_office`): tick, green. The server confirmed it. */
    Sent(R.drawable.ic_cb_success),

    /** "दिक्कत / Problem" (`common_problem`): warning triangle, red. The office has to look at it. */
    NeedsHelp(R.drawable.ic_cb_danger),
}

/** The fixed colour of a [PaymentStatus]. */
val PaymentStatus.color: Color
    @Composable get() =
        when (this) {
            PaymentStatus.SavedOnPhone -> CableTheme.semanticColors.pending
            PaymentStatus.Sent -> CableTheme.semanticColors.success
            PaymentStatus.NeedsHelp -> CableTheme.semanticColors.danger
        }
