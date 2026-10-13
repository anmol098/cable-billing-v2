/**
 * `receipt-links-cleanup` cron (PLAN §14): weekly purge of long-expired receipt links.
 *
 * Placeholder from T-043: authenticated like every cron route; answers 501 until T-050 replaces
 * this file with the real handler (use `cronRoute` from `../_lib/cron`).
 */
import { cronStub } from "../_lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = cronStub("receipt_links_cleanup", "T-050");
