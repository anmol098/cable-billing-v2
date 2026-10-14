/**
 * Ageing rule of the dues report (T-080, FR-023, BRD §12 "Outstanding dues / ageing", PLAN §12.1
 * "Due list + ageing (0–30/31–60/61–90/90+)"). Pure: no clock, no I/O.
 *
 * **The rule.** A bill's due is as old as the number of days from the **1st of the bill's month**
 * (its billing period, the day bills are made: BRD §9 "Billing period: calendar month; scheduled
 * run on day 1") to the report's **as-of date**, both IST calendar dates (CLAUDE.md "business dates
 * use Asia/Kolkata"). There is no separate due date in the data model (PLAN §7.2): a bill is due
 * from its month's first day, so the age does not depend on the day a late or catch-up run made
 * the bill (D-25).
 *
 * | Days old | Bucket |
 * |---|---|
 * | ≤ 30 (incl. a bill dated after the as-of date) | `d0_30` |
 * | 31–60 | `d31_60` |
 * | 61–90 | `d61_90` |
 * | ≥ 91 | `d90_plus` |
 *
 * Example as of 14 Oct 2026: the October bill is 13 days old (0–30), September 43 (31–60), August
 * 74 (61–90), July 105 (90+). On 31 Oct the October bill is 30 days old; on 1 Nov it is 31.
 *
 * Which part of a customer's due is old: a customer's unused advance (credit) pays the **oldest**
 * bills first (D-14 "credit auto-applies oldest-first", PLAN §8.5, BRD §16; T-041 `applyCredit`), so what is left is the newest part of the bills. The
 * report therefore spreads the customer's due (the ledger balance, PLAN §7.2) over the unpaid part
 * of their bills **from the newest bill back**; any due not on a bill yet counts as 0–30 days. This
 * keeps Σ buckets equal to the customer's ledger balance, so the report always adds up to the
 * ledger (FR-023).
 */
import {
  type BusinessDate,
  compareBusinessDates,
  dateParts,
  type Paise,
  type Period,
} from "@cb/domain";

/** The ageing buckets, newest first. */
export const AGEING_BUCKETS = ["d0_30", "d31_60", "d61_90", "d90_plus"] as const;
export type AgeingBucket = (typeof AGEING_BUCKETS)[number];

/** The last day (inclusive) of the first three buckets; older is `d90_plus`. */
export const AGEING_BUCKET_LIMITS = [30, 60, 90] as const;

/** Paise per bucket. */
export type BucketAmounts = Readonly<Record<AgeingBucket, Paise>>;

const DAY_MS = 86_400_000;

function utcDay(date: BusinessDate): number {
  const { year, month, day } = dateParts(date);
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

/** Days from the 1st of `period` to `asOf` (IST calendar dates). Negative when the bill is later. */
export function billAgeInDays(period: Period, asOf: BusinessDate): number {
  return utcDay(asOf) - utcDay(period);
}

/** The bucket of an age in days (see the module comment). */
export function ageingBucketOfDays(days: number): AgeingBucket {
  if (!Number.isInteger(days)) throw new RangeError(`days must be an integer, got ${days}`);
  if (days <= AGEING_BUCKET_LIMITS[0]) return "d0_30";
  if (days <= AGEING_BUCKET_LIMITS[1]) return "d31_60";
  if (days <= AGEING_BUCKET_LIMITS[2]) return "d61_90";
  return "d90_plus";
}

/** The bucket of a bill of `period` on `asOf`. */
export function ageingBucket(period: Period, asOf: BusinessDate): AgeingBucket {
  return ageingBucketOfDays(billAgeInDays(period, asOf));
}

/** One unpaid bill of a customer: its month and what is still unpaid on it (> 0). */
export interface UnpaidBill {
  readonly period: Period;
  readonly id: string;
  readonly outstandingPaise: number;
}

/**
 * The reference implementation of the report's spreading (the SQL does the same, set-based; the
 * tests compare them): a customer's ledger balance spread over their unpaid bills from the newest
 * back (period, then id, descending), the rest of a positive balance in 0–30. A balance ≤ 0 owes
 * nothing.
 */
export function spreadDue(
  balancePaise: number,
  bills: readonly UnpaidBill[],
  asOf: BusinessDate,
): { buckets: Record<AgeingBucket, number>; oldestPeriod: Period | null } {
  const buckets: Record<AgeingBucket, number> = { d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 };
  let left = Math.max(0, balancePaise);
  let oldestPeriod: Period | null = null;
  const newestFirst = [...bills].sort((a, b) => {
    const byPeriod = compareBusinessDates(b.period, a.period);
    return byPeriod !== 0 ? byPeriod : b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
  for (const bill of newestFirst) {
    if (left <= 0) break;
    const part = Math.min(bill.outstandingPaise, left);
    if (part <= 0) continue;
    buckets[ageingBucket(bill.period, asOf)] += part;
    left -= part;
    oldestPeriod = bill.period;
  }
  buckets.d0_30 += left;
  return { buckets, oldestPeriod };
}
