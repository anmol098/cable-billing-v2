/**
 * Review flags for a payment being posted (PLAN §10.4, PRD §13.3, T-051 `ReviewReason`).
 *
 * A genuine collection is never rejected because something changed while the phone was offline:
 * it is posted and flagged (`posted_needs_review`) so the office checks it. Pure: the caller loads
 * the facts and passes the clock.
 *
 * Reasons, in the order they are reported (the first one is stored in `payments.review_reason`;
 * the audit event carries all of them):
 * 1. `customer_inactive`: the customer is deactivated.
 * 2. `collector_inactive`: the user the phone says took the payment is disabled.
 * 3. `collector_mismatch`: the phone says another user took it than the one signed in (PLAN §9.2),
 *    or names a user that is not in this tenant.
 * 4. `device_mismatch`: the phone says another device registration than the token's.
 * 5. `recorded_at_out_of_range`: `recorded_at` is **more than** 10 minutes in the future or
 *    **more than** 7 days old, by the server clock (both bounds are allowed).
 *
 * The claimed collector and device are never used for access or attribution: the payment is
 * stored with the signed-in user and device (T-051 decision 4).
 */
import type { PaymentReviewReason } from "@cb/db";

/** How far in the future `recorded_at` may be before it is flagged (PLAN §10.4). */
export const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;

/** How old `recorded_at` may be before it is flagged (PLAN §10.4). */
export const MAX_RECORDED_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReviewFacts {
  /** Server time of the posting. */
  readonly now: Date;
  readonly recordedAt: Date;
  readonly customerActive: boolean;
  /** The signed-in user (the payment's collector). */
  readonly collectorId: string;
  /** The signed-in device (mobile only). */
  readonly deviceId: string | null;
  /** The collector the phone sent, if any, and whether that user is in the tenant and active. */
  readonly claimedCollector?: {
    readonly id: string;
    readonly status: "active" | "disabled" | "unknown";
  };
  /** The device the phone sent, if any. */
  readonly claimedDeviceId?: string | null;
}

/** Every reason that applies, in reporting order (empty: post normally). */
export function reviewReasons(facts: ReviewFacts): PaymentReviewReason[] {
  const reasons: PaymentReviewReason[] = [];
  if (!facts.customerActive) reasons.push("customer_inactive");
  const claimed = facts.claimedCollector;
  if (claimed) {
    if (claimed.status === "disabled") reasons.push("collector_inactive");
    if (!sameId(claimed.id, facts.collectorId)) reasons.push("collector_mismatch");
  }
  const claimedDevice = facts.claimedDeviceId ?? null;
  if (claimedDevice !== null && !sameId(claimedDevice, facts.deviceId)) {
    reasons.push("device_mismatch");
  }
  if (isRecordedAtOutOfRange(facts.recordedAt, facts.now)) reasons.push("recorded_at_out_of_range");
  return reasons;
}

/** UUIDs compare case-insensitively. */
function sameId(a: string, b: string | null): boolean {
  return b !== null && a.toLowerCase() === b.toLowerCase();
}

/** PLAN §10.4: > 10 min in the future or > 7 days old. */
export function isRecordedAtOutOfRange(recordedAt: Date, now: Date): boolean {
  const delta = recordedAt.getTime() - now.getTime();
  return delta > MAX_FUTURE_SKEW_MS || -delta > MAX_RECORDED_AGE_MS;
}
