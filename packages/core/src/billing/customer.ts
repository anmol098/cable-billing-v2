/**
 * Bills one customer for one period (T-044; PLAN §8.2 inner loop, §8.5; FR-009, FR-011, FR-012;
 * RULE-05; PRD §15 #3, #4). Not exported from the package: the billing-run job calls it.
 *
 * One READ COMMITTED transaction per customer:
 *
 * ```text
 * lock customer_balances (FOR UPDATE)            # serialises with payments, reversals, other runs
 * item of this run already billed → done         # a slice that ran twice, two workers
 * regular invoice for (customer, P) exists → item already_exists           # RULE-05, FR-009
 * books consistent? Σ ledger = balance, Σ unallocated credit = credit       # else failed item
 * buildInvoice (T-040) with the opening balance = the locked balance
 *   err → item failed (details.reason); nothing_to_bill → item skipped
 * invoice number {prefix}-{YYMM of P}-{seq:05} (gap-free counter, taken late)
 * insert invoice → set adjustments.invoice_id → insert lines → ledger(+charges)
 * applyCredit (T-041): oldest credit source → oldest open invoice
 * customer_balances: balance += charges, credit −= applied, oldest_due_period
 * item created
 * ```
 *
 * - The DB's `invoices_one_regular_per_period` UNIQUE is the final guard. Two runs racing on one
 *   customer serialise on the balance lock and the second sees the first's invoice, so the
 *   UNIQUE only fires for a writer that didn't take the lock: `billCustomer` then records
 *   `already_exists` in a fresh transaction (the failed one rolled back, number included).
 * - Lock order: balance row → invoice counter → item row (T-046: balance → receipt counter →
 *   session). No cycles. Keep READ COMMITTED: after waiting for the balance lock, each statement
 *   sees what the previous holder committed.
 * - The opening balance is the locked `customer_balances.balance_paise`, checked against Σ
 *   `ledger_entries` first, so the opening of period N+1 is exactly the closing balance after N and
 *   everything posted since (FR-012).
 */
import {
  adjustments,
  allocations,
  invoiceLines,
  invoices,
  ledgerEntries,
  nextCounter,
  operators,
  parseOperatorSettings,
  paymentReversals,
  payments,
  sqlStateOf,
  type Tx,
  uuidv7,
} from "@cb/db";
import {
  addPaise,
  applyCredit,
  buildInvoice,
  type CreditSource,
  type InvoiceDraft,
  type Paise,
  type Period,
  subtractPaise,
  sumPaise,
  toPaise,
  unallocatedRemainder,
  yymm,
} from "@cb/domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  loadCustomerInvoices,
  lockCustomerBalance,
  oldestDuePeriod,
  openInvoicesOf,
  writeCustomerBalance,
} from "../payments/ledger-io";
import { loadBillingInputs } from "./inputs";
import { findItem, isBilledOutcome, writeItem } from "./runs";
import type { BillingItemResult } from "./types";

export interface BillCustomerArgs {
  readonly operatorId: string;
  readonly runId: string;
  readonly period: Period;
  readonly customerId: string;
  /** `operators.settings.invoice_prefix` (PLAN §7.3). */
  readonly invoicePrefix: string;
  readonly now: Date;
}

/** `{prefix}-{YYMM}-{seq:05}`, e.g. `INV-2611-00042` (PLAN §7.3; YYMM of the billed period). */
export function formatInvoiceNumber(prefix: string, period: Period, seq: number): string {
  return `${prefix}-${yymm(period)}-${String(seq).padStart(5, "0")}`;
}

/** The tenant's invoice prefix (default `INV`). */
export async function invoicePrefixOf(tx: Tx, operatorId: string): Promise<string> {
  const [row] = await tx
    .select({ settings: operators.settings })
    .from(operators)
    .where(eq(operators.id, operatorId));
  return parseOperatorSettings(row?.settings ?? {}).invoice_prefix;
}

const item = (
  customerId: string,
  outcome: BillingItemResult["outcome"],
  values: Partial<Omit<BillingItemResult, "customerId" | "outcome">> = {},
): BillingItemResult => ({
  customerId,
  outcome,
  invoiceId: values.invoiceId ?? null,
  reason: values.reason ?? null,
  details: values.details ?? {},
});

/** The customer's regular invoice for the period, if one exists. */
export async function findRegularInvoice(
  tx: Tx,
  operatorId: string,
  customerId: string,
  period: Period,
): Promise<string | null> {
  const [row] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .where(
      and(
        eq(invoices.operatorId, operatorId),
        eq(invoices.customerId, customerId),
        eq(invoices.period, period),
        eq(invoices.kind, "regular"),
      ),
    );
  return row?.id ?? null;
}

/** Σ the customer's ledger entries (the balance the read model must equal). */
export async function ledgerSum(tx: Tx, operatorId: string, customerId: string): Promise<Paise> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${ledgerEntries.amountPaise}), 0)` })
    .from(ledgerEntries)
    .where(and(eq(ledgerEntries.operatorId, operatorId), eq(ledgerEntries.customerId, customerId)));
  return toPaise(row?.total ?? 0);
}

/**
 * The customer's unused credit, as T-041 credit sources (PLAN §8.5): payment remainders (reversed
 * payments have none) and credit-adjustment remainders. `at` = the payment's `posted_at`
 * (T-041 Q-C recommendation) or the adjustment's `created_at`.
 */
export async function loadCreditSources(
  tx: Tx,
  operatorId: string,
  customerId: string,
): Promise<CreditSource[]> {
  const rows = await tx
    .select({ sourceId: allocations.sourceId, amountPaise: allocations.amountPaise })
    .from(allocations)
    .where(and(eq(allocations.operatorId, operatorId), eq(allocations.customerId, customerId)));
  const bySource = new Map<string, { amountPaise: Paise }[]>();
  for (const row of rows) {
    const list = bySource.get(row.sourceId) ?? [];
    list.push({ amountPaise: toPaise(row.amountPaise) });
    bySource.set(row.sourceId, list);
  }
  const paymentRows = await tx
    .select({
      id: payments.id,
      amountPaise: payments.amountPaise,
      postedAt: payments.postedAt,
      reversalId: paymentReversals.id,
    })
    .from(payments)
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(and(eq(payments.operatorId, operatorId), eq(payments.customerId, customerId)));
  const creditRows = await tx
    .select({
      id: adjustments.id,
      amountPaise: adjustments.amountPaise,
      createdAt: adjustments.createdAt,
    })
    .from(adjustments)
    .where(
      and(
        eq(adjustments.operatorId, operatorId),
        eq(adjustments.customerId, customerId),
        eq(adjustments.direction, "credit"),
      ),
    );
  const sources: CreditSource[] = [];
  for (const p of paymentRows) {
    sources.push({
      sourceType: "payment",
      sourceId: p.id,
      at: p.postedAt,
      availablePaise: unallocatedRemainder(
        { amountPaise: toPaise(p.amountPaise), reversed: p.reversalId !== null },
        bySource.get(p.id) ?? [],
      ),
    });
  }
  for (const c of creditRows) {
    sources.push({
      sourceType: "credit_adjustment",
      sourceId: c.id,
      at: c.createdAt,
      availablePaise: unallocatedRemainder(
        { amountPaise: toPaise(c.amountPaise) },
        bySource.get(c.id) ?? [],
      ),
    });
  }
  return sources;
}

/** Stores a built invoice and applies credit (inside the locked transaction). Returns its id. */
async function storeInvoice(
  tx: Tx,
  args: BillCustomerArgs,
  draft: InvoiceDraft,
  before: { balancePaise: Paise; creditPaise: Paise },
  creditSources: readonly CreditSource[],
): Promise<string> {
  const { operatorId, customerId, now } = args;
  // Taken late: the counter row lock is held until commit (other customers wait for it).
  const seq = await nextCounter(tx, operatorId, "invoice");
  const invoiceId = uuidv7();
  await tx.insert(invoices).values({
    id: invoiceId,
    operatorId,
    customerId,
    period: draft.period,
    invoiceNumber: formatInvoiceNumber(args.invoicePrefix, draft.period, seq),
    kind: "regular",
    openingBalancePaise: draft.openingBalancePaise,
    chargesPaise: draft.chargesPaise,
    totalDuePaise: draft.totalDuePaise,
    issuedAt: now,
  });

  // T-023: the adjustment must name the invoice before its line can reference it.
  for (const adjustmentId of draft.invoicedAdjustmentIds) {
    const marked = await tx
      .update(adjustments)
      .set({ invoiceId })
      .where(
        and(
          eq(adjustments.operatorId, operatorId),
          eq(adjustments.id, adjustmentId),
          isNull(adjustments.invoiceId),
        ),
      )
      .returning({ id: adjustments.id });
    if (marked.length !== 1) throw new Error("pending adjustment was invoiced concurrently");
  }
  await tx.insert(invoiceLines).values(
    draft.lines.map((line) => ({
      id: uuidv7(),
      operatorId,
      invoiceId,
      type: line.type,
      assignmentId: line.assignmentId,
      adjustmentId: line.adjustmentId,
      amountPaise: line.amountPaise,
      createdAt: now,
    })),
  );
  await tx.insert(ledgerEntries).values({
    id: uuidv7(),
    operatorId,
    customerId,
    type: "invoice",
    amountPaise: draft.chargesPaise,
    invoiceId,
    at: now,
  });

  // PLAN §8.5: unused credit pays the oldest open invoices (this one included). Ledger unchanged.
  const customerInvoices = await loadCustomerInvoices(tx, operatorId, customerId);
  const applied = applyCredit(creditSources, openInvoicesOf(customerInvoices));
  if (!applied.ok) {
    throw new Error(`applyCredit refused the customer's books: ${applied.error.code}`);
  }
  const outstanding = new Map(customerInvoices.map((inv) => [inv.id, inv.outstandingPaise]));
  for (const row of applied.value.allocations) {
    const after = subtractPaise(outstanding.get(row.invoiceId) ?? (0 as Paise), row.amountPaise);
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
    balancePaise: addPaise(before.balancePaise, draft.chargesPaise),
    creditPaise: subtractPaise(before.creditPaise, applied.value.appliedPaise),
    oldestDuePeriod: oldestDuePeriod(applied.value.openInvoices),
    now,
  });
  return invoiceId;
}

/**
 * The algorithm inside the caller's tenant transaction. Always writes the customer's item (unless
 * it was already billed in this run) and returns it.
 */
export async function billCustomerInTx(tx: Tx, args: BillCustomerArgs): Promise<BillingItemResult> {
  const { operatorId, runId, customerId, period, now } = args;
  const before = await lockCustomerBalance(tx, operatorId, customerId);

  const existingItem = await findItem(tx, operatorId, runId, customerId);
  if (existingItem && isBilledOutcome(existingItem.outcome)) {
    return item(customerId, existingItem.outcome, {
      invoiceId: existingItem.invoiceId,
      details: existingItem.details,
    });
  }

  const finish = async (result: BillingItemResult) => {
    await writeItem(tx, operatorId, runId, result, now);
    return result;
  };

  const existingInvoice = await findRegularInvoice(tx, operatorId, customerId, period);
  if (existingInvoice) {
    return finish(item(customerId, "already_exists", { invoiceId: existingInvoice }));
  }

  // Never bill on top of inconsistent books (the nightly invariants job alerts on them, T-052).
  const ledgerPaise = await ledgerSum(tx, operatorId, customerId);
  if (ledgerPaise !== before.balancePaise) {
    return finish(
      item(customerId, "failed", {
        reason: "balance_mismatch",
        details: { balancePaise: before.balancePaise, ledgerPaise },
      }),
    );
  }
  const creditSources = await loadCreditSources(tx, operatorId, customerId);
  const sourcesPaise = sumPaise(creditSources.map((s) => s.availablePaise));
  if (sourcesPaise !== before.creditPaise) {
    return finish(
      item(customerId, "failed", {
        reason: "credit_mismatch",
        details: { creditPaise: before.creditPaise, unallocatedPaise: sourcesPaise },
      }),
    );
  }

  const inputs = (await loadBillingInputs(tx, operatorId, [customerId], period)).get(customerId);
  if (!inputs) throw new Error("billing inputs missing for the customer");
  const guard =
    inputs.midMonthStartAssignmentIds.length > 0
      ? { midMonthStartAssignmentIds: inputs.midMonthStartAssignmentIds }
      : {};
  const built = buildInvoice({
    customer: { id: customerId },
    assignments: inputs.assignments,
    pendingAdjustments: inputs.pendingAdjustments,
    openingBalancePaise: before.balancePaise,
    period,
  });
  if (!built.ok) {
    const details = built.error.details ?? {};
    const reason = typeof details.reason === "string" ? details.reason : "invalid_input";
    return finish(item(customerId, "failed", { reason, details: { ...details, ...guard } }));
  }
  if (built.value.outcome === "nothing_to_bill") {
    return finish(item(customerId, "skipped", { reason: "nothing_to_bill", details: guard }));
  }
  const invoiceId = await storeInvoice(tx, args, built.value, before, creditSources);
  return finish(item(customerId, "created", { invoiceId, details: guard }));
}

const UNIQUE_VIOLATION = "23505";
const RULE_05 = "invoices_one_regular_per_period";

/** SQLSTATEs worth retrying the whole job for (lock/serialisation trouble, lost connection). */
export function isTransientDbError(error: unknown): boolean {
  const state = sqlStateOf(error);
  if (state === undefined) {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && /^E(CONNRESET|CONNREFUSED|PIPE|TIMEDOUT)$/.test(code);
  }
  return state === "40001" || state === "40P01" || state.startsWith("08") || state === "57P01";
}

function constraintOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const value = (current as { constraint?: unknown }).constraint;
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Error facts safe to store in an item's `details` (no messages: they can quote row values). */
function errorDetails(error: unknown): Record<string, unknown> {
  const state = sqlStateOf(error);
  const constraint = constraintOf(error);
  return {
    errorType: error instanceof Error ? error.name : typeof error,
    ...(state ? { sqlstate: state } : {}),
    ...(constraint ? { constraint } : {}),
  };
}

type WithTenant = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/**
 * Bills one customer in its own transaction and always leaves an item behind:
 * - RULE-05 UNIQUE hit (a writer that didn't take the lock got there first) → `already_exists`;
 * - any other unexpected error → `failed` / `internal_error` (the Owner retries it later);
 * - transient database errors (deadlock, serialisation, lost connection) are re-thrown so the job
 *   is retried with backoff and resumes from its cursor.
 */
export async function billCustomer(
  withTenant: WithTenant,
  args: BillCustomerArgs,
): Promise<BillingItemResult> {
  try {
    return await withTenant((tx) => billCustomerInTx(tx, args));
  } catch (error) {
    if (isTransientDbError(error)) throw error;
    const { operatorId, runId, customerId, period, now } = args;
    if (sqlStateOf(error) === UNIQUE_VIOLATION && constraintOf(error) === RULE_05) {
      return withTenant(async (tx) => {
        const invoiceId = await findRegularInvoice(tx, operatorId, customerId, period);
        if (!invoiceId) throw error;
        const result = item(customerId, "already_exists", { invoiceId });
        await writeItem(tx, operatorId, runId, result, now);
        return result;
      });
    }
    return withTenant(async (tx) => {
      const result = item(customerId, "failed", {
        reason: "internal_error",
        details: errorDetails(error),
      });
      await writeItem(tx, operatorId, runId, result, now);
      return result;
    });
  }
}
