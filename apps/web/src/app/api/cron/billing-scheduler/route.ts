/**
 * `billing-scheduler` cron (PLAN §14): creates billing-run jobs on the 1st (00:15 IST) and catch-up runs on other days.
 *
 * Placeholder from T-043: authenticated like every cron route; answers 501 until T-044 replaces
 * this file with the real handler (use `cronRoute` from `../_lib/cron`).
 */
import { cronStub } from "../_lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = cronStub("billing_scheduler", "T-044");
