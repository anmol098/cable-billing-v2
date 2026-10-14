/**
 * The "as of" moment of a report (T-080, FR-023 "Report totals reconcile to the ledger for the
 * same filters and as-of time"). Pure.
 *
 * - No date, or today (IST): the report is **as of now** (the service call's clock). Every row
 *   written up to that instant counts.
 * - A past IST date: the report is **as of the end of that day** (the next day's 00:00 IST,
 *   exclusive). Ledger entries, allocations and bills are timestamped by the transaction that
 *   posted them (`at`, `created_at`, `issued_at`), so the report sees exactly the money posted by
 *   then. A payment taken on the phone that reached the office later counts from when it reached
 *   the office (that is when it entered the books).
 * - A future date is refused (VALIDATION, field `asOfDate`).
 *
 * Reports read in one REPEATABLE READ, READ ONLY transaction, so their rows and totals come from
 * one snapshot even while payments are being posted.
 */
import {
  addDays,
  type BusinessDate,
  businessDateOf,
  compareBusinessDates,
  istStartOfDay,
} from "@cb/domain";
import { type ServiceError, serviceError } from "../../errors/errors";

export interface ReportAsOf {
  /** The instant the numbers are for (now, or the end of the chosen day). */
  readonly at: Date;
  /** The IST date ages are counted to. */
  readonly date: BusinessDate;
  /** `true` for a past day (the numbers are as of the end of `date`). */
  readonly endOfDay: boolean;
}

/** `at` plus the exclusive cutoff to compare row timestamps with (`ts < cutoff`). */
export interface ResolvedAsOf extends ReportAsOf {
  readonly cutoff: Date;
}

export function resolveAsOf(
  now: Date,
  asOfDate: BusinessDate | undefined,
): { ok: true; value: ResolvedAsOf } | { ok: false; error: ServiceError<"VALIDATION"> } {
  const today = businessDateOf(now);
  if (asOfDate === undefined || compareBusinessDates(asOfDate, today) === 0) {
    return {
      ok: true,
      value: { at: now, date: today, endOfDay: false, cutoff: new Date(now.getTime() + 1) },
    };
  }
  if (compareBusinessDates(asOfDate, today) > 0) {
    return {
      ok: false,
      error: serviceError("VALIDATION", "The as-of date is in the future", {
        fields: [{ path: "asOfDate", code: "future" }],
      }),
    };
  }
  const end = istStartOfDay(addDays(asOfDate, 1));
  return { ok: true, value: { at: end, date: asOfDate, endOfDay: true, cutoff: end } };
}
