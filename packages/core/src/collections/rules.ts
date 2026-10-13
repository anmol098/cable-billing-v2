/**
 * The pure rules of collection sessions and the cash handover (T-062, PLAN §8.7, FR-022, B-016).
 * No I/O, no clock: callers pass `now`.
 *
 * **Expected cash** (PLAN §8.7 "Server totals: cash_expected, upi_total, count"; FR-022 "cash
 * expected vs handed over"; B-014 "Cash and UPI … separate"):
 *
 * > expected cash of a lineman's day = Σ `amount_paise` of the payments the server has with
 * > `collector_id` = the lineman, `business_date` = the day (IST date of `recorded_at`),
 * > `source = 'android'`, **`method = 'cash'`** and **no `payment_reversals` row**.
 *
 * UPI is never expected as cash (it went to the operator's account, BRD B-014; contract
 * `CollectionDay.upi_total_paise` "Not part of the cash handover"), and a reversed payment is not
 * money the lineman holds for the office (PLAN §8.6; contract "reversed payments are not in the
 * totals"). Payments still on the phone are not counted (the server can't know them; the phone
 * reports them with the handover, and {@link phoneMayHoldPayments} warns from its last contact).
 * These are exactly the running totals T-046 keeps on `collection_sessions` in the posting and
 * reversal transactions (`cash_expected_paise`, `upi_total_paise`, `payment_count`); the tests
 * recompute them from the payments.
 *
 * **Discrepancy** (PLAN §8.7 "Discrepancy = handed − expected"; contract `Handover.discrepancy_paise`
 * "cash_handed_over_paise − cash_expected_paise, computed by the server. Negative = short, positive
 * = extra"): computed by the server from the expected cash at the moment of submission (the
 * snapshot `handover_cash_expected_paise`), never taken from the phone. A non-zero discrepancy
 * needs a reason (`short | extra | pending_sync | other`); at zero the reason is dropped.
 */
import { type BusinessDate, istDayRange } from "@cb/domain";

/**
 * A phone's last contact older than this before the cut-off may mean payments are still on it.
 * `devices.last_seen_at` moves on sign-in and on every token refresh, i.e. about every 15 minutes
 * while the app is in use or the payment sync runs (T-028), so twice that is "not heard from".
 */
export const PHONE_STALE_AFTER_MS = 30 * 60 * 1000;

/** `handed − expected` (paise). Negative = short, positive = extra. */
export function discrepancyOf(cashHandedOverPaise: number, cashExpectedPaise: number): number {
  const value = cashHandedOverPaise - cashExpectedPaise;
  if (!Number.isSafeInteger(value)) throw new RangeError("discrepancy is not a safe integer");
  return value;
}

/**
 * The reason stored with a handover: the lineman's reason when the cash differs, else `null`
 * (contract: "The lineman's reason when there is a discrepancy, else null"). `undefined` means a
 * reason is required and missing.
 */
export function storedReason<R extends string>(
  discrepancyPaise: number,
  reason: R | null | undefined,
): R | null | undefined {
  if (discrepancyPaise === 0) return null;
  return reason ?? undefined;
}

export interface PhoneContactInput {
  /** Newest `devices.last_seen_at` of the lineman's phones that are not signed out; null = none. */
  readonly lastSeenAt: Date | null;
  /** When the server last received a handover for the day (also a contact), if any. */
  readonly submittedAt: Date | null;
  readonly businessDate: BusinessDate;
  readonly now: Date;
}

/**
 * The time of the phone's last known contact with the server: the later of the device's last
 * seen time and the day's latest handover submission. `null` when there is neither.
 */
export function lastContactOf(input: Pick<PhoneContactInput, "lastSeenAt" | "submittedAt">) {
  const { lastSeenAt, submittedAt } = input;
  if (lastSeenAt === null) return submittedAt;
  if (submittedAt === null) return lastSeenAt;
  return lastSeenAt.getTime() >= submittedAt.getTime() ? lastSeenAt : submittedAt;
}

/**
 * True when payments of `businessDate` **may** still be on the lineman's phone because the phone
 * has not been in touch since that day's collecting could have ended:
 *
 * `lastContact < min(now, end of the IST business day) − PHONE_STALE_AFTER_MS`.
 *
 * - No phone at all (never signed in, or every phone signed out) → `false`: nothing can be
 *   waiting on a phone the server knows of (the card says "No phone").
 * - A phone online after the day ended → `false`: the app pushes saved payments whenever it is
 *   online (T-066), so anything of that day had its chance to arrive.
 * - It is a warning ("may"), never a claim: the exact count is what the phone reports with its
 *   handover (`unsynced_payment_count`).
 */
export function phoneMayHoldPayments(input: PhoneContactInput): boolean {
  const lastContact = lastContactOf(input);
  if (lastContact === null) return false;
  const dayEnd = istDayRange(input.businessDate).end.getTime();
  const cutoff = Math.min(input.now.getTime(), dayEnd);
  return lastContact.getTime() < cutoff - PHONE_STALE_AFTER_MS;
}
