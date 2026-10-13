package com.cablebilling.lineman.feature.collect

/**
 * Receipt actions other than Print, wired by T-069 (WhatsApp, SMS). Null = the tile is shown but
 * not usable yet. Payment save and receipt actions are independent (RULE-18).
 */
data class ReceiptShareActions(
    val onWhatsApp: (() -> Unit)? = null,
    val onSms: (() -> Unit)? = null,
)
