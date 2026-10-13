/**
 * Reads and writes of one customer's money rows, shared by posting and reversal (T-046).
 * Not exported from the package: services use these inside their own transaction, after taking
 * the customer's balance row lock.
 *
 * - The money arithmetic is T-041's (`invoiceOutstanding`, `allocate`, `reverse`): nothing here
 *   re-implements it.
 * - Every query names `operator_id` explicitly as well (RLS already limits the rows) so the
 *   `(operator_id, …)` indexes are used.
 */
import {
  allocations,
  collectionSessions,
  customerBalances,
  type InvoiceKind,
  type InvoiceStatus,
  invoices,
  type PaymentMethod,
  type Tx,
  uuidv7,
} from "@cb/db";
import {
  type AllocationRow,
  invoiceOutstanding,
  type OpenInvoice,
  type Paise,
  type Period,
  period,
  toPaise,
} from "@cb/domain";
import { and, asc, eq, sql } from "drizzle-orm";

export interface LockedBalance {
  readonly balancePaise: Paise;
  readonly creditPaise: Paise;
}

/**
 * Locks the customer's `customer_balances` row (creating it at zero first if needed) and returns
 * it. The lock (`SELECT … FOR UPDATE`) serialises every money change of the customer (PLAN §8.4)
 * until the transaction ends. Under READ COMMITTED, every statement after it sees what the
 * previous lock holder committed.
 */
export async function lockCustomerBalance(
  tx: Tx,
  operatorId: string,
  customerId: string,
): Promise<LockedBalance> {
  await tx.insert(customerBalances).values({ customerId, operatorId }).onConflictDoNothing();
  const [row] = await tx
    .select({
      balancePaise: customerBalances.balancePaise,
      creditPaise: customerBalances.creditPaise,
    })
    .from(customerBalances)
    .where(
      and(eq(customerBalances.operatorId, operatorId), eq(customerBalances.customerId, customerId)),
    )
    .for("update");
  if (!row) throw new Error("customer balance row missing after insert");
  return { balancePaise: toPaise(row.balancePaise), creditPaise: toPaise(row.creditPaise) };
}

/** One of the customer's invoices with its outstanding (charges − Σ allocation rows, T-041). */
export interface CustomerInvoice {
  readonly id: string;
  readonly period: Period;
  readonly invoiceNumber: string;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly chargesPaise: Paise;
  readonly outstandingPaise: Paise;
}

/** Every invoice of the customer with its current outstanding. Call after the balance lock. */
export async function loadCustomerInvoices(
  tx: Tx,
  operatorId: string,
  customerId: string,
): Promise<CustomerInvoice[]> {
  const invoiceRows = await tx
    .select({
      id: invoices.id,
      period: invoices.period,
      invoiceNumber: invoices.invoiceNumber,
      kind: invoices.kind,
      status: invoices.status,
      chargesPaise: invoices.chargesPaise,
    })
    .from(invoices)
    .where(and(eq(invoices.operatorId, operatorId), eq(invoices.customerId, customerId)));
  const rows = await tx
    .select({ invoiceId: allocations.invoiceId, amountPaise: allocations.amountPaise })
    .from(allocations)
    .where(and(eq(allocations.operatorId, operatorId), eq(allocations.customerId, customerId)));
  const byInvoice = new Map<string, { amountPaise: Paise }[]>();
  for (const row of rows) {
    const list = byInvoice.get(row.invoiceId) ?? [];
    list.push({ amountPaise: toPaise(row.amountPaise) });
    byInvoice.set(row.invoiceId, list);
  }
  return invoiceRows.map((inv) => {
    const chargesPaise = toPaise(inv.chargesPaise);
    return {
      id: inv.id,
      period: period(inv.period),
      invoiceNumber: inv.invoiceNumber,
      kind: inv.kind,
      status: inv.status,
      chargesPaise,
      outstandingPaise: invoiceOutstanding(chargesPaise, byInvoice.get(inv.id) ?? []),
    };
  });
}

/**
 * The invoices a payment may pay (T-041 `OpenInvoice`): issued invoices only. A void invoice is
 * not owed (no flow voids invoices yet; T-023 open question).
 */
export function openInvoicesOf(list: readonly CustomerInvoice[]): OpenInvoice[] {
  return list
    .filter((inv) => inv.status === "issued")
    .map((inv) => ({ id: inv.id, period: inv.period, outstandingPaise: inv.outstandingPaise }));
}

/** The oldest period still owed (`customer_balances.oldest_due_period`), or null. */
export function oldestDuePeriod(open: readonly OpenInvoice[]): Period | null {
  let oldest: Period | null = null;
  for (const inv of open) {
    if (inv.outstandingPaise > 0 && (oldest === null || inv.period < oldest)) oldest = inv.period;
  }
  return oldest;
}

/** Writes the customer's read model (in the transaction holding its lock). */
export async function writeCustomerBalance(
  tx: Tx,
  operatorId: string,
  customerId: string,
  values: {
    balancePaise: Paise;
    creditPaise: Paise;
    oldestDuePeriod: Period | null;
    now: Date;
  },
): Promise<void> {
  await tx
    .update(customerBalances)
    .set({
      balancePaise: values.balancePaise,
      creditPaise: values.creditPaise,
      oldestDuePeriod: values.oldestDuePeriod,
      updatedAt: values.now,
    })
    .where(
      and(eq(customerBalances.operatorId, operatorId), eq(customerBalances.customerId, customerId)),
    );
}

/** All allocation rows whose source is this payment, as T-041 `AllocationRow`s. */
export async function paymentAllocationRows(
  tx: Tx,
  operatorId: string,
  paymentId: string,
): Promise<AllocationRow[]> {
  const rows = await tx
    .select()
    .from(allocations)
    .where(and(eq(allocations.operatorId, operatorId), eq(allocations.paymentId, paymentId)))
    .orderBy(asc(allocations.id));
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
 * Adds (`sign = 1`) or removes (`sign = -1`) one payment in its collector's collection session
 * (PLAN §8.7: running totals of the day's payments that are not reversed). The session is created
 * on the first payment (`INSERT … ON CONFLICT DO NOTHING`).
 */
export async function updateCollectionSession(
  tx: Tx,
  input: {
    operatorId: string;
    collectorId: string;
    businessDate: string;
    method: PaymentMethod;
    amountPaise: Paise;
    sign: 1 | -1;
    now: Date;
  },
): Promise<number> {
  const { operatorId, collectorId, businessDate } = input;
  if (input.sign === 1) {
    await tx
      .insert(collectionSessions)
      .values({ id: uuidv7(), operatorId, collectorId, businessDate })
      .onConflictDoNothing({
        target: [
          collectionSessions.operatorId,
          collectionSessions.collectorId,
          collectionSessions.businessDate,
        ],
      });
  }
  const delta = input.sign * input.amountPaise;
  const cash = input.method === "cash" ? delta : 0;
  const upi = input.method === "upi" ? delta : 0;
  const updated = await tx
    .update(collectionSessions)
    .set({
      cashExpectedPaise: sql`${collectionSessions.cashExpectedPaise} + ${cash}`,
      upiTotalPaise: sql`${collectionSessions.upiTotalPaise} + ${upi}`,
      paymentCount: sql`${collectionSessions.paymentCount} + ${input.sign}`,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(collectionSessions.operatorId, operatorId),
        eq(collectionSessions.collectorId, collectorId),
        eq(collectionSessions.businessDate, businessDate),
      ),
    )
    .returning({ id: collectionSessions.id });
  return updated.length;
}
