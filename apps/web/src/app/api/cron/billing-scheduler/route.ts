/**
 * `billing-scheduler` cron (PLAN §14, `45 18 * * *` = 00:15 IST daily; T-044).
 *
 * On the 1st (IST) it creates the month's billing run and queues its `billing.run` job for every
 * billable tenant; on other days it catches up tenants whose run for the current month is missing
 * or lost. Read-only tenants get their run recorded as skipped (D-13); skipped runs are never
 * billed automatically (D-25). The `job-worker` cron does the billing. Idempotent: a second call
 * the same day queues nothing new. Rules: `scheduleBillingRuns` in `@cb/core` (billing/scheduler.ts).
 */
import { scheduleBillingRuns } from "@cb/core";
import { cronRoute } from "../_lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = cronRoute("billing_scheduler", async ({ db, log, requestId }) => {
  const report = await scheduleBillingRuns({ db: db(), now: new Date(), log, requestId });
  return { ...report };
});
