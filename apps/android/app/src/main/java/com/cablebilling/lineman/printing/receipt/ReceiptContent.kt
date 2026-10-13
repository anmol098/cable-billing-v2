package com.cablebilling.lineman.printing.receipt

import com.cablebilling.designsystem.money.Rupees
import java.time.Instant
import java.util.Locale

/**
 * Turns a [ReceiptModel] (or the printer test page) into [ReceiptDocument] lines in one language
 * (PLAN §11.8 "Receipt layout"):
 *
 * operator name + phone, "Receipt", receipt no. (temporary note for a `P-…` number), date and time
 * (IST), customer + code, the amount large, method (+ UPI ref), which bills were paid, the balance
 * after the payment, the lineman, the operator's footer. Nothing here says "tax invoice" (B-019).
 */
object ReceiptContent {
    fun receipt(
        model: ReceiptModel,
        strings: ReceiptStrings,
    ): ReceiptDocument {
        val lines = mutableListOf<ReceiptLine>()
        lines += ReceiptLine.Text(model.operatorName, ReceiptTextStyle.Title, ReceiptAlign.Center)
        model.operatorPhone?.takeIf { it.isNotBlank() }?.let { phone ->
            lines += ReceiptLine.Text(strings.phone.fill(phone), ReceiptTextStyle.Body, ReceiptAlign.Center)
        }
        lines += ReceiptLine.Text(strings.title, ReceiptTextStyle.Strong, ReceiptAlign.Center)
        lines += ReceiptLine.Rule

        lines += ReceiptLine.Field(strings.number, model.number.text)
        if (model.number is ReceiptNumber.Provisional) {
            lines += ReceiptLine.Text(strings.temporary, ReceiptTextStyle.Small)
        }
        lines += ReceiptLine.Field(strings.date, dateTime(model.recordedAt, strings))
        lines += ReceiptLine.Rule

        lines += ReceiptLine.Field(strings.customer, model.customerName)
        lines += ReceiptLine.Field(strings.code, model.customerCode)
        lines += ReceiptLine.Rule

        lines += ReceiptLine.Amount(Rupees.format(model.amountPaise))
        val method =
            when (model.method) {
                ReceiptMethod.Cash -> strings.cash
                ReceiptMethod.Upi -> strings.upi
            }
        lines += ReceiptLine.Text(method, ReceiptTextStyle.Strong, ReceiptAlign.Center)
        model.upiReference?.takeIf { model.method == ReceiptMethod.Upi && it.isNotBlank() }?.let { ref ->
            lines += ReceiptLine.Field(strings.upiRef, ref)
        }

        if (model.bills.isNotEmpty() || model.balanceAfter != null) {
            lines += ReceiptLine.Rule
            model.bills.forEach { bill -> lines += ReceiptLine.Text(billText(bill, strings)) }
            model.balanceAfter?.let { lines += balanceLine(it, strings) }
        }

        lines += ReceiptLine.Rule
        lines += ReceiptLine.Field(strings.lineman, model.linemanName)
        model.footer?.takeIf { it.isNotBlank() }?.let { footer ->
            lines += ReceiptLine.Text(footer, ReceiptTextStyle.Small, ReceiptAlign.Center)
        }
        return ReceiptDocument(lines)
    }

    /**
     * The test page (printer setup): Hindi and English sample words in both fonts, a sample amount,
     * the printer's name and the time, so one print shows whether Hindi comes out readable.
     */
    fun testPage(
        printerName: String,
        printedAt: Instant,
        strings: ReceiptStrings,
    ): ReceiptDocument =
        ReceiptDocument(
            listOf(
                ReceiptLine.Text(strings.testTitle, ReceiptTextStyle.Title, ReceiptAlign.Center),
                ReceiptLine.Rule,
                ReceiptLine.Text(strings.testHindiSample),
                ReceiptLine.Text(strings.testEnglishSample),
                ReceiptLine.Amount(Rupees.format(SAMPLE_AMOUNT_PAISE)),
                ReceiptLine.Rule,
                ReceiptLine.Field(strings.testPrinter, printerName),
                ReceiptLine.Field(strings.date, dateTime(printedAt, strings)),
                ReceiptLine.Rule,
                ReceiptLine.Text(strings.testReadable, ReceiptTextStyle.Body, ReceiptAlign.Center),
            ),
        )

    /** ₹1,23,456: shows Indian grouping on the test page. */
    const val SAMPLE_AMOUNT_PAISE: Long = 12_345_600L

    /** `12 अक्टू 2026, 4:05 PM`. */
    fun dateTime(
        instant: Instant,
        strings: ReceiptStrings,
    ): String {
        val time = ReceiptDates.time(instant)
        val clock = (if (time.afterNoon) strings.timePm else strings.timeAm).fill(time.text)
        return "${ReceiptDates.date(instant, strings.language)}, $clock"
    }

    private fun billText(
        bill: ReceiptBill,
        strings: ReceiptStrings,
    ): String {
        val month = bill.month
        return when {
            month == null && bill.leftPaise <= 0 -> strings.oldDuePaid
            month == null -> strings.oldDueLeft.fill(Rupees.format(bill.leftPaise))
            bill.leftPaise <= 0 -> strings.billPaid.fill(ReceiptDates.month(month, strings.language))
            else -> strings.billLeft.fill(ReceiptDates.month(month, strings.language), Rupees.format(bill.leftPaise))
        }
    }

    private fun balanceLine(
        balance: ReceiptBalance,
        strings: ReceiptStrings,
    ): ReceiptLine =
        when (balance) {
            is ReceiptBalance.Due -> ReceiptLine.Field(strings.dueNow, Rupees.format(balance.paise))
            is ReceiptBalance.Credit -> ReceiptLine.Field(strings.creditNow, Rupees.format(balance.paise))
            ReceiptBalance.Clear -> ReceiptLine.Text(strings.nothingDue, ReceiptTextStyle.Strong)
        }

    /** Fills `%1$s`-style placeholders (Android string format) with Latin digits. */
    private fun String.fill(vararg args: String): String = String.format(Locale.ROOT, this, *args)
}
