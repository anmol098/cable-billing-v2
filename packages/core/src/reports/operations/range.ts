/**
 * The IST day range of the day-based operations reports (T-081): collections and handover. Pure.
 *
 * `from` / `to` are IST business dates (inclusive). `to` defaults to today and `from` to
 * `defaultDays` days up to `to`. A day after today, `to` before `from`, or more than {@link REPORT_MAX_DAYS}
 * days are VALIDATION (fields `from` / `to`), so a report never silently shows other days than
 * the ones asked for.
 */
import { addDays, type BusinessDate, businessDateOf, compareBusinessDates } from "@cb/domain";
import { type ServiceError, serviceError } from "../../errors/errors";

/** Days one report may cover (a long month). */
export const REPORT_MAX_DAYS = 31;

/** Days from `from` to `to`, both counted (`2026-10-01`…`2026-10-31` = 31). */
export function daysInRange(from: BusinessDate, to: BusinessDate): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

export function resolveDayRange(
  now: Date,
  input: { from?: BusinessDate | undefined; to?: BusinessDate | undefined },
  defaultDays = 1,
):
  | { ok: true; value: { from: BusinessDate; to: BusinessDate } }
  | { ok: false; error: ServiceError<"VALIDATION"> } {
  const today = businessDateOf(now);
  const to = input.to ?? today;
  const from = input.from ?? addDays(to, 1 - defaultDays);
  const fields: { path: string; code: string }[] = [];
  if (compareBusinessDates(from, today) > 0) fields.push({ path: "from", code: "future" });
  if (compareBusinessDates(to, today) > 0) fields.push({ path: "to", code: "future" });
  if (fields.length === 0) {
    if (compareBusinessDates(from, to) > 0) fields.push({ path: "to", code: "before_from" });
    else if (daysInRange(from, to) > REPORT_MAX_DAYS)
      fields.push({ path: "to", code: "too_many_days" });
  }
  if (fields.length > 0) {
    return {
      ok: false,
      error: serviceError("VALIDATION", "The days of the report are not valid", { fields }),
    };
  }
  return { ok: true, value: { from, to } };
}
