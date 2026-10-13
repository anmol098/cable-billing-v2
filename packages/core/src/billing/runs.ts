/**
 * `billing_runs` / `billing_run_items` rows (T-023 schema) and the run's customer list (T-044).
 * Not exported from the package.
 *
 * Rules every writer here follows:
 * - **One logical run per tenant and period** (UNIQUE): created with `INSERT … ON CONFLICT DO
 *   NOTHING`, then locked with `SELECT … FOR UPDATE`. Every status change and every enqueue of
 *   the run's job happens while holding that row lock, so two starters (cron + Owner, two cron
 *   invocations) see each other's decision.
 * - **Counts are recomputed from the items** (never incremented), so a slice that ran twice or a
 *   retry can't make them drift.
 * - The per-customer transaction never touches the run row (only its own item row), so customers
 *   don't serialise on it; lock order there is balance row → invoice counter → item row.
 */
import {
  type BillingRunItemOutcome,
  type BillingRunSkipReason,
  type BillingRunTrigger,
  billingRunItems,
  billingRuns,
  operators,
  type Tx,
  uuidv7,
} from "@cb/db";
import {
  comparePeriods,
  err,
  ok,
  type Period,
  periodOfInstant,
  type Result,
  toPaise,
  period as toPeriod,
} from "@cb/domain";
import { and, eq, sql } from "drizzle-orm";
import { type ServiceError, serviceError } from "../errors/errors";
import type { BillingItemResult, BillingRunView } from "./types";

export type BillingRunRow = typeof billingRuns.$inferSelect;

/** Statuses of a run that is still being worked on (a job owns it). */
export const IN_PROGRESS_STATUSES = ["pending", "running"] as const;

export function isInProgress(status: BillingRunRow["status"]): boolean {
  return status === "pending" || status === "running";
}

export function toRunView(row: BillingRunRow): BillingRunView {
  return {
    id: row.id,
    period: toPeriod(row.period),
    trigger: row.trigger,
    status: row.status,
    skipReason: row.skipReason,
    customerCount: row.customerCount,
    createdCount: row.createdCount,
    alreadyExistsCount: row.alreadyExistsCount,
    skippedCount: row.skippedCount,
    failedCount: row.failedCount,
    totalChargesPaise: toPaise(row.totalChargesPaise),
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    actorId: row.actorId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** The period's run row, locked, or null. */
export async function lockRunByPeriod(
  tx: Tx,
  operatorId: string,
  period: Period,
): Promise<BillingRunRow | null> {
  const [row] = await tx
    .select()
    .from(billingRuns)
    .where(and(eq(billingRuns.operatorId, operatorId), eq(billingRuns.period, period)))
    .for("update");
  return row ?? null;
}

/** A run row by id, locked, or null (another tenant's id is invisible: RLS). */
export async function lockRunById(
  tx: Tx,
  operatorId: string,
  runId: string,
): Promise<BillingRunRow | null> {
  const [row] = await tx
    .select()
    .from(billingRuns)
    .where(and(eq(billingRuns.operatorId, operatorId), eq(billingRuns.id, runId)))
    .for("update");
  return row ?? null;
}

export interface NewRun {
  readonly operatorId: string;
  readonly period: Period;
  readonly trigger: BillingRunTrigger;
  readonly actorId: string | null;
  readonly now: Date;
  /** Record the run as skipped at once (read-only tenant, D-13). */
  readonly skipReason?: BillingRunSkipReason;
}

/**
 * Creates the period's run if it doesn't exist yet, then returns it locked. `created` is false
 * when another starter got there first (the existing row is returned unchanged).
 */
export async function ensureRun(
  tx: Tx,
  input: NewRun,
): Promise<{ row: BillingRunRow; created: boolean }> {
  const skipped = input.skipReason !== undefined;
  const inserted = await tx
    .insert(billingRuns)
    .values({
      id: uuidv7(),
      operatorId: input.operatorId,
      period: input.period,
      trigger: input.trigger,
      status: skipped ? "skipped" : "pending",
      skipReason: input.skipReason ?? null,
      finishedAt: skipped ? input.now : null,
      actorId: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoNothing({ target: [billingRuns.operatorId, billingRuns.period] })
    .returning({ id: billingRuns.id });
  const row = await lockRunByPeriod(tx, input.operatorId, input.period);
  if (!row) throw new Error("billing run row missing after insert");
  return { row, created: inserted.length > 0 };
}

/** A finished (or skipped) run starts again: back to `pending`, keeping its id and items. */
export async function reopenRun(
  tx: Tx,
  runId: string,
  values: { trigger?: BillingRunTrigger; actorId?: string | null; now: Date },
): Promise<BillingRunRow> {
  const [row] = await tx
    .update(billingRuns)
    .set({
      status: "pending",
      skipReason: null,
      finishedAt: null,
      ...(values.trigger === undefined ? {} : { trigger: values.trigger }),
      ...(values.actorId === undefined ? {} : { actorId: values.actorId }),
      updatedAt: values.now,
    })
    .where(eq(billingRuns.id, runId))
    .returning();
  if (!row) throw new Error("billing run row vanished");
  return row;
}

/** The job starts working: `pending` → `running` (`started_at` = now). */
export async function markRunning(tx: Tx, runId: string, now: Date): Promise<void> {
  await tx
    .update(billingRuns)
    .set({ status: "running", startedAt: now, updatedAt: now })
    .where(and(eq(billingRuns.id, runId), eq(billingRuns.status, "pending")));
}

/** The tenant is read-only when the job runs (D-13): the run is recorded as skipped. */
export async function markRunSkipped(
  tx: Tx,
  runId: string,
  reason: BillingRunSkipReason,
  now: Date,
): Promise<BillingRunRow | null> {
  await refreshRunCounts(tx, runId, now);
  const [row] = await tx
    .update(billingRuns)
    .set({ status: "skipped", skipReason: reason, finishedAt: now, updatedAt: now })
    .where(and(eq(billingRuns.id, runId), sql`${billingRuns.status} IN ('pending', 'running')`))
    .returning();
  return row ?? null;
}

/** Recomputes the run's counts and total from its items. */
export async function refreshRunCounts(tx: Tx, runId: string, now: Date): Promise<void> {
  await tx.execute(sql`
    UPDATE billing_runs r SET
      customer_count = s.customers,
      created_count = s.created,
      already_exists_count = s.already_exists,
      skipped_count = s.skipped,
      failed_count = s.failed,
      total_charges_paise = s.total,
      updated_at = ${now}
    FROM (
      SELECT count(*)::int AS customers,
             count(*) FILTER (WHERE i.outcome = 'created')::int AS created,
             count(*) FILTER (WHERE i.outcome = 'already_exists')::int AS already_exists,
             count(*) FILTER (WHERE i.outcome = 'skipped')::int AS skipped,
             count(*) FILTER (WHERE i.outcome = 'failed')::int AS failed,
             coalesce(sum(inv.charges_paise) FILTER (WHERE i.outcome = 'created'), 0) AS total
        FROM billing_run_items i
        LEFT JOIN invoices inv ON inv.operator_id = i.operator_id AND inv.id = i.invoice_id
       WHERE i.run_id = ${runId}
    ) s
    WHERE r.id = ${runId}`);
}

/**
 * Every customer was handled: counts refreshed, `running` → `completed` (or
 * `completed_with_errors` when an item failed). Returns the row, or null if the run was not
 * running any more (another worker finished it, or it was skipped).
 */
export async function finishRun(tx: Tx, runId: string, now: Date): Promise<BillingRunRow | null> {
  await refreshRunCounts(tx, runId, now);
  const [row] = await tx
    .update(billingRuns)
    .set({
      status: sql`CASE WHEN ${billingRuns.failedCount} > 0
        THEN 'completed_with_errors'::billing_run_status
        ELSE 'completed'::billing_run_status END`,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(eq(billingRuns.id, runId), sql`${billingRuns.status} IN ('pending', 'running')`))
    .returning();
  return row ?? null;
}

/** The item of a customer in a run, if any. */
export async function findItem(
  tx: Tx,
  operatorId: string,
  runId: string,
  customerId: string,
): Promise<typeof billingRunItems.$inferSelect | null> {
  const [row] = await tx
    .select()
    .from(billingRunItems)
    .where(
      and(
        eq(billingRunItems.operatorId, operatorId),
        eq(billingRunItems.runId, runId),
        eq(billingRunItems.customerId, customerId),
      ),
    );
  return row ?? null;
}

export function isBilledOutcome(outcome: BillingRunItemOutcome): boolean {
  return outcome === "created" || outcome === "already_exists";
}

/**
 * Writes a customer's item. A `skipped` / `failed` item is replaced (attempts + 1); a billed item
 * (`created` / `already_exists`) is final and is left as it is (T-023 trigger: billed items never
 * change).
 */
export async function writeItem(
  tx: Tx,
  operatorId: string,
  runId: string,
  item: BillingItemResult,
  now: Date,
): Promise<void> {
  await tx
    .insert(billingRunItems)
    .values({
      id: uuidv7(),
      operatorId,
      runId,
      customerId: item.customerId,
      outcome: item.outcome,
      invoiceId: item.invoiceId,
      reason: item.reason,
      details: { ...item.details },
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [billingRunItems.operatorId, billingRunItems.runId, billingRunItems.customerId],
      set: {
        outcome: item.outcome,
        invoiceId: item.invoiceId,
        reason: item.reason,
        details: { ...item.details },
        attempts: sql`${billingRunItems.attempts} + 1`,
        updatedAt: now,
      },
      setWhere: sql`${billingRunItems.outcome} IN ('skipped', 'failed')`,
    });
}

export type CandidateMode = "run" | "retry";

/**
 * The next customers (by id, after `cursor`) a run has to look at:
 * - `run`: customers with an assignment overlapping the 1st of the period, or a pending debit
 *   adjustment not later than the period, or a failed item in this run; minus the customers whose
 *   item is already billed (`created` / `already_exists`).
 * - `retry`: only the customers whose item in this run is `failed` (PLAN §8.2 "Retry re-runs only
 *   failed items").
 * With `runId` null (preview) nothing is excluded.
 */
export async function candidateCustomers(
  tx: Tx,
  input: {
    operatorId: string;
    period: Period;
    runId: string | null;
    mode: CandidateMode;
    cursor: string | null;
    limit: number;
  },
): Promise<string[]> {
  const { operatorId, period, runId, cursor, limit } = input;
  const failedOfRun =
    runId === null
      ? sql`SELECT NULL::uuid WHERE false`
      : sql`SELECT customer_id FROM billing_run_items
             WHERE operator_id = ${operatorId} AND run_id = ${runId} AND outcome = 'failed'`;
  const source =
    input.mode === "retry"
      ? failedOfRun
      : sql`SELECT customer_id FROM vc_assignments
             WHERE operator_id = ${operatorId} AND start_date <= ${period}
               AND (end_date IS NULL OR end_date >= ${period})
            UNION
            SELECT customer_id FROM adjustments
             WHERE operator_id = ${operatorId} AND invoice_id IS NULL AND direction = 'debit'
               AND (period IS NULL OR period <= ${period})
            UNION
            ${failedOfRun}`;
  const notBilled =
    runId === null
      ? sql`true`
      : sql`NOT EXISTS (SELECT 1 FROM billing_run_items i
                         WHERE i.operator_id = ${operatorId} AND i.run_id = ${runId}
                           AND i.customer_id = c.customer_id
                           AND i.outcome IN ('created', 'already_exists'))`;
  const after = cursor === null ? sql`true` : sql`c.customer_id > ${cursor}::uuid`;
  const result = await tx.execute<{ customer_id: string }>(sql`
    SELECT c.customer_id FROM (${source}) c
     WHERE c.customer_id IS NOT NULL AND ${after} AND ${notBilled}
     ORDER BY c.customer_id
     LIMIT ${limit}`);
  return result.rows.map((r) => r.customer_id);
}

/** The current billing period: the IST month of `now`. */
export function currentPeriod(now: Date): Period {
  return periodOfInstant(now);
}

type PeriodError = ServiceError<"VALIDATION">;

function periodRefused(code: string, message: string): PeriodError {
  return serviceError("VALIDATION", message, { reason: code, fields: [{ path: "period", code }] });
}

/**
 * May the Owner preview / run `period` by hand?
 * - never a future month (`period_in_future`);
 * - from the tenant's first month (the IST month it was created in) up to the current month, or
 *   any older month that already has a run row (a recorded skipped / failed run, D-25);
 *   otherwise `period_before_tenant` (a run for years before the tenant joined would bill
 *   imported back-dated connections for months nobody asked for).
 */
export async function checkRunnablePeriod(
  tx: Tx,
  operatorId: string,
  period: Period,
  now: Date,
): Promise<Result<void, PeriodError>> {
  if (comparePeriods(period, currentPeriod(now)) > 0) {
    return err(periodRefused("period_in_future", "Billing period is in the future"));
  }
  const [operator] = await tx
    .select({ createdAt: operators.createdAt })
    .from(operators)
    .where(eq(operators.id, operatorId));
  if (operator && comparePeriods(period, periodOfInstant(operator.createdAt)) >= 0) {
    return ok(undefined);
  }
  const [existing] = await tx
    .select({ id: billingRuns.id })
    .from(billingRuns)
    .where(and(eq(billingRuns.operatorId, operatorId), eq(billingRuns.period, period)));
  if (existing) return ok(undefined);
  return err(periodRefused("period_before_tenant", "Billing period is before the tenant started"));
}
