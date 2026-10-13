/**
 * Pure rules for new tenants (T-027): the trial end date (D-20), the owner's mobile number and
 * the sign-in names we can give the owner. No I/O.
 */
import { addDays, type BusinessDate, businessDateOf, istStartOfDay } from "@cb/domain";

/** D-20: every new tenant starts with a 30-day trial. */
export const TRIAL_DAYS = 30;

/**
 * When the trial ends, for a tenant created at `now`.
 *
 * Rule (IST/UTC): the trial covers the rest of the IST sign-up day plus `days` whole IST days, so
 * it ends at **00:00 IST on (IST sign-up date + days + 1)**, stored as that UTC instant (18:30 UTC
 * the day before). Example: signing up at any time on 13 Oct 2026 IST gives a trial that runs
 * through 12 Nov 2026 ("free till 12 Nov") and `trial_ends_at = 2026-11-12T18:30:00Z`.
 *
 * Why: the trial is never shorter than `days × 24 h`, the end is a whole IST day that the
 * operator can be told in words ({@link trialLastDay}), and the daily subscription-state job
 * (T-085) gives the same answer whatever time of day it runs.
 */
export function trialEndsAt(now: Date, days: number = TRIAL_DAYS): Date {
  return istStartOfDay(addDays(trialLastDay(now, days), 1));
}

/** The last free IST day of a trial that starts at `now` (what we show: "free till 12 Nov"). */
export function trialLastDay(now: Date, days: number = TRIAL_DAYS): BusinessDate {
  if (!Number.isSafeInteger(days) || days < 0 || days > 366) {
    throw new RangeError(`trial days must be a whole number from 0 to 366, got ${days}`);
  }
  return addDays(businessDateOf(now), days);
}

/**
 * An Indian mobile number as 10 digits (starts with 6–9), from what people type: spaces, dashes,
 * `+91`, `91` or a leading `0` are accepted. `null` when it is not a mobile number.
 */
export function normalizeIndianMobile(value: string): string | null {
  const digits = value.replace(/[\s\-().]/g, "");
  const match = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  return match?.[1] ?? null;
}

/** How many sign-in names we try for one owner before giving up (see ownerLoginCandidates). */
export const MAX_LOGIN_CANDIDATES = 10;

/**
 * Sign-in names to try for a new owner, best first: the mobile number itself (people remember
 * it, and the login form takes "mobile no., user name or email"), then `<mobile>-2`,
 * `<mobile>-3`… in case another account already uses that number as its user name (user names
 * are unique across all operators). The owner can always sign in with their email too.
 */
export function ownerLoginCandidates(mobile: string): string[] {
  const base = mobile.toLowerCase();
  return Array.from({ length: MAX_LOGIN_CANDIDATES }, (_, index) =>
    index === 0 ? base : `${base}-${index + 1}`,
  );
}
