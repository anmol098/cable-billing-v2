/**
 * Reading a posted payment back (T-046): the replay of an idempotency key returns exactly what
 * the first posting returned, from the stored rows (`payments` snapshots, `posting` allocations
 * with `outstanding_after_paise`, the receipt). Not exported from the package.
 */
import { allocations, invoices, paymentReversals, payments, receipts, type Tx } from "@cb/db";
import { businessDate, type Paise, period, subtractPaise, sumPaise, toPaise } from "@cb/domain";
import { and, asc, eq } from "drizzle-orm";
import type { PaymentAllocationView, PaymentView, ReceiptView } from "./types";

type PaymentRow = typeof payments.$inferSelect;

export function toPaymentView(row: PaymentRow): PaymentView {
  return {
    id: row.id,
    customerId: row.customerId,
    amountPaise: toPaise(row.amountPaise),
    method: row.method,
    upiReference: row.upiReference,
    notes: row.notes,
    collectorId: row.collectorId,
    deviceId: row.deviceId,
    source: row.source,
    recordedAt: row.recordedAt,
    postedAt: row.postedAt,
    businessDate: businessDate(row.businessDate),
    reviewStatus: row.reviewStatus,
    reviewReason: row.reviewReason,
  };
}

/** A payment with what a replay needs. */
export interface StoredPayment {
  readonly row: PaymentRow;
  readonly receipt: ReceiptView | null;
  readonly reversed: boolean;
}

/** The tenant's payment with this id (RLS: another tenant's id is simply not found). */
export async function findStoredPayment(
  tx: Tx,
  operatorId: string,
  paymentId: string,
): Promise<StoredPayment | undefined> {
  const [found] = await tx
    .select({ payment: payments, receipt: receipts, reversalId: paymentReversals.id })
    .from(payments)
    .leftJoin(
      receipts,
      and(eq(receipts.operatorId, payments.operatorId), eq(receipts.paymentId, payments.id)),
    )
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(and(eq(payments.operatorId, operatorId), eq(payments.id, paymentId)));
  if (!found) return undefined;
  return {
    row: found.payment,
    receipt: found.receipt
      ? {
          id: found.receipt.id,
          receiptNumber: found.receipt.receiptNumber,
          provisionalRef: found.receipt.provisionalRef,
          issuedAt: found.receipt.issuedAt,
        }
      : null,
    reversed: found.reversalId !== null,
  };
}

/** The payment's own `posting` allocations with invoice details, oldest bill first (§8.4 order). */
export async function loadPostingAllocations(
  tx: Tx,
  operatorId: string,
  paymentId: string,
): Promise<PaymentAllocationView[]> {
  const rows = await tx
    .select({
      id: allocations.id,
      invoiceId: allocations.invoiceId,
      amountPaise: allocations.amountPaise,
      outstandingAfterPaise: allocations.outstandingAfterPaise,
      invoiceNumber: invoices.invoiceNumber,
      invoiceKind: invoices.kind,
      period: invoices.period,
    })
    .from(allocations)
    .innerJoin(
      invoices,
      and(eq(invoices.operatorId, allocations.operatorId), eq(invoices.id, allocations.invoiceId)),
    )
    .where(
      and(
        eq(allocations.operatorId, operatorId),
        eq(allocations.paymentId, paymentId),
        eq(allocations.kind, "posting"),
      ),
    )
    .orderBy(asc(invoices.period), asc(invoices.id));
  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoiceNumber,
    invoiceKind: r.invoiceKind,
    period: period(r.period),
    amountPaise: toPaise(r.amountPaise),
    outstandingAfterPaise: toPaise(r.outstandingAfterPaise),
  }));
}

/** amount − Σ posting allocations: the part of the payment that became credit when posted. */
export function creditAddedOf(
  amountPaise: Paise,
  postingAllocations: readonly { amountPaise: Paise }[],
): Paise {
  return subtractPaise(amountPaise, sumPaise(postingAllocations.map((a) => a.amountPaise)));
}
