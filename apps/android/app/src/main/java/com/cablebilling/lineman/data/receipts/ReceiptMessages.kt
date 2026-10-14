package com.cablebilling.lineman.data.receipts

import android.content.Context
import android.content.res.Configuration
import com.cablebilling.designsystem.money.Rupees
import com.cablebilling.lineman.R
import com.cablebilling.lineman.printing.receipt.ReceiptLanguage
import com.cablebilling.lineman.printing.receipt.ReceiptModel
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The words that go to the customer with a receipt link (WhatsApp text, SMS body), in the receipt
 * language (the app's language, like the printed receipt): "Sharma Cable: Receipt R-2610-00045.
 * ₹500 received from Ramesh Kumar. See the receipt: https://…". It states what the receipt says and
 * nothing about delivery.
 */
@Singleton
class ReceiptMessages
    @Inject
    constructor(
        @param:ApplicationContext private val context: Context,
    ) {
        /** The message for [receipt] with its preview [link]. */
        fun withLink(
            receipt: ReceiptModel,
            link: String,
            language: ReceiptLanguage = ReceiptLanguage.current(),
        ): String = text(template(language), receipt, link)

        private fun template(language: ReceiptLanguage): String {
            val config = Configuration(context.resources.configuration)
            config.setLocale(language.locale)
            return context.createConfigurationContext(config).resources.getString(R.string.mobile_receipt_message_text)
        }

        companion object {
            /** Fills `mobile_receipt_message_text` (`%1$s` operator … `%5$s` link). Latin digits. */
            fun text(
                template: String,
                receipt: ReceiptModel,
                link: String,
            ): String =
                String.format(
                    Locale.ROOT,
                    template,
                    receipt.operatorName,
                    receipt.number.text,
                    Rupees.format(receipt.amountPaise),
                    receipt.customerName,
                    link,
                )
        }
    }
