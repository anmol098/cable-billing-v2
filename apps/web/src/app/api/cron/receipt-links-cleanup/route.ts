/**
 * `receipt-links-cleanup` cron (PLAN §14, weekly): enqueues the platform job
 * `receipts.purge_expired_links` (T-050, `@cb/core`), which deletes receipt links that expired more
 * than 30 days ago in every tenant (receipts are kept). The job worker cron does the work; a second
 * call while a purge job is still queued or running is a no-op (dedupe key).
 */
import { enqueueJob, purgeExpiredReceiptLinksJob, RECEIPT_LINK_PURGE_DEDUPE_KEY } from "@cb/core";
import { cronRoute } from "../_lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = cronRoute("receipt_links_cleanup", async ({ db, log }) => {
  const { jobId, created } = await db().withPlatform((tx) =>
    enqueueJob(tx, purgeExpiredReceiptLinksJob, {}, { dedupeKey: RECEIPT_LINK_PURGE_DEDUPE_KEY }),
  );
  log.info("receipt_link.purge_enqueued", { job_id: jobId, created });
  return { jobId, created };
});
