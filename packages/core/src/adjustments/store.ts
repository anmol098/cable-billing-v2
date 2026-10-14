/**
 * Reads and writes of adjustments inside a tenant transaction (T-045). Not exported from the
 * package. Every writer here expects the customer's `customer_balances` row lock to be held
 * (`lockCustomerBalance`, T-046): the connection services take it before their hooks run, and the
 * adjustment services take it first thing. So adjustments are serialised with payments,
 * reversals and the billing run (T-044's note).
 *
 * **Money rules** (T-041 Q-A / Q-B, T-044 notes; decisions in the T-045 completion notes):
 * - a **debit** adjustment is pending (`invoice_id` null) and reaches the ledger only through the
 *   next bill's charges (invariant 3 as written): no ledger entry now;
 * - a **credit** adjustment gets its `credit_adjustment` ledger entry (−amount) at once, becomes
 *   customer credit, and the customer's available credit is applied **at once**, oldest credit
 *   source → oldest open bill (T-041 `applyCredit`, PLAN §8.5, BRD §16 "apply available credit to
 *   oldest outstanding invoices by default").
 * - Issued invoices and their lines are never touched (D-14, RULE-10).
 */
import {
  adjustments,
  allocations,
  billingRunItems,
  billingRuns,
  invoiceLines,
  invoices,
  ledgerEntries,
  operators,
  parseOperatorSettings,
  type Tx,
  uuidv7,
} from "@cb/db";
import {
  type AdjustmentDirection,
  type AdjustmentSource,
  addPaise,
  applyCredit,
  type MidMonthStartPolicy,
  type Paise,
  type Period,
  type RentalChargeRecord,
  subtractPaise,
  toPaise,
  period as toPeriod,
} from "@cb/domain";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { AuditRecorder } from "../audit/audit";
import { loadCreditSources } from "../billing/customer";
import {
  loadCustomerInvoices,
  lockCustomerBalance,
  oldestDuePeriod,
  openInvoicesOf,
  writeCustomerBalance,
} from "../payments/ledger-io";
import type { AdjustmentView } from "./types";

export type AdjustmentRow = typeof adjustments.$inferSelect;

/** The operator's `mid_month_start_policy` (D-18; default `start_next_month`, T-021). */
export async function readMidMonthStartPolicy(
  tx: Tx,
  operatorId: string,
): Promise<MidMonthStartPolicy> {
  const [row] = await tx
    .select({ settings: operators.settings })
    .from(operators)
    .where(eq(operators.id, operatorId));
  return parseOperatorSettings(row?.settings ?? {}).mid_month_start_policy;
}

/**
 * The customer's **billed** months (T-034's definition): a regular bill exists for the month, or
 * the month's run already looked at the customer and decided (`created`, `already_exists`,
 * `skipped`). `after`: only months later than this one.
 */
export async function billedPeriodsOf(
  tx: Tx,
  operatorId: string,
  customerId: string,
  after: Period | null = null,
): Promise<Set<Period>> {
  const invoiceRows = await tx
    .selectDistinct({ period: invoices.period })
    .from(invoices)
    .where(
      and(
        eq(invoices.operatorId, operatorId),
        eq(invoices.customerId, customerId),
        eq(invoices.kind, "regular"),
        after === null ? undefined : gt(invoices.period, after),
      ),
    );
  const itemRows = await tx
    .selectDistinct({ period: billingRuns.period })
    .from(billingRunItems)
    .innerJoin(
      billingRuns,
      and(
        eq(billingRuns.operatorId, billingRunItems.operatorId),
        eq(billingRuns.id, billingRunItems.runId),
      ),
    )
    .where(
      and(
        eq(billingRunItems.operatorId, operatorId),
        eq(billingRunItems.customerId, customerId),
        inArray(billingRunItems.outcome, ["created", "already_exists", "skipped"]),
        after === null ? undefined : gt(billingRuns.period, after),
      ),
    );
  return new Set([...invoiceRows, ...itemRows].map((row) => toPeriod(row.period)));
}

/**
 * Every rent line and adjustment of one connection for the given months (T-042
 * `RentalChargeRecord`s): the `rent` lines on the customer's issued regular bills, and every
 * adjustment with this `assignment_id` and month, pending or billed.
 */
export async function rentalRecordsOf(
  tx: Tx,
  operatorId: string,
  assignmentId: string,
  periods: readonly Period[],
): Promise<Map<Period, RentalChargeRecord[]>> {
  const result = new Map<Period, RentalChargeRecord[]>();
  for (const p of periods) result.set(p, []);
  if (periods.length === 0) return result;
  const months = [...periods];

  const rentRows = await tx
    .select({ id: invoiceLines.id, amountPaise: invoiceLines.amountPaise, period: invoices.period })
    .from(invoiceLines)
    .innerJoin(
      invoices,
      and(
        eq(invoices.operatorId, invoiceLines.operatorId),
        eq(invoices.id, invoiceLines.invoiceId),
      ),
    )
    .where(
      and(
        eq(invoiceLines.operatorId, operatorId),
        eq(invoiceLines.assignmentId, assignmentId),
        eq(invoiceLines.type, "rent"),
        eq(invoices.kind, "regular"),
        eq(invoices.status, "issued"),
        inArray(invoices.period, months),
      ),
    );
  for (const row of rentRows) {
    const p = toPeriod(row.period);
    result.get(p)?.push({
      kind: "rent",
      id: row.id,
      assignmentId,
      period: p,
      amountPaise: toPaise(row.amountPaise),
    });
  }

  const adjustmentRows = await tx
    .select()
    .from(adjustments)
    .where(
      and(
        eq(adjustments.operatorId, operatorId),
        eq(adjustments.assignmentId, assignmentId),
        inArray(adjustments.period, months),
      ),
    )
    .orderBy(asc(adjustments.id));
  for (const row of adjustmentRows) {
    if (row.period === null) continue;
    const p = toPeriod(row.period);
    result.get(p)?.push({
      kind: "adjustment",
      id: row.id,
      assignmentId,
      period: p,
      direction: row.direction,
      amountPaise: toPaise(row.amountPaise),
      source: row.source,
    });
  }
  return result;
}

/** The view of a stored adjustment. */
export function toAdjustmentView(row: AdjustmentRow): AdjustmentView {
  return {
    id: row.id,
    customerId: row.customerId,
    assignmentId: row.assignmentId,
    period: row.period === null ? null : toPeriod(row.period),
    direction: row.direction,
    amountPaise: toPaise(row.amountPaise),
    source: row.source,
    reason: row.reason,
    invoiceId: row.invoiceId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export interface NewAdjustment {
  readonly id?: string;
  readonly customerId: string;
  readonly assignmentId: string | null;
  readonly period: Period | null;
  readonly direction: AdjustmentDirection;
  readonly amountPaise: Paise;
  readonly source: AdjustmentSource;
  readonly reason: string | null;
  readonly createdBy: string | null;
}

export interface WriteEnv {
  readonly operatorId: string;
  readonly now: Date;
  readonly audit: AuditRecorder;
}

/**
 * Inserts one adjustment with its money effect (module comment) and one audit event
 * (`adjustments.create`, entity `adjustment`). The caller holds the customer's balance lock.
 * `context` goes into the audit event (e.g. the connection event that caused it).
 */
export async function insertAdjustment(
  tx: Tx,
  env: WriteEnv,
  input: NewAdjustment,
  context: Record<string, unknown> = {},
): Promise<{ adjustment: AdjustmentView; creditAppliedPaise: Paise }> {
  const { operatorId, now } = env;
  if (!(input.amountPaise > 0)) throw new RangeError("an adjustment amount must be > 0");
  const [row] = await tx
    .insert(adjustments)
    .values({
      id: input.id ?? uuidv7(),
      operatorId,
      customerId: input.customerId,
      assignmentId: input.assignmentId,
      period: input.period,
      direction: input.direction,
      amountPaise: input.amountPaise,
      source: input.source,
      reason: input.reason,
      createdBy: input.createdBy,
      createdAt: now,
    })
    .returning();
  if (!row) throw new Error("adjustment insert returned no row");

  let creditAppliedPaise = toPaise(0);
  if (input.direction === "credit") {
    const before = await lockCustomerBalance(tx, operatorId, input.customerId);
    await tx.insert(ledgerEntries).values({
      id: uuidv7(),
      operatorId,
      customerId: input.customerId,
      type: "credit_adjustment",
      amountPaise: -input.amountPaise,
      adjustmentId: row.id,
      at: now,
    });
    creditAppliedPaise = await applyAvailableCredit(tx, operatorId, input.customerId, now, {
      balancePaise: subtractPaise(before.balancePaise, input.amountPaise),
      creditPaise: addPaise(before.creditPaise, input.amountPaise),
    });
  }

  const adjustment = toAdjustmentView(row);
  await env.audit.record({
    action: "adjustments.create",
    entityType: "adjustment",
    entityId: row.id,
    after: {
      customerId: row.customerId,
      assignmentId: row.assignmentId,
      period: row.period,
      direction: row.direction,
      amountPaise: row.amountPaise,
      source: row.source,
      reason: row.reason,
      creditAppliedPaise,
      ...context,
    },
  });
  return { adjustment, creditAppliedPaise };
}

/**
 * PLAN §8.5 with T-041 `applyCredit`: the customer's unused credit (payment remainders and
 * credit-adjustment remainders, oldest first) pays the oldest open bills. The ledger does not
 * change; `credit_paise` goes down by what was applied. Writes the read model with `balance` as
 * given. Returns the amount applied.
 */
export async function applyAvailableCredit(
  tx: Tx,
  operatorId: string,
  customerId: string,
  now: Date,
  balance: { balancePaise: Paise; creditPaise: Paise },
): Promise<Paise> {
  const sources = await loadCreditSources(tx, operatorId, customerId);
  const customerInvoices = await loadCustomerInvoices(tx, operatorId, customerId);
  const applied = applyCredit(sources, openInvoicesOf(customerInvoices));
  if (!applied.ok) {
    throw new Error(`applyCredit refused the customer's books: ${applied.error.code}`);
  }
  const outstanding = new Map(customerInvoices.map((inv) => [inv.id, inv.outstandingPaise]));
  for (const row of applied.value.allocations) {
    const after = subtractPaise(outstanding.get(row.invoiceId) ?? toPaise(0), row.amountPaise);
    outstanding.set(row.invoiceId, after);
    await tx.insert(allocations).values({
      id: uuidv7(),
      operatorId,
      customerId,
      invoiceId: row.invoiceId,
      sourceType: row.sourceType,
      paymentId: row.sourceType === "payment" ? row.sourceId : null,
      creditAdjustmentId: row.sourceType === "credit_adjustment" ? row.sourceId : null,
      kind: "credit_application",
      amountPaise: row.amountPaise,
      outstandingAfterPaise: after,
      createdAt: now,
    });
  }
  await writeCustomerBalance(tx, operatorId, customerId, {
    balancePaise: balance.balancePaise,
    creditPaise: subtractPaise(balance.creditPaise, applied.value.appliedPaise),
    oldestDuePeriod: oldestDuePeriod(applied.value.openInvoices),
    now,
  });
  return applied.value.appliedPaise;
}

/** Σ allocations of each credit adjustment (how much of it already paid bills). */
export async function creditUsedOf(
  tx: Tx,
  operatorId: string,
  adjustmentIds: readonly string[],
): Promise<Map<string, Paise>> {
  const used = new Map<string, Paise>();
  if (adjustmentIds.length === 0) return used;
  const rows = await tx
    .select({
      id: allocations.creditAdjustmentId,
      total: sql<string>`coalesce(sum(${allocations.amountPaise}), 0)`,
    })
    .from(allocations)
    .where(
      and(
        eq(allocations.operatorId, operatorId),
        inArray(allocations.creditAdjustmentId, [...adjustmentIds]),
      ),
    )
    .groupBy(allocations.creditAdjustmentId);
  for (const row of rows) if (row.id) used.set(row.id, toPaise(row.total));
  return used;
}
