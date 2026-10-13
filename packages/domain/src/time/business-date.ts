/**
 * Business dates (PLAN §7.1): instants are stored as UTC `timestamptz`; the **business date** of an
 * instant is its calendar date in India (`Asia/Kolkata`). Payments, collection sessions and billing
 * periods all use it.
 *
 * India has used a fixed +05:30 offset with no daylight saving since 1945, so the conversion is plain
 * arithmetic on the epoch: no `Intl`, no tz database, identical on every runtime (and on Android,
 * which can mirror it with `ZoneOffset.ofHoursMinutes(5, 30)`). The IST day starts at **18:30 UTC**
 * the previous day.
 *
 * A `BusinessDate` is the ISO text `"YYYY-MM-DD"`, exactly what Postgres `date` columns hold and what
 * Drizzle returns in `mode: "string"`. Years 1000–9999 are supported.
 *
 * Functions take the instant as an argument. Nothing here reads the clock: pass `new Date()` in.
 */

import { type DomainError, domainError, err, ok, type Result } from "../result";

export const IST_TIME_ZONE = "Asia/Kolkata";

/** +05:30. */
export const IST_OFFSET_MINUTES = 330;

const MINUTE_MS = 60_000;
const IST_OFFSET_MS = IST_OFFSET_MINUTES * MINUTE_MS;
const MIN_YEAR = 1000;
const MAX_YEAR = 9999;

declare const businessDateBrand: unique symbol;

/** A calendar date in India, as `"YYYY-MM-DD"`. */
export type BusinessDate = string & { readonly [businessDateBrand]: true };

/** A point in time: a `Date` or epoch milliseconds. */
export type Instant = Date | number;

export type DateParts = { year: number; month: number; day: number };

function epochMs(instant: Instant): number {
  const ms = typeof instant === "number" ? instant : instant.getTime();
  if (!Number.isFinite(ms)) throw new RangeError("invalid instant");
  return ms;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** Days in `month` (1–12) of `year`, Gregorian. */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function validParts({ year, month, day }: DateParts): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    Number.isInteger(day) &&
    year >= MIN_YEAR &&
    year <= MAX_YEAR &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

/** Builds a business date from its parts. Throws `RangeError` for impossible dates (30 Feb). */
export function businessDateFromParts(parts: DateParts): BusinessDate {
  if (!validParts(parts)) {
    throw new RangeError(`invalid date: ${parts.year}-${parts.month}-${parts.day}`);
  }
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}` as BusinessDate;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `"2026-10-12"` → `{ year: 2026, month: 10, day: 12 }`. */
export function dateParts(date: BusinessDate): DateParts {
  const match = ISO_DATE.exec(date);
  if (!match) throw new RangeError(`not a business date: "${date}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function isBusinessDate(value: unknown): value is BusinessDate {
  if (typeof value !== "string") return false;
  const match = ISO_DATE.exec(value);
  return match !== null && validParts(dateParts(value as BusinessDate));
}

/** Validates `"YYYY-MM-DD"` (from a form, a URL or the API). */
export function parseBusinessDate(value: string): Result<BusinessDate, DomainError<"VALIDATION">> {
  return isBusinessDate(value)
    ? ok(value)
    : err(domainError("VALIDATION", "expected a date as YYYY-MM-DD", { value }));
}

/** Like {@link parseBusinessDate} but throws `RangeError`. For constants and trusted DB values. */
export function businessDate(value: string): BusinessDate {
  if (!isBusinessDate(value)) throw new RangeError(`not a business date: "${value}"`);
  return value;
}

/** The business date (IST calendar date) of an instant. The day changes at 18:30 UTC. */
export function businessDateOf(instant: Instant): BusinessDate {
  const shifted = new Date(epochMs(instant) + IST_OFFSET_MS);
  return businessDateFromParts({
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  });
}

/** The instant the business date starts: 00:00 IST, i.e. 18:30 UTC on the previous day. */
export function istStartOfDay(date: BusinessDate): Date {
  const { year, month, day } = dateParts(date);
  return new Date(Date.UTC(year, month - 1, day) - IST_OFFSET_MS);
}

/**
 * The half-open range of instants `[start, end)` that fall on the business date, for queries such as
 * "payments recorded on 12 Oct": `recorded_at >= start AND recorded_at < end`.
 */
export function istDayRange(date: BusinessDate): { start: Date; end: Date } {
  return { start: istStartOfDay(date), end: istStartOfDay(addDays(date, 1)) };
}

/** `date` plus `days` (may be negative). */
export function addDays(date: BusinessDate, days: number): BusinessDate {
  if (!Number.isSafeInteger(days)) throw new RangeError(`days must be an integer, got ${days}`);
  const { year, month, day } = dateParts(date);
  // Date.UTC normalises day overflow (32 Oct → 1 Nov) and is exact for years ≥ 100.
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return businessDateFromParts({
    year: moved.getUTCFullYear(),
    month: moved.getUTCMonth() + 1,
    day: moved.getUTCDate(),
  });
}

/** For sorting: ascending. ISO dates compare correctly as text. */
export function compareBusinessDates(a: BusinessDate, b: BusinessDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
