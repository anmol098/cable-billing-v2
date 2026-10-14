/**
 * Core → contract mappers for the roster and the customer detail (T-060). camelCase core values
 * become the contract's snake_case shapes; instants are ISO-8601 UTC strings.
 */
import type { RosterCustomer } from "@cb/contracts";
import type { RosterOpenBill, RosterRecentPayment, RosterRow } from "@cb/core";

/** Core `RosterRow` → contract `RosterCustomer`. */
export function rosterCustomerWire(row: RosterRow): RosterCustomer {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    phone: row.phone,
    alt_phone: row.altPhone,
    address: row.address,
    area: row.area === null ? null : { id: row.area.id, name: row.area.name },
    active: row.active,
    connections: row.connections.map((c) => ({ vc_number: c.vcNumber, status: c.status })),
    balance_paise: row.balancePaise,
    credit_paise: row.creditPaise,
    open_bills: {
      count: row.openBills.count,
      outstanding_paise: row.openBills.outstandingPaise,
      oldest_period: row.openBills.oldestPeriod,
    },
    updated_at: row.updatedAt.toISOString(),
  };
}

export function openBillWire(bill: RosterOpenBill) {
  return {
    invoice_id: bill.invoiceId,
    invoice_number: bill.invoiceNumber,
    kind: bill.kind,
    period: bill.period,
    charges_paise: bill.chargesPaise,
    outstanding_paise: bill.outstandingPaise,
  };
}

export function recentPaymentWire(payment: RosterRecentPayment) {
  return {
    payment_id: payment.paymentId,
    amount_paise: payment.amountPaise,
    method: payment.method,
    recorded_at: payment.recordedAt.toISOString(),
    posted_at: payment.postedAt.toISOString(),
    receipt_number: payment.receiptNumber,
    provisional_ref: payment.provisionalRef,
    collected_by_name: payment.collectedByName,
    reversed: payment.reversed,
  };
}
