/**
 * The orderings that make allocation deterministic. Every function here is a total order, so the
 * same inputs in any order always give the same allocation rows.
 */
import { comparePeriods } from "../time";
import type { AllocationSourceType, CreditSource, OpenInvoice } from "./types";

/**
 * Compares ids by UTF-16 code unit, **not** `localeCompare`. For the lower-case canonical UUIDs
 * Postgres returns this is the same order as `ORDER BY id` on a `uuid` column, so the DB and the
 * domain agree on tie-breaks.
 */
export function compareIds(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Oldest invoice first: `ORDER BY period ASC, id ASC` (PLAN §8.4; PRD §13.2 step 3: "oldest due
 * date first, then stable invoice ID as tie-breaker").
 */
export function compareInvoicesOldestFirst(a: OpenInvoice, b: OpenInvoice): -1 | 0 | 1 {
  return comparePeriods(a.period, b.period) || compareIds(a.id, b.id);
}

const SOURCE_TYPE_RANK: Readonly<Record<AllocationSourceType, number>> = {
  credit_adjustment: 0,
  payment: 1,
};

/** The instant as epoch milliseconds. */
export function instantMs(at: CreditSource["at"]): number {
  return typeof at === "number" ? at : at.getTime();
}

/**
 * Oldest credit source first (PLAN §8.5): by `at`, then source type (`credit_adjustment` before
 * `payment`), then id. The last two only break exact ties and carry no business meaning.
 */
export function compareSourcesOldestFirst(a: CreditSource, b: CreditSource): -1 | 0 | 1 {
  const byTime = instantMs(a.at) - instantMs(b.at);
  if (byTime !== 0) return byTime < 0 ? -1 : 1;
  const byType = SOURCE_TYPE_RANK[a.sourceType] - SOURCE_TYPE_RANK[b.sourceType];
  if (byType !== 0) return byType < 0 ? -1 : 1;
  return compareIds(a.sourceId, b.sourceId);
}
