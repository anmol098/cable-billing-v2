/**
 * The nightly invariants job (T-052, PLAN §14 `invariants`, `0 21 * * *` UTC = 02:30 IST).
 *
 * The `invariants` cron only enqueues the platform job `invariants.check` (one live job at a time,
 * dedupe key); the `job-worker` cron runs it. The job walks every tenant (`operators`, ordered by
 * id, read in `withPlatform`) and, per tenant:
 *
 * 1. checks the books with {@link checkTenantInvariants} in a **read-only** `withTenant`
 *    transaction (one set-based statement; nothing is ever fixed or changed);
 * 2. stores the result in `invariant_checks` (append-only, one row per tenant and run; a re-run
 *    of the same job after a lease expiry doesn't store a tenant twice);
 * 3. on a breach, logs `invariants.breach` at error level with the tenant id and the counts per
 *    code (ids and counts only, never names or phone numbers).
 *
 * It yields (`continueLater` with the last checked tenant as cursor) when the worker's time budget
 * runs low, and carries the running totals in its payload. At the end, if any tenant breached, the
 * job **fails permanently** with `invariant_breach` (or `invariant_check_incomplete` when a
 * tenant's check itself errored): that is what raises the existing job-failure alert (T-043: email
 * to every platform admin + Sentry event; tenant owners are not emailed for a platform job). The
 * failed job row and `invariant_checks` say which tenants and rows.
 */
import { type DbClient, invariantChecks, operators } from "@cb/db";
import { asc, gt } from "drizzle-orm";
import { z } from "zod";
import type { PlatformJobContext } from "../jobs/context";
import { continueLater, defineJob, PermanentJobError } from "../jobs/definition";
import { type EnqueueResult, enqueueJob } from "../jobs/queue";
import { errorLogFields } from "../logging/logger";
import {
  type CheckTenantInvariantsOptions,
  checkTenantInvariants,
  DEFAULT_INVARIANT_SAMPLE_LIMIT,
} from "./check";
import type { TenantInvariantReport } from "./codes";

/** `jobs.dedupe_key` of the nightly run: one live check job at a time. */
export const INVARIANTS_CHECK_DEDUPE_KEY = "invariants.check";
/** Tenants listed per `withPlatform` read. */
export const INVARIANTS_TENANT_PAGE = 200;
/** `PermanentJobError` codes (stored in `jobs.last_error`, sent in the admin alert). */
export const INVARIANT_BREACH_ERROR = "invariant_breach";
export const INVARIANT_CHECK_INCOMPLETE_ERROR = "invariant_check_incomplete";

const count = z.number().int().nonnegative().default(0);

/** Payload: a cursor (last tenant checked) and the running totals of this run. */
export const InvariantsCheckPayload = z.object({
  cursor: z.uuid().optional(),
  tenantsChecked: count,
  breachedTenants: count,
  failedTenants: count,
  violationCount: count,
});
export type InvariantsCheckPayload = z.output<typeof InvariantsCheckPayload>;

/** Options the tests use; production uses the defaults. */
export interface InvariantsCheckSettings extends CheckTenantInvariantsOptions {}

type Totals = InvariantsCheckPayload;

async function checkOneTenant(
  ctx: PlatformJobContext<Totals>,
  operatorId: string,
  settings: InvariantsCheckSettings,
): Promise<TenantInvariantReport> {
  const started = ctx.clock().getTime();
  const report = await ctx.db.withTenant(
    operatorId,
    (tx) => checkTenantInvariants(tx, operatorId, settings),
    { accessMode: "read only" },
  );
  const durationMs = Math.max(0, ctx.clock().getTime() - started);
  await ctx.db.withTenant(operatorId, (tx) =>
    tx
      .insert(invariantChecks)
      .values({
        operatorId,
        runId: ctx.job.id,
        checkedAt: ctx.now,
        status: report.violationCount === 0 ? "ok" : "breach",
        violationCount: report.violationCount,
        counts: { ...report.counts },
        samples: [...report.samples],
        durationMs,
      })
      .onConflictDoNothing({ target: [invariantChecks.operatorId, invariantChecks.runId] }),
  );
  return report;
}

/** Builds the job with given check settings (exported for tests; production uses the default). */
export function createInvariantsCheckJob(settings: InvariantsCheckSettings = {}) {
  return defineJob({
    type: "invariants.check",
    scope: "platform",
    payload: InvariantsCheckPayload,
    // A breach fails the job at once (PermanentJobError); retries only cover crashes.
    maxAttempts: 3,
    async run(ctx) {
      const totals: Totals = { ...ctx.payload };
      const log = ctx.log.child({ run_id: ctx.job.id });
      for (;;) {
        const cursor = totals.cursor;
        const page = await ctx.db.withPlatform(
          (tx) =>
            tx
              .select({ id: operators.id })
              .from(operators)
              .where(cursor === undefined ? undefined : gt(operators.id, cursor))
              .orderBy(asc(operators.id))
              .limit(INVARIANTS_TENANT_PAGE),
          { accessMode: "read only" },
        );
        if (page.length === 0) break;
        for (const { id: operatorId } of page) {
          if (ctx.shouldYield()) {
            log.info("invariants.paused", { tenants_checked: totals.tenantsChecked });
            return continueLater({ payload: { ...totals } });
          }
          try {
            const report = await checkOneTenant(ctx, operatorId, settings);
            if (report.violationCount > 0) {
              totals.breachedTenants += 1;
              totals.violationCount += report.violationCount;
              log.error("invariants.breach", {
                operator_id: operatorId,
                violation_count: report.violationCount,
                counts: report.counts,
              });
            }
          } catch (error) {
            totals.failedTenants += 1;
            log.error("invariants.tenant_check_failed", {
              operator_id: operatorId,
              ...errorLogFields(error),
            });
          }
          totals.tenantsChecked += 1;
          totals.cursor = operatorId;
        }
        if (page.length < INVARIANTS_TENANT_PAGE) break;
      }
      const summary = {
        tenants_checked: totals.tenantsChecked,
        breached_tenants: totals.breachedTenants,
        failed_tenants: totals.failedTenants,
        violation_count: totals.violationCount,
      };
      if (totals.breachedTenants > 0) {
        log.error("invariants.finished", { ...summary, outcome: "breach" });
        throw new PermanentJobError(INVARIANT_BREACH_ERROR);
      }
      if (totals.failedTenants > 0) {
        log.error("invariants.finished", { ...summary, outcome: "incomplete" });
        throw new PermanentJobError(INVARIANT_CHECK_INCOMPLETE_ERROR);
      }
      log.info("invariants.finished", { ...summary, outcome: "ok" });
      return undefined;
    },
  });
}

/** The nightly job (picked up by the job-worker route through `@cb/core`'s exports). */
export const invariantsCheckJob = createInvariantsCheckJob({
  sampleLimit: DEFAULT_INVARIANT_SAMPLE_LIMIT,
});

/** Queues tonight's run (the `invariants` cron). A second call while one is live is a no-op. */
export function enqueueInvariantsCheck(db: Pick<DbClient, "withPlatform">): Promise<EnqueueResult> {
  return db.withPlatform((tx) =>
    enqueueJob(tx, invariantsCheckJob, {}, { dedupeKey: INVARIANTS_CHECK_DEDUPE_KEY }),
  );
}
