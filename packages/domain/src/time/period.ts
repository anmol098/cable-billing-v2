/**
 * Billing periods (PLAN §7.1): a period is a calendar month in India, stored as the `date` of its 1st
 * (`"2026-10-01"`; the DB checks `extract(day from period) = 1`). A `Period` is therefore also a
 * `BusinessDate` and can be passed wherever one is expected.
 *
 * The monthly bill is made on the 1st (the billing day): an assignment is billed for period P if it
 * was active at any time on the 1st of P (PLAN §8.1, built in T-040). The scheduler runs at 00:15 IST
 * daily and bills the period of the current business date (PLAN §14).
 */

import { type DomainError, domainError, err, ok, type Result } from "../result";
import {
  type BusinessDate,
  businessDateFromParts,
  businessDateOf,
  dateParts,
  daysInMonth,
  type Instant,
  isBusinessDate,
} from "./business-date";

declare const periodBrand: unique symbol;

/** The 1st of a month, as `"YYYY-MM-01"`. */
export type Period = BusinessDate & { readonly [periodBrand]: true };

/** The billing day of every period: the 1st. */
export const BILLING_DAY_OF_MONTH = 1;

/** The period of a year and month (1–12). Throws `RangeError` when out of range. */
export function periodFromYearMonth(year: number, month: number): Period {
  return businessDateFromParts({ year, month, day: BILLING_DAY_OF_MONTH }) as Period;
}

/** The period (1st of the month) that a business date falls in. */
export function periodOf(date: BusinessDate): Period {
  const { year, month } = dateParts(date);
  return periodFromYearMonth(year, month);
}

/** The period of an instant's business date: the "current period" when you pass `now`. */
export function periodOfInstant(instant: Instant): Period {
  return periodOf(businessDateOf(instant));
}

export function isPeriod(value: unknown): value is Period {
  return isBusinessDate(value) && dateParts(value).day === BILLING_DAY_OF_MONTH;
}

/** Validates a period from a form, URL or the API. Accepts `"2026-10-01"` and `"2026-10"`. */
export function parsePeriod(value: string): Result<Period, DomainError<"VALIDATION">> {
  const candidate = /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : value;
  return isPeriod(candidate)
    ? ok(candidate)
    : err(domainError("VALIDATION", "expected a period as YYYY-MM-01 or YYYY-MM", { value }));
}

/** Like {@link parsePeriod} but throws `RangeError`. For constants and trusted DB values. */
export function period(value: string): Period {
  const result = parsePeriod(value);
  if (!result.ok) throw new RangeError(`not a period: "${value}"`);
  return result.value;
}

/** `period` moved by `months` (may be negative). */
export function addPeriods(start: Period, months: number): Period {
  if (!Number.isSafeInteger(months)) {
    throw new RangeError(`months must be an integer, got ${months}`);
  }
  const { year, month } = dateParts(start);
  const index = year * 12 + (month - 1) + months;
  const nextMonthIndex = ((index % 12) + 12) % 12;
  return periodFromYearMonth((index - nextMonthIndex) / 12, nextMonthIndex + 1);
}

export function nextPeriod(current: Period): Period {
  return addPeriods(current, 1);
}

export function previousPeriod(current: Period): Period {
  return addPeriods(current, -1);
}

/** The last business date of the period (`"2026-10-31"`). */
export function periodEnd(current: Period): BusinessDate {
  const { year, month } = dateParts(current);
  return businessDateFromParts({ year, month, day: daysInMonth(year, month) });
}

/** True when the business date falls inside the period. */
export function periodContains(current: Period, date: BusinessDate): boolean {
  return periodOf(date) === current;
}

/** For sorting: ascending. */
export function comparePeriods(a: Period, b: Period): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Months from `from` to `to` (`to − from`; negative when `to` is earlier). */
export function monthsBetween(from: Period, to: Period): number {
  const a = dateParts(from);
  const b = dateParts(to);
  return (b.year - a.year) * 12 + (b.month - a.month);
}

/**
 * Every period from `from` to `to`, both included, oldest first (empty when `to` is before `from`).
 * For "Missed bill runs" (D-25) and catch-up. Throws `RangeError` above `max` periods (default 1200,
 * a hundred years) so a bad input cannot allocate without bound.
 */
export function periodsBetween(from: Period, to: Period, max = 1200): Period[] {
  const count = monthsBetween(from, to) + 1;
  if (count <= 0) return [];
  if (count > max) throw new RangeError(`too many periods: ${count} > ${max}`);
  return Array.from({ length: count }, (_, offset) => addPeriods(from, offset));
}

/** True when the business date is the billing day (the 1st) of its month. */
export function isBillingDay(date: BusinessDate): boolean {
  return dateParts(date).day === BILLING_DAY_OF_MONTH;
}

/**
 * `"YYMM"` of a date or period, for document numbers (PLAN §7.3: `INV-2610-00123`, `R-2610-00045`).
 */
export function yymm(date: BusinessDate): string {
  const { year, month } = dateParts(date);
  return `${String(year % 100).padStart(2, "0")}${String(month).padStart(2, "0")}`;
}
