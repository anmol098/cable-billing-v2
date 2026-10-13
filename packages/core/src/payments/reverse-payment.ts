/**
 * `payments.reverse`: cancel a posted payment (T-046; PLAN §8.6; BR-13, RULE-20; FR-013).
 * Owner only (capability `payments.reverse`, D-16); blocked in read-only mode (D-13).
 *
 * ```text
 * payment must be in the tenant (else NOT_FOUND)
 * lock customer_balances (FOR UPDATE)
 * already reversed → CONFLICT (details.reason = already_reversed)
 * T-041 reverse(payment, all its allocation rows)     # posting + later credit application rows
 * insert payment_reversals (UNIQUE per payment: a concurrent second reversal → CONFLICT)
 * ledger(+amount), one negative allocation row per original (kind reversal, reversal_id,
 *   reverses_allocation_id, outstanding_after)
 * customer_balances: balance += amount, credit −= the payment's unallocated remainder
 * collection session (Android payments): totals −= amount
 * audit
 * ```
 *
 * Append-only: the payment, its allocations, ledger entry and receipt are never changed (the
 * database triggers refuse it); the receipt shows "Cancelled" because a reversal row exists.
 * Credit is not re-applied to the reopened invoices here (T-041 Q-B: at the next invoice).
 */
import { allocations, ledgerEntries, paymentReversals, payments, type Tx, uuidv7 } from "@cb/db";
import {
  addPaise,
  err,
  negatePaise,
  ok,
  type Paise,
  type Result,
  reverse,
  subtractPaise,
  toPaise,
} from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import { type CoreErrorCode, notFound, type ServiceError, serviceError } from "../errors/errors";
import {
  loadCustomerInvoices,
  lockCustomerBalance,
  oldestDuePeriod,
  openInvoicesOf,
  paymentAllocationRows,
  updateCollectionSession,
  writeCustomerBalance,
} from "./ledger-io";
import { toPaymentView } from "./stored";
import type { ReversalAllocationView, ReversePaymentResult } from "./types";

export const ReversePaymentInput = z.object({
  paymentId: z.uuid().transform((value) => value.toLowerCase()),
  /** Why (shown in the payment history and audit log). */
  reason: z.string().trim().min(1).max(500),
});

export type ReversePaymentCommand = z.output<typeof ReversePaymentInput>;

type ReverseError = ServiceError<CoreErrorCode>;

/**
 * The reversal algorithm (PLAN §8.6) inside the caller's tenant transaction. `reversePayment` is
 * the public entry point (Owner only, audit); this is exported for core's own tests only.
 */
export async function reversePaymentInTx(
  tx: Tx,
  actor: { readonly operatorId: string; readonly userId: string },
  command: ReversePaymentCommand,
  now: Date,
): Promise<Result<ReversePaymentResult, ReverseError>> {
  const { operatorId } = actor;
  const [payment] = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.operatorId, operatorId), eq(payments.id, command.paymentId)));
  if (!payment) return err(notFound());

  const before = await lockCustomerBalance(tx, operatorId, payment.customerId);
  const [existing] = await tx
    .select({ id: paymentReversals.id })
    .from(paymentReversals)
    .where(
      and(eq(paymentReversals.operatorId, operatorId), eq(paymentReversals.paymentId, payment.id)),
    );
  if (existing) {
    return err(
      serviceError("CONFLICT", "Payment is already reversed", { reason: "already_reversed" }),
    );
  }

  const amountPaise = toPaise(payment.amountPaise);
  const rows = await paymentAllocationRows(tx, operatorId, payment.id);
  const reversed = reverse({ id: payment.id, amountPaise, reversed: false }, rows);
  if (!reversed.ok) {
    if (reversed.error.code === "CONFLICT") {
      return err(
        serviceError("CONFLICT", "Payment is already reversed", { reason: "already_reversed" }),
      );
    }
    return err(reversed.error);
  }

  const reversalId = uuidv7();
  await tx.insert(paymentReversals).values({
    id: reversalId,
    operatorId,
    customerId: payment.customerId,
    paymentId: payment.id,
    reason: command.reason,
    actorId: actor.userId,
    at: now,
  });
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId,
    customerId: payment.customerId,
    type: "payment_reversal",
    amountPaise: reversed.value.ledgerDeltaPaise,
    paymentReversalId: reversalId,
    at: now,
  });

  const customerInvoices = await loadCustomerInvoices(tx, operatorId, payment.customerId);
  const outstanding = new Map<string, Paise>(
    customerInvoices.map((inv) => [inv.id, inv.outstandingPaise]),
  );
  const invoiceById = new Map(customerInvoices.map((inv) => [inv.id, inv]));
  const views: ReversalAllocationView[] = [];
  for (const row of reversed.value.allocations) {
    const invoice = invoiceById.get(row.invoiceId);
    const current = outstanding.get(row.invoiceId);
    if (!invoice || current === undefined) throw new Error("reversal row for an unknown invoice");
    const after = subtractPaise(current, row.amountPaise);
    outstanding.set(row.invoiceId, after);
    const id = uuidv7();
    await tx.insert(allocations).values({
      id,
      operatorId,
      customerId: payment.customerId,
      invoiceId: row.invoiceId,
      sourceType: "payment",
      paymentId: payment.id,
      kind: "reversal",
      amountPaise: row.amountPaise,
      outstandingAfterPaise: after,
      reversalId,
      reversesAllocationId: row.reversesAllocationId,
      createdAt: now,
    });
    views.push({
      id,
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      invoiceKind: invoice.kind,
      period: invoice.period,
      amountPaise: row.amountPaise,
      outstandingAfterPaise: after,
      reversesAllocationId: row.reversesAllocationId,
    });
  }

  const newBalance = addPaise(before.balancePaise, reversed.value.ledgerDeltaPaise);
  const credit = addPaise(before.creditPaise, reversed.value.creditDeltaPaise);
  if (credit < 0) {
    return err(
      serviceError("INVARIANT_VIOLATION", "Reversal would make the customer's credit negative"),
    );
  }
  const reopened = openInvoicesOf(
    customerInvoices.map((inv) => ({
      ...inv,
      outstandingPaise: outstanding.get(inv.id) ?? inv.outstandingPaise,
    })),
  );
  await writeCustomerBalance(tx, operatorId, payment.customerId, {
    balancePaise: newBalance,
    creditPaise: credit,
    oldestDuePeriod: oldestDuePeriod(reopened),
    now,
  });
  if (payment.source === "android" && payment.collectorId !== null) {
    const sessions = await updateCollectionSession(tx, {
      operatorId,
      collectorId: payment.collectorId,
      businessDate: payment.businessDate,
      method: payment.method,
      amountPaise,
      sign: -1,
      now,
    });
    if (sessions !== 1) throw new Error("reversed Android payment has no collection session");
  }

  return ok({
    reversal: {
      id: reversalId,
      paymentId: payment.id,
      customerId: payment.customerId,
      reason: command.reason,
      actorId: actor.userId,
      at: now,
    },
    payment: toPaymentView(payment),
    allocations: views,
    newBalance,
    credit,
    creditRemovedPaise: negatePaise(reversed.value.creditDeltaPaise),
  });
}

/**
 * Reverses a payment. Capability `payments.reverse` (Owner only). Errors: VALIDATION (input),
 * NOT_FOUND (payment not in the tenant), CONFLICT (`details.reason = "already_reversed"`, or
 * `details.retryable` for a lock failure), TENANT_READ_ONLY, INTERNAL.
 */
export const reversePayment = defineService({
  name: "payments.reverse",
  capability: "payments.reverse",
  input: ReversePaymentInput,
  async run({ ctx, input, tx, audit, log, now }) {
    const result = await reversePaymentInTx(
      tx,
      { operatorId: ctx.operatorId, userId: ctx.userId },
      input,
      now,
    );
    if (!result.ok) return result;
    const done = result.value;
    await audit.record({
      entityType: "payment",
      entityId: done.payment.id,
      before: {
        reversed: false,
        balance_paise: subtractPaise(done.newBalance, done.payment.amountPaise),
      },
      after: {
        reversed: true,
        reversal_id: done.reversal.id,
        reason: done.reversal.reason,
        amount_paise: done.payment.amountPaise,
        cancelled_allocations: done.allocations.map((a) => ({
          invoice_id: a.invoiceId,
          amount_paise: a.amountPaise,
        })),
        credit_removed_paise: done.creditRemovedPaise,
        balance_paise: done.newBalance,
        credit_paise: done.credit,
      },
    });
    log.info("payment.reversed", {
      payment_id: done.payment.id,
      reversal_id: done.reversal.id,
      customer_id: done.payment.customerId,
      amount_paise: done.payment.amountPaise,
      cancelled_allocation_count: done.allocations.length,
    });
    return ok(done);
  },
});
