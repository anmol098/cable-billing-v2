package com.cablebilling.lineman.printing.receipt

import java.time.Instant
import java.time.YearMonth

/**
 * What a receipt says (FR-017, PLAN §11.8 "Receipt layout"), independent of how it is shown: the
 * thermal printer ([com.cablebilling.lineman.printing.render.ReceiptRenderer]) and the PDF / share
 * flow (T-069) both start from this.
 *
 * Money is integer paise (CLAUDE.md); it is formatted with Indian grouping only when drawn. Times are
 * UTC instants; the receipt shows them in Asia/Kolkata. Names and codes are shown as given (a name
 * typed in Devanagari prints in Devanagari, whatever the receipt language).
 *
 * The receipt never calls itself a tax invoice (B-019).
 */
data class ReceiptModel(
    /** Operator's business name (`OperatorInfo.name`). */
    val operatorName: String,
    /** Office phone for the customer (`OperatorInfo.office_phone`); null = not printed. */
    val operatorPhone: String?,
    /** Permanent `R-…` number from the office, or the phone's provisional `P-…` reference. */
    val number: ReceiptNumber,
    /** When the lineman recorded the payment (UTC; shown in IST). */
    val recordedAt: Instant,
    val customerName: String,
    /** Customer code, e.g. "C-0045". */
    val customerCode: String,
    /** Amount received, in paise (> 0). */
    val amountPaise: Long,
    val method: ReceiptMethod,
    /** UPI reference typed by the lineman (UPI only, optional). */
    val upiReference: String? = null,
    /** Lineman who took the money (`session.user.name`). */
    val linemanName: String,
    /**
     * Which bills the money went to, oldest first (from the server's `allocations`). Empty while the
     * payment is only on the phone: the office decides the split, so nothing is guessed.
     */
    val bills: List<ReceiptBill> = emptyList(),
    /** The customer's position after this payment; null = not known yet (provisional receipt). */
    val balanceAfter: ReceiptBalance? = null,
    /** Operator's footer text (`OperatorInfo.receipt_footer`); null = none. */
    val footer: String? = null,
)

/** The receipt's number. Only the office gives permanent numbers (PLAN §8.4). */
sealed interface ReceiptNumber {
    val text: String

    /** `R-2610-00045`: the payment is at the office. */
    data class Permanent(
        override val text: String,
    ) : ReceiptNumber

    /** `P-K7Q-0012`: saved on the phone; the receipt is marked temporary. */
    data class Provisional(
        override val text: String,
    ) : ReceiptNumber
}

enum class ReceiptMethod { Cash, Upi }

/**
 * One line of the allocation summary: "Oct bill paid", "Nov bill: ₹50 left" (PLAN §11.8).
 * [month] is null for old dues (opening balance, `BillKind.OPENING_BALANCE`).
 */
data class ReceiptBill(
    val month: YearMonth?,
    /** What is still unpaid on that bill after this payment, in paise (0 = fully paid). */
    val leftPaise: Long,
)

/** Balance after the payment: what is still due, or the credit (advance) left over. */
sealed interface ReceiptBalance {
    data class Due(
        val paise: Long,
    ) : ReceiptBalance

    data class Credit(
        val paise: Long,
    ) : ReceiptBalance

    data object Clear : ReceiptBalance

    companion object {
        /**
         * From the server's `balance_after_paise` / `credit_after_paise` (both ≥ 0, PRD §13.3).
         * Due wins if both are set (it cannot happen: credit is only left when nothing is due).
         */
        fun of(
            balanceAfterPaise: Long,
            creditAfterPaise: Long,
        ): ReceiptBalance =
            when {
                balanceAfterPaise > 0 -> Due(balanceAfterPaise)
                creditAfterPaise > 0 -> Credit(creditAfterPaise)
                else -> Clear
            }
    }
}
