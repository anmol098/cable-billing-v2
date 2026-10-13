/**
 * `invariants` cron (PLAN §14, `0 21 * * *` UTC = 02:30 IST; T-052): enqueues the platform job
 * `invariants.check` (`@cb/core`), which the `job-worker` cron runs. The job checks every tenant's
 * books (Σ ledger = balances, allocations ≤ sources and bills, no overlapping VC assignments, one
 * regular invoice per customer and period), stores one `invariant_checks` row per tenant, and on
 * a breach fails with `invariant_breach`, which sends the job-failure alert (platform admins,
 * Sentry). Read-only on the books. A second call while a check job is queued or running is a
 * no-op (dedupe key).
 */
import { enqueueInvariantsCheck } from "@cb/core";
import { cronRoute } from "../_lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = cronRoute("invariants", async ({ db, log }) => {
  const { jobId, created } = await enqueueInvariantsCheck(db());
  log.info("invariants.enqueued", { job_id: jobId, created });
  return { jobId, created };
});
