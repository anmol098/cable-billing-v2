/**
 * The subscription state machine (PLAN §13, D-12, D-13, D-20, D-25). Pure: no I/O, no clock (the
 * caller passes `now`). The same function serves the Razorpay webhook, the daily cron, the
 * reconciliation with Razorpay's API, checkout confirmation and the admin's manual extension, so
 * every path moves a tenant the same way.
 *
 * | From | When | To |
 * |---|---|---|
 * | `trialing` | the clock reaches `trial_ends_at` | `grace` |
 * | any | Razorpay says the subscription is `active` and paid until a future `current_end` | `active` (`current_period_end` = the latest paid end) |
 * | `active` | the clock reaches `current_period_end` (no newer charge) | `grace`, or `cancelled` when the Owner cancelled autopay |
 * | `grace` | the clock reaches `grace_ends_at` | `read_only` |
 * | `grace`, `read_only` | Razorpay says the subscription was cancelled | `cancelled` |
 * | any | the platform admin extends until a future date (T-086) | `active` |
 *
 * - **Grace** lasts {@link GRACE_DAYS} whole IST days from the moment access lapsed
 *   (`grace_ends_at` = 00:00 IST, {@link graceEndsAt}); a late cron run never makes it longer.
 * - **Cancelling** autopay while paid time is left keeps the tenant `active` until the paid month
 *   ends (paid time is honoured), then `cancelled` (no grace: the Owner chose to stop). A trial is
 *   free, so cancelling during it changes nothing. Paying again (a new subscription) re-activates.
 * - Razorpay snapshots of a subscription that is not the tenant's current one are ignored, and
 *   an older snapshot never overwrites a newer one (`razorpay_status_at`); webhooks arrive out of
 *   order. Activation is order-safe anyway: the paid end only ever moves forward.
 * - `read_only` and `cancelled` are read-only mode (T-025 `tenantModeOf`); D-13 allowlist applies.
 */
import {
  RAZORPAY_SUBSCRIPTION_STATUSES,
  type RazorpaySubscriptionStatus,
  type SubscriptionStatus,
} from "@cb/db";
import { addDays, type BusinessDate, businessDateOf, istStartOfDay } from "@cb/domain";
import { GRACE_DAYS, REMINDER_DAYS_BEFORE } from "./plan";

export { RAZORPAY_SUBSCRIPTION_STATUSES, type RazorpaySubscriptionStatus };

export function isRazorpaySubscriptionStatus(value: unknown): value is RazorpaySubscriptionStatus {
  return (
    typeof value === "string" &&
    (RAZORPAY_SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

/** Razorpay statuses that mean autopay is set up and will charge (no "please pay" reminders). */
export const AUTOPAY_ON_STATUSES: readonly RazorpaySubscriptionStatus[] = [
  "authenticated",
  "active",
];

/** The columns of a `subscriptions` row the machine reads and writes. */
export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly graceEndsAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly razorpaySubscriptionId: string | null;
  readonly razorpayStatus: RazorpaySubscriptionStatus | null;
  readonly razorpayStatusAt: Date | null;
}

/** What Razorpay says about one subscription at one moment (a webhook body or an API read). */
export interface RazorpaySnapshot {
  readonly subscriptionId: string;
  readonly status: RazorpaySubscriptionStatus;
  /** End of the current (paid, when `active`) cycle. */
  readonly currentEnd: Date | null;
  /** When Razorpay produced it (event `created_at`, or the time of the API read). */
  readonly at: Date;
}

export type SubscriptionChange =
  /** Only the clock moved (daily cron). */
  | { readonly kind: "clock" }
  /** A webhook or an API read of the tenant's Razorpay subscription. */
  | { readonly kind: "razorpay"; readonly snapshot: RazorpaySnapshot }
  /** The Owner opened checkout for a new Razorpay subscription (it replaces the old one). */
  | { readonly kind: "checkout_created"; readonly subscriptionId: string }
  /** The platform admin recorded an offline payment / extended access until `until` (T-086). */
  | { readonly kind: "manual_extend"; readonly until: Date };

export interface SubscriptionStep {
  readonly state: SubscriptionState;
  /** Status changes in order (e.g. trialing → grace → read_only after a long outage). */
  readonly transitions: readonly { from: SubscriptionStatus; to: SubscriptionStatus }[];
  /** True when the tenant left read-only mode (D-25: show the missed bill runs). */
  readonly reactivated: boolean;
  /** Why a change was not applied (for logs and the event record). */
  readonly ignored?: "not_current_subscription" | "older_snapshot" | "until_in_past";
}

const READ_ONLY: readonly SubscriptionStatus[] = ["read_only", "cancelled"];

/** The first IST midnight at or after `instant`. */
export function istMidnightOnOrAfter(instant: Date): Date {
  const day = businessDateOf(instant);
  const start = istStartOfDay(day);
  return start.getTime() === instant.getTime() ? start : istStartOfDay(addDays(day, 1));
}

/**
 * When grace ends for access that lapsed at `lapsedAt`: {@link GRACE_DAYS} whole IST days after
 * the lapse (the rest of a lapse day is free on top), ending at 00:00 IST. A trial that ends at
 * 00:00 IST on 13 Nov gives grace until 00:00 IST on 28 Nov ("pay by 27 Nov").
 */
export function graceEndsAt(lapsedAt: Date, days: number = GRACE_DAYS): Date {
  return istStartOfDay(addDays(businessDateOf(istMidnightOnOrAfter(lapsedAt)), days));
}

/** The last IST day that still has access when access ends at `endsAt` (an IST midnight). */
export function lastDayBefore(endsAt: Date): BusinessDate {
  return businessDateOf(new Date(endsAt.getTime() - 1));
}

function laterOf(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function moveTo(
  state: Mutable<SubscriptionState>,
  to: SubscriptionStatus,
  transitions: { from: SubscriptionStatus; to: SubscriptionStatus }[],
): void {
  if (state.status === to) return;
  transitions.push({ from: state.status, to });
  state.status = to;
}

/** Date-based transitions, repeated until nothing moves (a long outage may skip a whole grace). */
function applyClock(
  state: Mutable<SubscriptionState>,
  now: Date,
  transitions: { from: SubscriptionStatus; to: SubscriptionStatus }[],
): void {
  for (let i = 0; i < 3; i += 1) {
    const t = now.getTime();
    if (state.status === "trialing" && state.trialEndsAt && t >= state.trialEndsAt.getTime()) {
      state.graceEndsAt = graceEndsAt(state.trialEndsAt);
      moveTo(state, "grace", transitions);
      continue;
    }
    if (
      state.status === "active" &&
      state.currentPeriodEnd &&
      t >= state.currentPeriodEnd.getTime()
    ) {
      if (state.cancelledAt) {
        moveTo(state, "cancelled", transitions);
      } else {
        state.graceEndsAt = graceEndsAt(state.currentPeriodEnd);
        moveTo(state, "grace", transitions);
      }
      continue;
    }
    if (state.status === "grace" && state.graceEndsAt && t >= state.graceEndsAt.getTime()) {
      moveTo(state, "read_only", transitions);
      continue;
    }
    return;
  }
}

function activate(
  state: Mutable<SubscriptionState>,
  paidUntil: Date,
  transitions: { from: SubscriptionStatus; to: SubscriptionStatus }[],
): void {
  state.currentPeriodEnd = laterOf(state.currentPeriodEnd, paidUntil);
  state.graceEndsAt = null;
  state.cancelledAt = null;
  moveTo(state, "active", transitions);
}

/** Applies `change` at `now` and then the clock. Never mutates `current`. */
export function nextSubscriptionState(
  current: SubscriptionState,
  change: SubscriptionChange,
  now: Date,
): SubscriptionStep {
  const state: Mutable<SubscriptionState> = { ...current };
  const transitions: { from: SubscriptionStatus; to: SubscriptionStatus }[] = [];
  let ignored: SubscriptionStep["ignored"];

  switch (change.kind) {
    case "clock":
      break;
    case "checkout_created":
      if (state.razorpaySubscriptionId !== change.subscriptionId) {
        state.razorpaySubscriptionId = change.subscriptionId;
        state.razorpayStatus = "created";
        state.razorpayStatusAt = now;
        // A new autopay replaces a cancelled one: when the paid month ends, ask to pay (grace)
        // rather than stopping as if the Owner had cancelled.
        state.cancelledAt = null;
      }
      break;
    case "manual_extend":
      if (change.until.getTime() <= now.getTime()) ignored = "until_in_past";
      else activate(state, change.until, transitions);
      break;
    case "razorpay": {
      const snap = change.snapshot;
      if (snap.subscriptionId !== state.razorpaySubscriptionId) {
        ignored = "not_current_subscription";
        break;
      }
      const newer =
        !state.razorpayStatusAt || snap.at.getTime() >= state.razorpayStatusAt.getTime();
      if (newer) {
        state.razorpayStatus = snap.status;
        state.razorpayStatusAt = snap.at;
      } else {
        ignored = "older_snapshot";
      }
      // Paid until a future date: true whenever Razorpay said so, so it is safe in any order.
      if (
        snap.status === "active" &&
        snap.currentEnd &&
        snap.currentEnd.getTime() > now.getTime()
      ) {
        activate(state, snap.currentEnd, transitions);
        ignored = undefined;
      } else if (snap.status === "cancelled" && newer) {
        state.cancelledAt ??= snap.at;
        if (state.status === "grace" || state.status === "read_only") {
          moveTo(state, "cancelled", transitions);
        }
      }
      break;
    }
  }

  applyClock(state, now, transitions);
  const wasReadOnly = READ_ONLY.includes(current.status);
  const isReadOnly = READ_ONLY.includes(state.status);
  return {
    state,
    transitions,
    reactivated: wasReadOnly && !isReadOnly,
    ...(ignored ? { ignored } : {}),
  };
}

/** True when the two states would write the same row. */
export function sameSubscriptionState(a: SubscriptionState, b: SubscriptionState): boolean {
  const time = (d: Date | null) => (d ? d.getTime() : null);
  return (
    a.status === b.status &&
    time(a.trialEndsAt) === time(b.trialEndsAt) &&
    time(a.currentPeriodEnd) === time(b.currentPeriodEnd) &&
    time(a.graceEndsAt) === time(b.graceEndsAt) &&
    time(a.cancelledAt) === time(b.cancelledAt) &&
    a.razorpaySubscriptionId === b.razorpaySubscriptionId &&
    a.razorpayStatus === b.razorpayStatus &&
    time(a.razorpayStatusAt) === time(b.razorpayStatusAt)
  );
}

// ---------------------------------------------------------------------------------------------
// Reminder emails (PLAN §14: T-7, T-1 and grace start)
// ---------------------------------------------------------------------------------------------

/**
 * - `trial_ending`: the free trial ends in 7 days / 1 day (not when autopay is already set up).
 * - `grace_started`: the trial or the paid month ended without a payment; pay within the grace.
 * - `grace_ending`: view-only mode starts in 7 days / 1 day.
 * - `reactivated`: payment arrived after view-only mode; shows the missed bill runs (D-25).
 */
export type SubscriptionNoticeKind =
  | "trial_ending"
  | "grace_started"
  | "grace_ending"
  | "reactivated";

export interface SubscriptionNotice {
  readonly kind: SubscriptionNoticeKind;
  /**
   * Once per tenant: `<kind>:<days>:<end date>` (e.g. `trial_ending:7:2026-11-13`). Recorded in
   * the audit log when sent, so a re-run (or a retried cron) never sends it twice.
   */
  readonly key: string;
  /** When access changes (an IST midnight): trial end, or grace end. */
  readonly endsAt: Date;
  /** The last IST day with full access (what the email says). */
  readonly lastDay: BusinessDate;
  /** Whole IST days from today until `endsAt`'s date (7, 1 …; 0 for `reactivated`). */
  readonly daysLeft: number;
}

/** IST calendar days from `now`'s date to `endsAt`'s date. */
export function daysUntil(endsAt: Date, now: Date): number {
  const DAY = 86_400_000;
  const end = istStartOfDay(businessDateOf(endsAt)).getTime();
  const today = istStartOfDay(businessDateOf(now)).getTime();
  return Math.round((end - today) / DAY);
}

function countdownNotice(
  kind: "trial_ending" | "grace_ending",
  endsAt: Date,
  now: Date,
): SubscriptionNotice | null {
  const left = daysUntil(endsAt, now);
  if (left <= 0) return null;
  // The most urgent window that contains `left` (a missed cron day still sends the reminder).
  const thresholds = [...REMINDER_DAYS_BEFORE].sort((a, b) => a - b);
  const days = thresholds.find((threshold) => left <= threshold);
  if (days === undefined) return null;
  const lastDay = lastDayBefore(endsAt);
  return {
    kind,
    key: `${kind}:${days}:${businessDateOf(endsAt)}`,
    endsAt,
    lastDay,
    daysLeft: left,
  };
}

/** The reminder (at most one) the Owner should get now for `state`. */
export function dueNotice(state: SubscriptionState, now: Date): SubscriptionNotice | null {
  if (state.status === "trialing" && state.trialEndsAt) {
    const autopay =
      state.razorpaySubscriptionId !== null &&
      state.razorpayStatus !== null &&
      AUTOPAY_ON_STATUSES.includes(state.razorpayStatus);
    return autopay ? null : countdownNotice("trial_ending", state.trialEndsAt, now);
  }
  if (state.status === "grace" && state.graceEndsAt) {
    const ending = countdownNotice("grace_ending", state.graceEndsAt, now);
    if (ending) return ending;
    return {
      kind: "grace_started",
      key: `grace_started:0:${businessDateOf(state.graceEndsAt)}`,
      endsAt: state.graceEndsAt,
      lastDay: lastDayBefore(state.graceEndsAt),
      daysLeft: daysUntil(state.graceEndsAt, now),
    };
  }
  return null;
}

/** The "working again" notice after a payment ends read-only mode. */
export function reactivatedNotice(state: SubscriptionState, now: Date): SubscriptionNotice {
  const endsAt = state.currentPeriodEnd ?? now;
  return {
    kind: "reactivated",
    key: `reactivated:0:${now.toISOString()}`,
    endsAt,
    lastDay: lastDayBefore(endsAt),
    daysLeft: 0,
  };
}
