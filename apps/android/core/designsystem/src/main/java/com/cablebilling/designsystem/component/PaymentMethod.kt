package com.cablebilling.designsystem.component

import androidx.annotation.DrawableRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import com.cablebilling.designsystem.R
import com.cablebilling.designsystem.theme.CableTheme

/** How the customer paid. Each has a fixed icon and colour (PLAN §2.2 rule 4). */
enum class PaymentMethod(
    @param:DrawableRes val icon: Int,
) {
    /** Banknote, `semantic.cash` (green). */
    Cash(R.drawable.ic_cb_cash),

    /** QR code, `semantic.upi` (blue). */
    Upi(R.drawable.ic_cb_upi),
}

/** The fixed colour of a [PaymentMethod]. */
val PaymentMethod.color: Color
    @Composable get() =
        when (this) {
            PaymentMethod.Cash -> CableTheme.semanticColors.cash
            PaymentMethod.Upi -> CableTheme.semanticColors.upi
        }
