/**
 * Test support for the payment services' tests (not exported from the package; no side effects,
 * so the isolation discovery can import it). Seeds customers and invoices the way the billing run
 * will (PLAN §8.2 / §8.5, as T-023's `ledger.test.ts` reference does), and reads a customer's rows
 * back into T-041's `LedgerState` for `checkLedger`.
 */
import {
  adjustments,
  allocations,
  customerBalances,
  customers,
  invoices,
  ledgerEntries,
  nextCounter,
  paymentReversals,
  payments,
  type Tx,
  uuidv7,
} from "@cb/db";
import {
  type AllocationRow,
  applyCredit,
  type CreditSource,
  type LedgerState,
  toPaise,
  unallocatedRemainder,
} from "@cb/domain";
import { and, asc, eq, sql } from "drizzle-orm";
import { loadCustomerInvoices, lockCustomerBalance, openInvoicesOf } from "./ledger-io";

/** Inserts an active (or inactive) customer and returns its id. */
export async function insertCustomer(
  tx: Tx,
  operatorId: string,
  options: { status?: "active" | "inactive" } = {},
): Promise<string> {
  const id = uuidv7();
  await tx.insert(customers).values({
    id,
    operatorId,
    customerCode: `T-${id.slice(-8)}`,
    name: "Test customer",
    status: options.status ?? "active",
  });
  return id;
}

async function allocationRowsOf(tx: Tx, customerId: string): Promise<AllocationRow[]> {
  const rows = await tx
    .select()
    .from(allocations)
    .where(eq(allocations.customerId, customerId))
    .orderBy(asc(allocations.createdAt), asc(allocations.id));
  return rows.map((r) => ({
    id: r.id,
    invoiceId: r.invoiceId,
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    amountPaise: toPaise(r.amountPaise),
    reversalId: r.reversalId,
  }));
}

/**
 * Issues a regular invoice the way the billing run does (PLAN §8.2): lock, invoice with the
 * opening balance, ledger += charges, balance += charges, then apply available credit (§8.5).
 * No invoice lines (not needed by the money path). Returns the invoice id.
 */
export async function issueInvoice(
  tx: Tx,
  operatorId: string,
  customerId: string,
  input: { period: string; chargesPaise: number },
): Promise<string> {
  const before = await lockCustomerBalance(tx, operatorId, customerId);
  const id = uuidv7();
  const seq = await nextCounter(tx, operatorId, "invoice");
  await tx.insert(invoices).values({
    id,
    operatorId,
    customerId,
    period: input.period,
    invoiceNumber: `INV-${input.period.slice(2, 4)}${input.period.slice(5, 7)}-${String(seq).padStart(5, "0")}`,
    openingBalancePaise: before.balancePaise,
    chargesPaise: input.chargesPaise,
    totalDuePaise: before.balancePaise + input.chargesPaise,
  });
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId,
    customerId,
    type: "invoice",
    amountPaise: input.chargesPaise,
    invoiceId: id,
  });
  await tx
    .update(customerBalances)
    .set({ balancePaise: sql`${customerBalances.balancePaise} + ${input.chargesPaise}` })
    .where(eq(customerBalances.customerId, customerId));
  await applyAvailableCredit(tx, operatorId, customerId);
  return id;
}

/** PLAN §8.5 with T-041 `applyCredit`: payment remainders → oldest invoices; ledger unchanged. */
async function applyAvailableCredit(tx: Tx, operatorId: string, customerId: string) {
  const rows = await allocationRowsOf(tx, customerId);
  const paymentRows = await tx
    .select({ p: payments, reversalId: paymentReversals.id })
    .from(payments)
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(eq(payments.customerId, customerId));
  const sources: CreditSource[] = paymentRows
    .map(({ p, reversalId }) => ({
      sourceType: "payment" as const,
      sourceId: p.id,
      at: p.postedAt,
      availablePaise: unallocatedRemainder(
        { amountPaise: toPaise(p.amountPaise), reversed: reversalId !== null },
        rows.filter((r) => r.sourceId === p.id),
      ),
    }))
    .filter((s) => s.availablePaise > 0);
  const customerInvoices = await loadCustomerInvoices(tx, operatorId, customerId);
  const result = applyCredit(sources, openInvoicesOf(customerInvoices));
  if (!result.ok) throw new Error(`applyCredit: ${result.error.code}`);
  const outstanding = new Map(customerInvoices.map((i) => [i.id, i.outstandingPaise as number]));
  for (const a of result.value.allocations) {
    const after = (outstanding.get(a.invoiceId) ?? 0) - a.amountPaise;
    outstanding.set(a.invoiceId, after);
    await tx.insert(allocations).values({
      id: uuidv7(),
      operatorId,
      customerId,
      invoiceId: a.invoiceId,
      sourceType: "payment",
      paymentId: a.sourceId,
      kind: "credit_application",
      amountPaise: a.amountPaise,
      outstandingAfterPaise: after,
    });
  }
  await tx
    .update(customerBalances)
    .set({ creditPaise: sql`${customerBalances.creditPaise} - ${result.value.appliedPaise}` })
    .where(eq(customerBalances.customerId, customerId));
}

/** One customer's rows mapped onto T-041's `LedgerState` (as T-023's ledger.test.ts does). */
export async function readLedgerState(tx: Tx, customerId: string): Promise<LedgerState> {
  const invoiceRows = await tx.select().from(invoices).where(eq(invoices.customerId, customerId));
  const paymentRows = await tx
    .select({ p: payments, reversalId: paymentReversals.id })
    .from(payments)
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(eq(payments.customerId, customerId));
  const creditRows = await tx
    .select()
    .from(adjustments)
    .where(and(eq(adjustments.customerId, customerId), eq(adjustments.direction, "credit")));
  const entryRows = await tx
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.customerId, customerId))
    .orderBy(asc(ledgerEntries.seq));
  const [balance] = await tx
    .select()
    .from(customerBalances)
    .where(eq(customerBalances.customerId, customerId));
  return {
    invoices: invoiceRows.map((i) => ({ id: i.id, chargesPaise: toPaise(i.chargesPaise) })),
    payments: paymentRows.map(({ p, reversalId }) => ({
      id: p.id,
      amountPaise: toPaise(p.amountPaise),
      reversed: reversalId !== null,
    })),
    creditAdjustments: creditRows.map((c) => ({ id: c.id, amountPaise: toPaise(c.amountPaise) })),
    allocations: await allocationRowsOf(tx, customerId),
    ledgerEntries: entryRows.map((e) => ({ type: e.type, amountPaise: toPaise(e.amountPaise) })),
    balancePaise: toPaise(balance?.balancePaise ?? 0),
    creditPaise: toPaise(balance?.creditPaise ?? 0),
  };
}
