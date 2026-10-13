package com.cablebilling.lineman.printing.receipt

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import com.cablebilling.lineman.R
import com.cablebilling.lineman.locale.AppLanguage
import java.util.Locale

/** The language a receipt is printed in. Hindi unless the app is in English (D-06). */
enum class ReceiptLanguage(
    val tag: String,
) {
    Hindi(AppLanguage.HINDI),
    English(AppLanguage.ENGLISH),
    ;

    val locale: Locale get() = Locale.forLanguageTag(tag)

    companion object {
        /** For an app language tag ("hi" / "en"). */
        fun forAppLanguage(language: String): ReceiptLanguage = if (language == AppLanguage.ENGLISH) English else Hindi

        /** The app's language now. */
        fun current(): ReceiptLanguage = forAppLanguage(AppLanguage.current())
    }
}

/**
 * Every word printed on a receipt or test page, in one language (`mobile_printer` strings). Plain
 * data, so [ReceiptContent] can be tested without resources. Load with [load].
 */
data class ReceiptStrings(
    val language: ReceiptLanguage,
    val title: String,
    /** "Phone: %1$s". */
    val phone: String,
    val number: String,
    val temporary: String,
    val date: String,
    /** "%1$s AM" / "%1$s PM". */
    val timeAm: String,
    val timePm: String,
    val customer: String,
    val code: String,
    val cash: String,
    val upi: String,
    val upiRef: String,
    /** "%1$s bill paid" (month). */
    val billPaid: String,
    /** "%1$s bill: %2$s left" (month, amount). */
    val billLeft: String,
    val oldDuePaid: String,
    /** "Old due: %1$s left" (amount). */
    val oldDueLeft: String,
    val dueNow: String,
    val creditNow: String,
    val nothingDue: String,
    val lineman: String,
    val testTitle: String,
    val testHindiSample: String,
    val testEnglishSample: String,
    val testReadable: String,
    val testPrinter: String,
) {
    companion object {
        /** The strings in [language], whatever the app language is. */
        fun load(
            context: Context,
            language: ReceiptLanguage,
        ): ReceiptStrings {
            val res = context.resourcesFor(language.locale)
            return ReceiptStrings(
                language = language,
                title = res.getString(R.string.mobile_printer_receipt_title),
                phone = res.getString(R.string.mobile_printer_receipt_phone),
                number = res.getString(R.string.mobile_printer_receipt_number),
                temporary = res.getString(R.string.mobile_printer_receipt_temporary),
                date = res.getString(R.string.mobile_printer_receipt_date),
                timeAm = res.getString(R.string.mobile_printer_receipt_time_am),
                timePm = res.getString(R.string.mobile_printer_receipt_time_pm),
                customer = res.getString(R.string.mobile_printer_receipt_customer),
                code = res.getString(R.string.mobile_printer_receipt_code),
                cash = res.getString(R.string.mobile_printer_receipt_cash),
                upi = res.getString(R.string.mobile_printer_receipt_upi),
                upiRef = res.getString(R.string.mobile_printer_receipt_upi_ref),
                billPaid = res.getString(R.string.mobile_printer_receipt_bill_paid),
                billLeft = res.getString(R.string.mobile_printer_receipt_bill_left),
                oldDuePaid = res.getString(R.string.mobile_printer_receipt_old_due_paid),
                oldDueLeft = res.getString(R.string.mobile_printer_receipt_old_due_left),
                dueNow = res.getString(R.string.mobile_printer_receipt_due_now),
                creditNow = res.getString(R.string.mobile_printer_receipt_credit_now),
                nothingDue = res.getString(R.string.mobile_printer_receipt_nothing_due),
                lineman = res.getString(R.string.mobile_printer_receipt_lineman),
                testTitle = res.getString(R.string.mobile_printer_test_title),
                testHindiSample = res.getString(R.string.mobile_printer_test_hindi_sample),
                testEnglishSample = res.getString(R.string.mobile_printer_test_english_sample),
                testReadable = res.getString(R.string.mobile_printer_test_readable),
                testPrinter = res.getString(R.string.mobile_printer_test_printer),
            )
        }

        private fun Context.resourcesFor(locale: Locale): Resources {
            val config = Configuration(resources.configuration)
            config.setLocale(locale)
            return createConfigurationContext(config).resources
        }
    }
}
