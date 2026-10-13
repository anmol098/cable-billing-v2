/**
 * `invariants` cron (PLAN §14): nightly ledger and allocation invariant checks.
 *
 * Placeholder from T-043: authenticated like every cron route; answers 501 until T-052 replaces
 * this file with the real handler (use `cronRoute` from `../_lib/cron`).
 */
import { cronStub } from "../_lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = cronStub("invariants", "T-052");
