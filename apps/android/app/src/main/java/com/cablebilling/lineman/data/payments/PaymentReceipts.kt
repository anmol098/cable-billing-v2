package com.cablebilling.lineman.data.payments

import com.cablebilling.lineman.data.auth.Session
import com.cablebilling.lineman.data.db.PaymentEntity
import com.cablebilling.lineman.data.db.PaymentState
import com.cablebilling.lineman.data.network.generated.Allocation
import com.cablebilling.lineman.data.network.generated.BillKind
import com.cablebilling.lineman.data.network.generated.PaymentMethod
import com.cablebilling.lineman.printing.receipt.ReceiptBalance
import com.cablebilling.lineman.printing.receipt.ReceiptBill
import com.cablebilling.lineman.printing.receipt.ReceiptMethod
import com.cablebilling.lineman.printing.receipt.ReceiptModel
import com.cablebilling.lineman.printing.receipt.ReceiptNumber
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.time.Instant
import java.time.LocalDate
import java.time.YearMonth

/**
 * Builds what a payment's receipt says (T-068's [ReceiptModel]) from the queue row: the permanent
 * `R-…` number once the office answered, else the provisional `P-…` reference with no guessed bills
 * or balance. Used by the Done screen's Print tile; T-069 uses it for the PDF and sharing.
 */
object PaymentReceipts {
    private val allocationsSerializer = ListSerializer(Allocation.serializer())

    /** The `allocations_json` column for a posted payment's allocations. */
    fun encodeAllocations(
        json: Json,
        allocations: List<Allocation>,
    ): String = json.encodeToString(allocationsSerializer, allocations)

    /** The stored allocations, or empty when there are none (or the column cannot be read). */
    fun decodeAllocations(
        json: Json,
        stored: String?,
    ): List<Allocation> =
        stored?.let { text -> runCatching { json.decodeFromString(allocationsSerializer, text) }.getOrNull() }
            ?: emptyList()

    /** The number to show and print: permanent once posted, provisional before. */
    fun number(payment: PaymentEntity): ReceiptNumber =
        payment.receiptNumber
            ?.takeIf { payment.state == PaymentState.SENT_TO_OFFICE }
            ?.let { ReceiptNumber.Permanent(it) }
            ?: ReceiptNumber.Provisional(payment.provisionalRef)

    /**
     * The receipt for [payment]. [session] gives the operator details and the lineman's name (the
     * collect flow only shows receipts of the signed-in lineman's own payments).
     */
    fun model(
        payment: PaymentEntity,
        session: Session,
        json: Json,
    ): ReceiptModel {
        val number = number(payment)
        val posted = number is ReceiptNumber.Permanent
        val balanceAfter =
            if (posted && payment.balanceAfterPaise != null && payment.creditAfterPaise != null) {
                ReceiptBalance.of(payment.balanceAfterPaise, payment.creditAfterPaise)
            } else {
                null
            }
        return ReceiptModel(
            operatorName = session.operator.name,
            operatorPhone = session.operator.officePhone,
            number = number,
            recordedAt = Instant.ofEpochMilli(payment.recordedAt),
            customerName = payment.customerName,
            customerCode = payment.customerCode,
            amountPaise = payment.amountPaise,
            method = if (payment.method == PaymentMethod.UPI) ReceiptMethod.Upi else ReceiptMethod.Cash,
            upiReference = payment.upiReference,
            linemanName = session.user.name,
            bills = if (posted) decodeAllocations(json, payment.allocationsJson).mapNotNull(::bill) else emptyList(),
            balanceAfter = balanceAfter,
            footer = session.operator.receiptFooter,
        )
    }

    private fun bill(allocation: Allocation): ReceiptBill? {
        val month =
            if (allocation.kind == BillKind.OPENING_BALANCE) {
                null
            } else {
                runCatching { YearMonth.from(LocalDate.parse(allocation.period)) }.getOrNull() ?: return null
            }
        return ReceiptBill(month = month, leftPaise = allocation.outstandingAfterPaise)
    }
}
