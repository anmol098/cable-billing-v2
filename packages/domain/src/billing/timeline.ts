/**
 * Billing eligibility (PLAN §8.1; FR-010, RULE-08, RULE-09, BR-08) and the rental in effect for a
 * period (FR-008, BR-07, D-14).
 *
 * > A VC assignment is charged its full rental for month **P** if it is **active at any time on the
 * > 1st of P**. Status changes take effect **at the end of their effective day**.
 *
 * How the rule reads on a day-by-day timeline (each business date is one IST calendar day):
 *
 * - **Start.** The assignment is active from the *start* of `startDate`. PLAN §8.1: "Starts on the
 *   1st before the run, so it is included in that month's run." (If a start took effect at the end
 *   of its day, an assignment starting on the 1st would never be billed for that month.)
 * - **Status changes** (`suspended`, `reactivated`, `disconnected`) take effect at the *end* of their
 *   effective day: on the effective date itself the old status still holds; the new one holds from
 *   the next day. So the status *during* a day is constant, and it is decided only by changes
 *   effective on an **earlier** day.
 * - **End.** `endDate` is the last day of service (inclusive), the same day as the `disconnected`
 *   event. An `endDate` with no `disconnected` event (for example a migrated assignment, RULE-21) is
 *   read as a disconnection effective that day.
 *
 * Therefore "active at any time on the 1st of P" ⇔ `startDate ≤ 1st` and the status after applying
 * every change effective **before** the 1st is `active`.
 *
 * | Timeline | Billed for P? | Why |
 * |---|---|---|
 * | starts on the 1st | yes | active from the start of the 1st |
 * | starts on the 2nd or later | no | not active on the 1st; PLAN §8.3 (D-18) decides |
 * | disconnected/suspended effective the 1st | yes | still active during the 1st |
 * | disconnected/suspended effective the last day of P−1 | no | the change took effect at midnight |
 * | reactivated effective the 1st | **no** | still suspended during the 1st (open question: see notes) |
 * | reactivated effective the last day of P−1 | yes | active from the start of the 1st |
 * | suspended and reactivated before the 1st | yes | only the status on the 1st matters |
 * | `endDate` before the 1st | no | never bills a disconnected assignment (RULE-08) |
 *
 * Changes effective on or after the 1st never change the answer for P, so a bill once issued can be
 * re-derived from the timeline and stays right (D-14: "the issued Oct invoice is untouched").
 *
 * Several events on the same effective date apply in the order they were recorded (the order of
 * `events`). Only the status at the end of that day can matter for later days.
 */
import { isPaise, type Paise } from "../money";
import { domainError, err, ok, type Result } from "../result";
import {
  type BusinessDate,
  compareBusinessDates,
  isBusinessDate,
  isPeriod,
  type Period,
  periodEnd,
} from "../time";
import type {
  AssignmentEvent,
  AssignmentStatusOnDate,
  AssignmentTimeline,
  BillingError,
  BillingValidationReason,
} from "./types";

type LiveStatus = "active" | "suspended" | "disconnected";

/** A status change, in effective order. It holds from the day **after** `date`. */
type StatusChange = { readonly date: BusinessDate; readonly to: LiveStatus };

/** A plan change, in effective order. It sets the rental of `date`'s month onwards. */
type PlanChange = { readonly date: BusinessDate; readonly rentalPaise: Paise };

/** A timeline that passed validation, with its events in effective order. */
type CheckedTimeline = {
  readonly startDate: BusinessDate;
  readonly statusChanges: readonly StatusChange[];
  readonly planChanges: readonly PlanChange[];
};

function invalid(
  reason: BillingValidationReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Result<never, BillingError> {
  return err(domainError("VALIDATION", message, { reason, ...details }));
}

/**
 * Checks that a timeline is possible and returns its changes in effective order.
 *
 * Refused (`VALIDATION`, `details.reason`):
 * - `invalid_date`: a date that is not `YYYY-MM-DD`.
 * - `end_before_start`: `endDate` earlier than `startDate`.
 * - `event_before_start` / `event_after_end`: an event outside `[startDate, endDate]`.
 * - `unknown_event_type`.
 * - `activated_not_on_start`: an `activated` event not on `startDate`, or more than one.
 * - `invalid_transition`: suspend when not active, reactivate when not suspended, or anything after
 *   the disconnection (FR-006 transitions; a disconnected assignment is never reactivated, a reused
 *   VC gets a new assignment: RULE-07).
 * - `end_date_mismatch`: `endDate` and the `disconnected` event disagree.
 * - `invalid_amount`: a `plan_changed` rental that is not a whole number of paise ≥ 0.
 */
function checkTimeline(timeline: AssignmentTimeline): Result<CheckedTimeline, BillingError> {
  const { startDate, endDate } = timeline;
  if (!isBusinessDate(startDate)) {
    return invalid("invalid_date", "startDate is not a business date", { field: "startDate" });
  }
  if (endDate !== null && !isBusinessDate(endDate)) {
    return invalid("invalid_date", "endDate is not a business date", { field: "endDate" });
  }
  if (endDate !== null && compareBusinessDates(endDate, startDate) < 0) {
    return invalid("end_before_start", "endDate is before startDate");
  }

  for (const [index, event] of timeline.events.entries()) {
    if (!isBusinessDate(event.effectiveDate)) {
      return invalid("invalid_date", "event effectiveDate is not a business date", {
        eventIndex: index,
      });
    }
  }

  // Effective order; the recorded order (the array index) breaks ties within one day.
  const ordered = timeline.events
    .map((event, index) => ({ event, index }))
    .sort(
      (a, b) =>
        compareBusinessDates(a.event.effectiveDate, b.event.effectiveDate) || a.index - b.index,
    );

  const statusChanges: StatusChange[] = [];
  const planChanges: PlanChange[] = [];
  let status: LiveStatus = "active";
  let activatedSeen = false;
  let disconnectedOn: BusinessDate | null = null;

  for (const { event, index } of ordered) {
    const date = event.effectiveDate;
    const at = { eventIndex: index, type: event.type, effectiveDate: date };
    if (compareBusinessDates(date, startDate) < 0) {
      return invalid("event_before_start", "event is effective before the assignment started", at);
    }
    if (endDate !== null && compareBusinessDates(date, endDate) > 0) {
      return invalid("event_after_end", "event is effective after the assignment ended", at);
    }
    const type: AssignmentEvent["type"] = event.type;
    if (type === "activated") {
      // A marker of the start, not a change: valid once, on startDate, wherever it was recorded.
      if (activatedSeen || date !== startDate) {
        return invalid(
          "activated_not_on_start",
          "an assignment is activated once, on its startDate",
          at,
        );
      }
      activatedSeen = true;
      continue;
    }
    if (status === "disconnected") {
      return invalid("invalid_transition", "no event may follow the disconnection", at);
    }
    switch (type) {
      case "suspended":
        if (status !== "active") {
          return invalid("invalid_transition", "only an active assignment can be suspended", at);
        }
        status = "suspended";
        statusChanges.push({ date, to: status });
        break;
      case "reactivated":
        if (status !== "suspended") {
          return invalid(
            "invalid_transition",
            "only a suspended assignment can be reactivated",
            at,
          );
        }
        status = "active";
        statusChanges.push({ date, to: status });
        break;
      case "disconnected":
        status = "disconnected";
        disconnectedOn = date;
        statusChanges.push({ date, to: status });
        break;
      case "plan_changed": {
        const rental = (event as { rentalPaise?: unknown }).rentalPaise;
        if (!isPaise(rental) || rental < 0) {
          return invalid("invalid_amount", "plan_changed rentalPaise must be paise ≥ 0", at);
        }
        planChanges.push({ date, rentalPaise: rental });
        break;
      }
      default:
        return invalid("unknown_event_type", "unknown assignment event type", {
          eventIndex: index,
          type: String(type satisfies never),
        });
    }
  }

  if (endDate !== null) {
    if (disconnectedOn === null) {
      // An end date without a disconnection event: the assignment ended at the end of that day.
      statusChanges.push({ date: endDate, to: "disconnected" });
    } else if (disconnectedOn !== endDate) {
      return invalid("end_date_mismatch", "endDate differs from the disconnection's date", {
        endDate,
        disconnectedOn,
      });
    }
  }

  return ok({ startDate, statusChanges, planChanges });
}

/** {@link checkTimeline} for trusted data: throws `RangeError` (a programmer error) on bad input. */
function checkedOrThrow(timeline: AssignmentTimeline): CheckedTimeline {
  const result = checkTimeline(timeline);
  if (result.ok) return result.value;
  const reason = String(result.error.details?.reason ?? "invalid");
  throw new RangeError(`invalid assignment timeline (${reason}): ${result.error.message ?? ""}`);
}

function statusDuring(timeline: CheckedTimeline, date: BusinessDate): AssignmentStatusOnDate {
  if (compareBusinessDates(date, timeline.startDate) < 0) return "not_started";
  let status: LiveStatus = "active";
  for (const change of timeline.statusChanges) {
    // A change takes effect at the end of its day: it governs only later days.
    if (compareBusinessDates(change.date, date) >= 0) break;
    status = change.to;
  }
  return status;
}

/**
 * Validates an assignment timeline (see {@link checkTimeline} for the reasons). Use it on data you
 * did not just validate yourself before calling {@link isBillable} or {@link assignmentStatusOn},
 * which throw on an impossible timeline. {@link buildInvoice} validates for you.
 */
export function validateAssignmentTimeline(
  timeline: AssignmentTimeline,
): Result<AssignmentTimeline, BillingError> {
  const result = checkTimeline(timeline);
  return result.ok ? ok(timeline) : result;
}

/**
 * The assignment's status **during** `date` (an IST business date): `not_started` before
 * `startDate`, otherwise the status set by the changes effective before `date`.
 *
 * Throws `RangeError` for an impossible timeline (validate untrusted data first).
 */
export function assignmentStatusOn(
  timeline: AssignmentTimeline,
  date: BusinessDate,
): AssignmentStatusOnDate {
  if (!isBusinessDate(date)) throw new RangeError(`not a business date: "${String(date)}"`);
  return statusDuring(checkedOrThrow(timeline), date);
}

/**
 * Whether the assignment is charged its full rental for `period` (PLAN §8.1): it is active at any
 * time on the 1st of the period. With status changes taking effect at the end of their day, that is
 * exactly "active during the 1st" (see the table at the top of this file).
 *
 * Throws `RangeError` for an impossible timeline or a value that is not a period.
 */
export function isBillable(timeline: AssignmentTimeline, period: Period): boolean {
  if (!isPeriod(period)) throw new RangeError(`not a period: "${String(period)}"`);
  return assignmentStatusOn(timeline, period) === "active";
}

/**
 * The monthly rental in effect for `period`: the rental set by the last `plan_changed` event
 * effective **on or before the last day of the period**, else `initialRentalPaise`.
 *
 * BRD §9 / BR-07 / D-14: "Immediate plan change applies the full new monthly rental in the current
 * month", so a change effective on any day of P sets P's rental, and repeated changes in one month
 * end at the latest amount (PRD §15 #5). When P's invoice already exists the run never re-bills it;
 * the difference becomes an adjustment instead (PLAN §8.3, T-042/T-045).
 *
 * Throws `RangeError` for an impossible timeline, a bad `initialRentalPaise` or a bad period.
 */
export function rentalForPeriod(
  assignment: AssignmentTimeline & { readonly initialRentalPaise: Paise },
  period: Period,
): Paise {
  if (!isPeriod(period)) throw new RangeError(`not a period: "${String(period)}"`);
  const { initialRentalPaise } = assignment;
  if (!isPaise(initialRentalPaise) || initialRentalPaise < 0) {
    throw new RangeError(`initialRentalPaise must be paise ≥ 0, got ${String(initialRentalPaise)}`);
  }
  const lastDay = periodEnd(period);
  return rentalUpTo(checkedOrThrow(assignment), initialRentalPaise, lastDay);
}

function rentalUpTo(timeline: CheckedTimeline, initial: Paise, lastDay: BusinessDate): Paise {
  let rental = initial;
  for (const change of timeline.planChanges) {
    if (compareBusinessDates(change.date, lastDay) > 0) break;
    rental = change.rentalPaise;
  }
  return rental;
}

/** Internal: validated eligibility and rental in one pass, for {@link buildInvoice}. */
export function billingOf(
  assignment: AssignmentTimeline & { readonly initialRentalPaise: Paise },
  period: Period,
): Result<{ readonly billable: boolean; readonly rentalPaise: Paise }, BillingError> {
  const checked = checkTimeline(assignment);
  if (!checked.ok) return checked;
  const { initialRentalPaise } = assignment;
  if (!isPaise(initialRentalPaise) || initialRentalPaise < 0) {
    return invalid("invalid_amount", "initialRentalPaise must be paise ≥ 0", {
      field: "initialRentalPaise",
    });
  }
  return ok({
    billable: statusDuring(checked.value, period) === "active",
    rentalPaise: rentalUpTo(checked.value, initialRentalPaise, periodEnd(period)),
  });
}
