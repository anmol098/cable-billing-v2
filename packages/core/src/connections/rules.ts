/**
 * Connection (VC) rules that need no database (T-034; FR-005, FR-006, BR-03, BR-04, RULE-06 to
 * RULE-09, PLAN §8.1, §8.3). The services in ./services.ts apply them inside the transaction; the
 * web Connections tab uses the same functions for its plain-language effect text.
 *
 * **Transitions** (FR-006). The status of an assignment is the status after its latest event:
 *
 * | Action | From | To |
 * |---|---|---|
 * | suspend ("Stop") | active | suspended |
 * | reactivate ("Start again") | suspended | active |
 * | disconnect ("Remove") | active, suspended | disconnected (final) |
 * | change plan | active, suspended | (same) |
 *
 * A disconnected assignment never changes again; the VC goes to a customer as a **new**
 * assignment (RULE-07, PRD §15 #6), so the old one and its bills stay with the old customer.
 *
 * **Dates** (IST business dates). A status change takes effect at the **end** of its effective
 * day (PLAN §8.1, T-040), a start at the start of its day. So:
 * - suspend / disconnect effective D: rent stops from the month after D's month ("Rent stops from
 *   November"); D's own month stays charged (PLAN §8.3).
 * - reactivate effective D: the monthly bill charges it again from the month after D's month
 *   (T-040 Q-1: a reactivation on the 1st is still stopped during the 1st); D's own month is the
 *   D-18 mid-month case, decided by the T-045 hook.
 * - start on D: billed from D's month when D is the 1st, else from the next month; a mid-month
 *   start's own month is again the D-18 hook's.
 * - plan change effective D: the new rent applies to D's month (BR-07: "full new rental in the
 *   current month"); if that month is already billed, the T-045 hook nets it.
 *
 * Every rule below works from these facts.
 *
 * **Which dates are allowed**
 * - Status and plan changes: not in the future (`in_future`), not before the assignment's start
 *   (`before_start`), and not before its latest change (`before_last_change`), so the events stay
 *   in date order and `status` always matches the latest event.
 * - Starts: at most {@link MAX_START_DAYS_AHEAD} day ahead (a VC removed from one customer today
 *   can be installed at the next one tomorrow: both date ends are inclusive, T-022).
 * - Nothing before {@link EARLIEST_BUSINESS_DATE} (`too_old`: a typing slip, not history).
 * - **Back-dating into a billed month (PLAN §8.3).** A change effective D can alter what the
 *   months **after** D's month should have charged (D's own month is handled by the T-045 hook).
 *   When one of those months is already billed for the customer the change would silently rewrite
 *   a bill, so it is refused (`billed_period`) for Staff; the Owner's guided flow (an explicit
 *   adjustment with a reason) is T-045's. In other words, the earliest allowed date is the 1st of
 *   the customer's latest billed month ({@link earliestAllowedDate}).
 */

import type { AssignmentStatus } from "@cb/db";
import {
  addDays,
  type BusinessDate,
  compareBusinessDates,
  comparePeriods,
  isBillingDay,
  nextPeriod,
  type Period,
  periodOf,
} from "@cb/domain";

/** What a person can do to a connection. */
export const CONNECTION_ACTIONS = ["suspend", "reactivate", "disconnect", "change_plan"] as const;
export type ConnectionAction = (typeof CONNECTION_ACTIONS)[number];

/** The status changes (everything but a plan change). */
export type StatusAction = Exclude<ConnectionAction, "change_plan">;

/**
 * Why a connection is stopped or removed (stored in `assignment_events.reason`, shown through
 * i18n). `other` takes a short note.
 */
export const STOP_REASONS = [
  "not_paying",
  "customer_asked",
  "moved_away",
  "box_problem",
  "other",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

/** A start may be dated at most this many days after today. */
export const MAX_START_DAYS_AHEAD = 1;

/** No business date before this is accepted (a typing slip). */
export const EARLIEST_BUSINESS_DATE = "2000-01-01" as BusinessDate;

export const CONNECTION_LIMITS = {
  /** Characters of a VC number once normalised (the T-022 CHECK). */
  vcNumber: 64,
  /** Characters accepted as typed (spaces and dashes are removed). */
  vcNumberInput: 128,
  /** A stop/remove note. */
  note: 200,
  /** Largest monthly rent: ₹1,00,000 (a typing slip above that). */
  maxRentalPaise: 10_000_000,
  /** Connections in one "Add customer" save. */
  connectionsPerCustomer: 10,
} as const;

const NEXT_STATUS: Readonly<
  Record<ConnectionAction, Partial<Record<AssignmentStatus, AssignmentStatus>>>
> = {
  suspend: { active: "suspended" },
  reactivate: { suspended: "active" },
  disconnect: { active: "disconnected", suspended: "disconnected" },
  change_plan: { active: "active", suspended: "suspended" },
};

/** The status after `action`, or `null` when `action` is not allowed from `status`. */
export function nextStatus(
  status: AssignmentStatus,
  action: ConnectionAction,
): AssignmentStatus | null {
  return NEXT_STATUS[action][status] ?? null;
}

/** The actions allowed from `status`, in display order. */
export function allowedActions(status: AssignmentStatus): ConnectionAction[] {
  return CONNECTION_ACTIONS.filter((action) => nextStatus(status, action) !== null);
}

/** The `assignment_events.type` an action records. */
export function eventTypeOf(
  action: ConnectionAction,
): "suspended" | "reactivated" | "disconnected" | "plan_changed" {
  switch (action) {
    case "suspend":
      return "suspended";
    case "reactivate":
      return "reactivated";
    case "disconnect":
      return "disconnected";
    case "change_plan":
      return "plan_changed";
  }
}

/** Suspended or disconnected effective `date`: the first month without rent. */
export function rentStopsFrom(date: BusinessDate): Period {
  return nextPeriod(periodOf(date));
}

/**
 * The first month the **monthly bill** charges a connection that starts (or is reactivated)
 * effective `date`. The month of `date` itself, when not included, is the D-18 mid-month case.
 */
export function billedFrom(kind: "start" | "reactivate", date: BusinessDate): Period {
  if (kind === "start" && isBillingDay(date)) return periodOf(date);
  return nextPeriod(periodOf(date));
}

/** True when the monthly bill of `date`'s own month does not cover the start / reactivation. */
export function isMidMonth(kind: "start" | "reactivate", date: BusinessDate): boolean {
  return billedFrom(kind, date) !== periodOf(date);
}

/**
 * The earliest effective date that does not reach back into a billed month, given the customer's
 * latest billed month (`null`: never billed, any date).
 */
export function earliestAllowedDate(latestBilledPeriod: Period | null): BusinessDate | null {
  return latestBilledPeriod;
}

/** True when a change effective `date` would alter a month that is already billed. */
export function reachesBilledPeriod(
  date: BusinessDate,
  latestBilledPeriod: Period | null,
): boolean {
  return latestBilledPeriod !== null && comparePeriods(latestBilledPeriod, periodOf(date)) > 0;
}

export type DateProblem = "in_future" | "too_old" | "before_start" | "before_last_change";

/** A status or plan change dated `date` (see the module comment). `null` = fine. */
export function changeDateProblem(input: {
  readonly date: BusinessDate;
  readonly today: BusinessDate;
  readonly startDate: BusinessDate;
  /** The latest event's effective date (the start when there is none). */
  readonly lastChangeDate: BusinessDate;
}): DateProblem | null {
  if (compareBusinessDates(input.date, EARLIEST_BUSINESS_DATE) < 0) return "too_old";
  if (compareBusinessDates(input.date, input.today) > 0) return "in_future";
  if (compareBusinessDates(input.date, input.startDate) < 0) return "before_start";
  if (compareBusinessDates(input.date, input.lastChangeDate) < 0) return "before_last_change";
  return null;
}

/** A start dated `date`. `null` = fine. */
export function startDateProblem(input: {
  readonly date: BusinessDate;
  readonly today: BusinessDate;
}): "in_future" | "too_old" | null {
  if (compareBusinessDates(input.date, EARLIEST_BUSINESS_DATE) < 0) return "too_old";
  if (compareBusinessDates(input.date, latestStartDate(input.today)) > 0) return "in_future";
  return null;
}

/** The latest start date allowed today. */
export function latestStartDate(today: BusinessDate): BusinessDate {
  return addDays(today, MAX_START_DAYS_AHEAD);
}

/**
 * `assignment_events.reason` for a stop/remove: the reason code, or `code: note` with a note
 * (trimmed, at most {@link CONNECTION_LIMITS}.note characters).
 */
export function formatStopReason(reason: StopReason, note?: string | null): string {
  const text = note?.trim() ?? "";
  return text === "" ? reason : `${reason}: ${text}`;
}

/** Reads a stored reason back: a known code (+ note), or the text as stored (migrated rows). */
export function parseStopReason(
  stored: string | null,
): { readonly code: StopReason | null; readonly note: string | null } | null {
  if (stored === null || stored.trim() === "") return null;
  const match = /^([a-z_]+)(?::\s?([\s\S]*))?$/.exec(stored);
  const code = match?.[1];
  if (code && (STOP_REASONS as readonly string[]).includes(code)) {
    const note = match?.[2]?.trim() ?? "";
    return { code: code as StopReason, note: note === "" ? null : note };
  }
  return { code: null, note: stored };
}

/** A VC number as the services accept it: printable ASCII once spaces and dashes are removed. */
export const VC_NUMBER_PATTERN = /^[\x21-\x7e]+$/;
