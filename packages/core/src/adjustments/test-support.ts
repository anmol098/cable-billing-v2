/**
 * Test support for the adjustment tests (not exported from the package; no side effects, so the
 * isolation discovery can import it). Builds on the connection tests' tenant (real T-033 / T-034
 * services, the real T-044 billing run with a fixed clock) and adds:
 * - the D-18 policy setting,
 * - a snapshot of every issued bill and bill line, to prove no path edits them,
 * - the customers' books through T-041 `checkLedger`.
 */
import { adjustments, invoiceLines, invoices, ledgerEntries, type Tx } from "@cb/db";
import type { TestDatabase } from "@cb/db/testing";
import { checkLedger, type LedgerViolation, type MidMonthStartPolicy } from "@cb/domain";
import { asc, eq } from "drizzle-orm";
import { addConnection } from "../connections/services";
import type { ConnectionSetup } from "../connections/test-support";
import type { TenantContext } from "../context/tenant-context";
import { readLedgerState } from "../payments/test-support";

export { ist, newCustomer, runBilling, setupTenant } from "../connections/test-support";

/** Sets the operator's `mid_month_start_policy` (D-18). */
export async function setPolicy(
  database: Pick<TestDatabase, "admin">,
  operatorId: string,
  policy: MidMonthStartPolicy,
): Promise<void> {
  await database.admin.query(
    `UPDATE operators SET settings = settings || jsonb_build_object('mid_month_start_policy', $2::text)
      WHERE id = $1`,
    [operatorId, policy],
  );
}

let vcSeq = 0;

/** A connection on `customerId` with an own amount, through `connections.add`. */
export async function connect(
  s: ConnectionSetup,
  customerId: string,
  startDate: string,
  now: Date,
  rentalPaise = 30_000,
  ctx: TenantContext = s.staff,
): Promise<string> {
  vcSeq += 1;
  const result = await addConnection.call(s.rt(now), ctx, {
    customerId,
    vcNumber: `ADJ${String(vcSeq).padStart(4, "0")}${Math.floor(Math.random() * 1e6)}`,
    rentalPaise,
    startDate,
  });
  if (!result.ok) throw new Error(`addConnection: ${JSON.stringify(result.error)}`);
  return result.value.connection.assignmentId;
}

/** Every issued bill and bill line of the tenant, as stored. */
export async function issuedSnapshot(s: ConnectionSetup) {
  return s.tx(async (tx) => ({
    invoices: await tx.select().from(invoices).orderBy(asc(invoices.id)),
    lines: await tx.select().from(invoiceLines).orderBy(asc(invoiceLines.id)),
  }));
}

export type IssuedSnapshot = Awaited<ReturnType<typeof issuedSnapshot>>;

/** Rows of `before` that are missing or different in `after` (must be empty). */
export function changedIssuedRows(before: IssuedSnapshot, after: IssuedSnapshot): string[] {
  const problems: string[] = [];
  const invoiceById = new Map(after.invoices.map((row) => [row.id, row]));
  for (const row of before.invoices) {
    const now = invoiceById.get(row.id);
    if (!now) problems.push(`invoice ${row.id} disappeared`);
    else if (JSON.stringify(now) !== JSON.stringify(row)) problems.push(`invoice ${row.id} changed`);
  }
  const lineById = new Map(after.lines.map((row) => [row.id, row]));
  for (const row of before.lines) {
    const now = lineById.get(row.id);
    if (!now) problems.push(`line ${row.id} disappeared`);
    else if (JSON.stringify(now) !== JSON.stringify(row)) problems.push(`line ${row.id} changed`);
  }
  return problems;
}

/** T-041 `checkLedger` over each customer's rows (empty = healthy). */
export async function ledgerProblems(
  s: ConnectionSetup,
  customerIds: readonly string[],
): Promise<Record<string, LedgerViolation[]>> {
  const problems: Record<string, LedgerViolation[]> = {};
  for (const id of customerIds) {
    const state = await s.tx((tx) => readLedgerState(tx, id));
    const found = checkLedger(state);
    if (found.length > 0) problems[id] = found;
  }
  return problems;
}

/** The customer's adjustments, oldest first, in a compact form. */
export async function adjustmentsOf(s: ConnectionSetup, customerId: string) {
  return s.tx(async (tx: Tx) => {
    const rows = await tx
      .select()
      .from(adjustments)
      .where(eq(adjustments.customerId, customerId))
      .orderBy(asc(adjustments.createdAt), asc(adjustments.id));
    return rows.map((row) => ({
      id: row.id,
      assignmentId: row.assignmentId,
      period: row.period,
      direction: row.direction,
      amount: row.amountPaise,
      source: row.source,
      reason: row.reason,
      invoiceId: row.invoiceId,
      createdBy: row.createdBy,
    }));
  });
}

/** The customer's bills with their lines, by month. */
export async function billsOf(s: ConnectionSetup, customerId: string) {
  return s.tx(async (tx) => {
    const rows = await tx
      .select()
      .from(invoices)
      .where(eq(invoices.customerId, customerId))
      .orderBy(asc(invoices.period));
    const result = [];
    for (const invoice of rows) {
      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, invoice.id));
      // Adjustment lines first, then rent; each by amount (a stable order for the assertions).
      const order = (l: (typeof lines)[number]) => `${l.type}:${String(l.amountPaise).padStart(12, "0")}`;
      lines.sort((a, b) => order(a).localeCompare(order(b)));
      result.push({
        id: invoice.id,
        period: invoice.period,
        opening: invoice.openingBalancePaise,
        charges: invoice.chargesPaise,
        lines: lines.map((l) => ({
          type: l.type,
          assignmentId: l.assignmentId,
          adjustmentId: l.adjustmentId,
          amount: l.amountPaise,
        })),
      });
    }
    return result;
  });
}

/** The customer's ledger entries (type, signed amount), in posting order. */
export async function ledgerOf(s: ConnectionSetup, customerId: string) {
  return s.tx(async (tx) => {
    const rows = await tx
      .select()
      .from(ledgerEntries)
      .where(eq(ledgerEntries.customerId, customerId))
      .orderBy(asc(ledgerEntries.seq));
    return rows.map((row) => ({ type: row.type, amount: row.amountPaise }));
  });
}
