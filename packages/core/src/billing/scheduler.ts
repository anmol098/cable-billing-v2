/**
 * The billing scheduler (T-044; PLAN §8.2, §13, §14 `billing-scheduler`, 00:15 IST daily; B-006;
 * D-13, D-25). Called by the `/api/cron/billing-scheduler` route; it only decides and queues
 * jobs (fast), the `job-worker` cron does the billing.
 *
 * For the current IST period P, per active tenant (one short `withTenant` transaction each):
 *
 * | Tenant | P's run row | Action |
 * |---|---|---|
 * | read-only (D-13) | none | record the run as `skipped` (`tenant_read_only`): a missed run |
 * | read-only | any | nothing (a queued job records the skip itself when it runs) |
 * | billable | none | create it (`cron` on the 1st, `catch_up` on other days) and queue its job |
 * | billable | pending / running | queue a job only if none is live (a lost job is recovered) |
 * | billable | failed | back to pending, queue a job |
 * | billable | completed / completed_with_errors / skipped | nothing: finished, or a missed run that only the Owner may start (D-25) |
 *
 * - **Day 1 and catch-up are the same rule**: on the 1st every run is new; on later days only
 *   tenants without a run for P get one (the 1st's cron failed, the job was lost …). Idempotent:
 *   running it twice changes nothing the second time.
 * - Only tenants that existed **before P began** (IST) are billed automatically. A tenant that
 *   signed up mid-month gets its first automatic run on the next 1st; the Owner can still start
 *   the current month by hand. This keeps the catch-up from billing a whole month for imported,
 *   back-dated connections the operator billed elsewhere.
 * - Platform-suspended operators (`operators.status = 'suspended'`) are left alone.
 * - One tenant's failure doesn't stop the others; it is logged and counted, and the call throws
 *   at the end so the cron route reports it (500 + Sentry).
 */
import type { DbClient, Tx } from "@cb/db";
import { operators } from "@cb/db";
import { businessDateOf, isBillingDay, istStartOfDay, type Period } from "@cb/domain";
import { and, asc, eq, lt } from "drizzle-orm";
import { writeAuditEvent } from "../audit/audit";
import { readTenantMode } from "../authz/writable";
import { errorLogFields, type Logger } from "../logging/logger";
import { queueRunJob } from "./job";
import { type BillingRunRow, currentPeriod, ensureRun, reopenRun } from "./runs";

export type BillingScheduleOutcome =
  /** A new run was created and its job queued. */
  | "queued"
  /** An unfinished run had no live job: one was queued. */
  | "requeued"
  /** The run is pending/running with a live job. */
  | "in_progress"
  /** The run is finished (completed, completed_with_errors) or already skipped. */
  | "done"
  /** Read-only tenant: the run was recorded as skipped now. */
  | "skipped"
  /** Read-only tenant whose run row already exists. */
  | "read_only";

export interface BillingScheduleReport {
  readonly period: Period;
  /** True on the 1st (IST): the regular monthly run; otherwise a catch-up pass. */
  readonly billingDay: boolean;
  readonly tenants: number;
  readonly outcomes: Readonly<Record<BillingScheduleOutcome, number>>;
  readonly errors: number;
}

export interface BillingScheduleOptions {
  readonly db: Pick<DbClient, "withPlatform" | "withTenant">;
  /** The cron's clock (UTC instant). */
  readonly now: Date;
  readonly log: Logger;
  /** Request id for the audit events (the cron's). */
  readonly requestId?: string | null;
}

export class BillingScheduleError extends Error {
  constructor(readonly report: BillingScheduleReport) {
    super(`billing scheduler failed for ${report.errors} tenant(s)`);
    this.name = "BillingScheduleError";
  }
}

/** Decides and queues the current period's run for one tenant (inside its `withTenant` tx). */
export async function scheduleTenantRun(
  tx: Tx,
  input: { operatorId: string; period: Period; now: Date; requestId?: string | null },
): Promise<{ outcome: BillingScheduleOutcome; run: BillingRunRow }> {
  const { operatorId, period, now } = input;
  const trigger = isBillingDay(businessDateOf(now)) ? "cron" : "catch_up";
  const audit = (run: BillingRunRow, action: string) =>
    writeAuditEvent(tx, {
      operatorId,
      actorId: null,
      actorRole: null,
      action,
      entityType: "billing_run",
      entityId: run.id,
      after: { period: run.period, trigger: run.trigger, status: run.status },
      requestId: input.requestId ?? null,
    });

  if ((await readTenantMode(tx)) === "read_only") {
    const { row, created } = await ensureRun(tx, {
      operatorId,
      period,
      trigger,
      actorId: null,
      now,
      skipReason: "tenant_read_only",
    });
    if (created) await audit(row, "billing.run_skipped");
    return { outcome: created ? "skipped" : "read_only", run: row };
  }

  const { row, created } = await ensureRun(tx, { operatorId, period, trigger, actorId: null, now });
  if (created) {
    await queueRunJob(tx, row, { mode: "run", now, onlyIfIdle: false });
    await audit(row, "billing.run_scheduled");
    return { outcome: "queued", run: row };
  }
  if (row.status === "pending" || row.status === "running") {
    const queued = await queueRunJob(tx, row, { mode: "run", now, onlyIfIdle: true });
    if (queued) await audit(row, "billing.run_requeued");
    return { outcome: queued ? "requeued" : "in_progress", run: row };
  }
  if (row.status === "failed") {
    const reopened = await reopenRun(tx, row.id, { now });
    await queueRunJob(tx, reopened, { mode: "run", now, onlyIfIdle: false });
    await audit(reopened, "billing.run_requeued");
    return { outcome: "requeued", run: reopened };
  }
  return { outcome: "done", run: row };
}

/** The scheduler pass for every tenant (see the file header). */
export async function scheduleBillingRuns(
  options: BillingScheduleOptions,
): Promise<BillingScheduleReport> {
  const { db, now, log } = options;
  const period = currentPeriod(now);
  const billingDay = isBillingDay(businessDateOf(now));
  const periodStart = istStartOfDay(period);
  const tenants = await db.withPlatform((tx) =>
    tx
      .select({ id: operators.id })
      .from(operators)
      .where(and(eq(operators.status, "active"), lt(operators.createdAt, periodStart)))
      .orderBy(asc(operators.id)),
  );
  const outcomes: Record<BillingScheduleOutcome, number> = {
    queued: 0,
    requeued: 0,
    in_progress: 0,
    done: 0,
    skipped: 0,
    read_only: 0,
  };
  let errors = 0;
  for (const { id: operatorId } of tenants) {
    try {
      const { outcome, run } = await db.withTenant(operatorId, (tx) =>
        scheduleTenantRun(tx, { operatorId, period, now, requestId: options.requestId ?? null }),
      );
      outcomes[outcome] += 1;
      if (outcome !== "done" && outcome !== "in_progress") {
        log.info("billing.schedule_tenant", { operator_id: operatorId, run_id: run.id, outcome });
      }
    } catch (error) {
      errors += 1;
      log.error("billing.schedule_tenant_failed", {
        operator_id: operatorId,
        ...errorLogFields(error),
      });
    }
  }
  const report: BillingScheduleReport = {
    period,
    billingDay,
    tenants: tenants.length,
    outcomes,
    errors,
  };
  log.info("billing.schedule_done", {
    period,
    billing_day: billingDay,
    tenants: tenants.length,
    errors,
    ...outcomes,
  });
  if (errors > 0) throw new BillingScheduleError(report);
  return report;
}
