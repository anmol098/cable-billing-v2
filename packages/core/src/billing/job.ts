/**
 * The billing-run job (`billing.run`, T-044 on T-043's queue; PLAN §8.2, §14).
 *
 * A tenant job that works through one run's customers in slices:
 *
 * ```text
 * slice start (one tx): lock the run; not pending/running → stale job, stop
 *                       tenant read-only (D-13) → run recorded as skipped, stop
 *                       pending → running
 * next ≤ 200 customers after the cursor (ids ascending; `retry` mode: failed items only)
 * each customer: its own transaction (customer.ts); shouldYield() → continueLater(cursor)
 * a full slice → counts refreshed, continueLater(cursor) (the worker claims it again)
 * a short slice → counts refreshed, run completed | completed_with_errors, audit
 * ```
 *
 * Idempotent and safe to run twice at once: billed customers are excluded by their items, and
 * each customer is billed under its balance row lock with the RULE-05 UNIQUE behind it. A run
 * killed mid-slice (lease expiry) resumes from the last saved cursor.
 *
 * At most one live job per run: every enqueue happens while holding the run row lock, after
 * checking for a live job (`queueRunJob`). A finished run (`completed` …) is re-queued without
 * that check, because its job's handler has already done its last write.
 */
import { jobs, type Tx } from "@cb/db";
import { type Period, period as toPeriod } from "@cb/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { readTenantMode } from "../authz/writable";
import { continueLater, defineJob } from "../jobs/definition";
import { enqueueJob } from "../jobs/queue";
import { billCustomer, invoicePrefixOf } from "./customer";
import {
  type BillingRunRow,
  candidateCustomers,
  finishRun,
  lockRunById,
  markRunning,
  markRunSkipped,
  refreshRunCounts,
  toRunView,
} from "./runs";
import { BILLING_BATCH_SIZE } from "./types";

export const BILLING_RUN_JOB_TYPE = "billing.run";

const periodString = z.iso.date().refine((value) => value.endsWith("-01"), "period must be a 1st");

export const BillingRunJobPayload = z.object({
  runId: z.uuid(),
  period: periodString,
  /** `run`: every candidate customer; `retry`: only the run's failed items. */
  mode: z.enum(["run", "retry"]),
  /** The last customer id handled (slices resume after it). */
  cursor: z.uuid().optional(),
});
export type BillingRunJobPayload = z.output<typeof BillingRunJobPayload>;

type SliceStart =
  | { readonly kind: "stop"; readonly reason: string }
  | { readonly kind: "go"; readonly period: Period; readonly invoicePrefix: string };

export const billingRunJob = defineJob({
  type: BILLING_RUN_JOB_TYPE,
  scope: "tenant",
  payload: BillingRunJobPayload,
  async run(ctx) {
    const { payload, operatorId, log } = ctx;
    const { runId, mode } = payload;

    const start: SliceStart = await ctx.withTenant(async (tx) => {
      const run = await lockRunById(tx, operatorId, runId);
      if (!run) return { kind: "stop", reason: "run_not_found" };
      if (run.status !== "pending" && run.status !== "running") {
        return { kind: "stop", reason: `run_${run.status}` };
      }
      const now = ctx.clock();
      if ((await readTenantMode(tx)) === "read_only") {
        const skipped = await markRunSkipped(tx, runId, "tenant_read_only", now);
        if (skipped) await auditRun(ctx.audit, tx, "billing.run_skipped", skipped);
        return { kind: "stop", reason: "tenant_read_only" };
      }
      if (run.status === "pending") await markRunning(tx, runId, now);
      return {
        kind: "go",
        period: toPeriod(run.period),
        invoicePrefix: await invoicePrefixOf(tx, operatorId),
      };
    });
    if (start.kind === "stop") {
      log.info("billing.run_slice_stopped", { run_id: runId, reason: start.reason });
      return;
    }

    let cursor = payload.cursor ?? null;
    const batch = await ctx.withTenant((tx) =>
      candidateCustomers(tx, {
        operatorId,
        period: start.period,
        runId,
        mode,
        cursor,
        limit: BILLING_BATCH_SIZE,
      }),
    );
    const outcomes: Record<string, number> = {};
    const pause = async () => {
      await ctx.withTenant((tx) => refreshRunCounts(tx, runId, ctx.clock()));
      log.info("billing.run_slice_done", { run_id: runId, mode, ...outcomes });
      return continueLater({ payload: { ...payload, ...(cursor ? { cursor } : {}) } });
    };

    for (const customerId of batch) {
      if (ctx.shouldYield()) return pause();
      const result = await billCustomer((fn) => ctx.withTenant(fn), {
        operatorId,
        runId,
        period: start.period,
        customerId,
        invoicePrefix: start.invoicePrefix,
        now: ctx.clock(),
      });
      outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
      cursor = customerId;
    }
    if (batch.length === BILLING_BATCH_SIZE) return pause();

    await ctx.withTenant(async (tx) => {
      const finished = await finishRun(tx, runId, ctx.clock());
      if (finished) await auditRun(ctx.audit, tx, "billing.run_completed", finished);
    });
    log.info("billing.run_finished", { run_id: runId, mode, ...outcomes });
    return undefined;
  },
});

type JobAudit = (
  tx: Tx,
  event: { action: string; entityType: string; entityId?: string | null; after?: unknown },
) => Promise<string>;

async function auditRun(audit: JobAudit, tx: Tx, action: string, run: BillingRunRow) {
  const view = toRunView(run);
  await audit(tx, {
    action,
    entityType: "billing_run",
    entityId: run.id,
    after: {
      period: view.period,
      trigger: view.trigger,
      status: view.status,
      skip_reason: view.skipReason,
      customer_count: view.customerCount,
      created_count: view.createdCount,
      already_exists_count: view.alreadyExistsCount,
      skipped_count: view.skippedCount,
      failed_count: view.failedCount,
      total_charges_paise: view.totalChargesPaise,
    },
  });
}

/** Is a `billing.run` job for this run waiting or running? (Tenant tx: RLS limits `jobs`.) */
export async function hasLiveRunJob(tx: Tx, runId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, BILLING_RUN_JOB_TYPE),
        inArray(jobs.status, ["queued", "running"]),
        sql`${jobs.payload} ->> 'runId' = ${runId}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Queues the run's job in `tx` (the caller holds the run row lock and has moved the run to
 * `pending`). With `onlyIfIdle`, nothing is queued while a job for the run is still live.
 * Returns whether a job was queued.
 */
export async function queueRunJob(
  tx: Tx,
  run: { readonly id: string; readonly period: string; readonly operatorId: string },
  options: { mode: "run" | "retry"; now: Date; onlyIfIdle: boolean },
): Promise<boolean> {
  if (options.onlyIfIdle && (await hasLiveRunJob(tx, run.id))) return false;
  await enqueueJob(
    tx,
    billingRunJob,
    { runId: run.id, period: run.period, mode: options.mode },
    { operatorId: run.operatorId, runAfter: options.now },
  );
  return true;
}
