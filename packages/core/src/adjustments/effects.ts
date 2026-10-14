/**
 * What a connection change does to the money (T-045; PLAN §8.3, D-14, D-18, BR-07, FR-008,
 * RULE-10). Pure: no database, no clock. The hooks, the Owner's back-dated flow and the effect
 * preview all go through these functions, so the preview says exactly what the change will do.
 *
 * **The change's own month** (`periodOf(effectiveDate)`, "D's month"), T-042's rules:
 * - plan change → `planChangeForPeriod`: the month's rent nets to the new amount (a debit or
 *   credit adjustment), or nothing when the month has no rent yet (the next bill charges the new
 *   amount);
 * - start / start again → `midMonthStartForPeriod` with the operator's `mid_month_start_policy`:
 *   `charge_full_month` → a debit for the full rental; `start_next_month` → nothing; never when
 *   the month already has rent (`already_charged`), never when the month's bill will charge it
 *   itself (`billed_by_run`);
 * - stop / remove → nothing ("the current month stays charged", PLAN §8.3).
 *
 * **Later billed months** (only the Owner's back-dated flow reaches them, PLAN §8.3 "back-dated
 * effective date into an already-billed period"): each month after D's month that is already
 * billed for the customer must end up charged what the monthly bill would charge with the new
 * history (T-040 `isBillable` + `rentalForPeriod`):
 * - should charge X, charges Y > 0 → a `plan_change` netting adjustment of X − Y;
 * - should charge X > 0, has no rent at all → a `mid_month_start` debit of X (the month's base
 *   charge: the billing run's double-charge guard then never adds a rent line for it);
 * - should charge 0, charges Y > 0 → a `plan_change` credit of Y.
 */
import {
  type AdjustmentDecision,
  type AdjustmentDraft,
  type AdjustmentError,
  type AdjustmentOutcome,
  type AssignmentTimeline,
  type BusinessDate,
  domainError,
  err,
  isBillable,
  type MidMonthStartPolicy,
  midMonthStartForPeriod,
  ok,
  type Paise,
  type Period,
  periodOf,
  planChangeForPeriod,
  type RentalChargeRecord,
  type Result,
  rentalChargedSoFar,
  rentalForPeriod,
  signedAdjustmentPaise,
  subtractPaise,
  sumPaise,
  ZERO_PAISE,
} from "@cb/domain";

/** The kinds of connection change that can touch the money. */
export type ChangeKind = "start" | "reactivate" | "plan" | "suspend" | "disconnect";

/** A timeline plus the rental it started with (what T-040 `rentalForPeriod` needs). */
export type RentalTimeline = AssignmentTimeline & { readonly initialRentalPaise: Paise };

/** One month's stored facts for one connection. */
export interface MonthFacts {
  /** The month is billed for the customer (bill made, or the run looked and decided). */
  readonly billed: boolean;
  /** Every rent line and adjustment of this connection for the month (T-042 records). */
  readonly records: readonly RentalChargeRecord[];
}

/** What one month gets: the T-042 decision plus where it came from. */
export interface MonthEffect {
  readonly period: Period;
  /** `change_month`: D's month (the hook's); `later_month`: a billed month after it. */
  readonly scope: "change_month" | "later_month";
  readonly outcome: AdjustmentOutcome;
  readonly draft: AdjustmentDraft | null;
  readonly chargedBeforePaise: Paise;
  readonly chargedAfterPaise: Paise;
}

export interface ChangeMonthInput {
  readonly kind: ChangeKind;
  readonly assignmentId: string;
  readonly effectiveDate: BusinessDate;
  /** The connection's history **after** the change. */
  readonly timeline: RentalTimeline;
  /** The connection's monthly rental after the change. */
  readonly rentalPaise: Paise;
  readonly policy: MidMonthStartPolicy;
  /** Facts of D's month. */
  readonly month: MonthFacts;
}

const none = (reason: Extract<AdjustmentOutcome, { kind: "none" }>["reason"]) =>
  ({ kind: "none", reason }) as const;

/**
 * `startedAfterRun` (T-042 Q-2): the month's bill will **not** charge the connection. The bill
 * charges it only when the connection is active during the 1st with the new history (T-040) and
 * the month is not billed for the customer yet (a run that already looked never looks again).
 */
export function startedAfterRun(timeline: AssignmentTimeline, month: MonthFacts, period: Period) {
  return !(isBillable(timeline, period) && !month.billed);
}

/** The effect on D's month (see the module comment). */
export function changeMonthEffect(input: ChangeMonthInput): Result<MonthEffect, AdjustmentError> {
  const period = periodOf(input.effectiveDate);
  const base = { period, scope: "change_month" as const };
  const target = { assignmentId: input.assignmentId, period, records: input.month.records };

  if (input.kind === "plan") {
    const decided = planChangeForPeriod({ ...target, newAmountPaise: input.rentalPaise });
    return decided.ok ? ok({ ...base, ...decided.value }) : decided;
  }
  if (input.kind === "suspend" || input.kind === "disconnect") {
    const soFar = rentalChargedSoFar(target);
    if (!soFar.ok) return soFar;
    return ok({
      ...base,
      outcome: none("same_amount"),
      draft: null,
      chargedBeforePaise: soFar.value.chargedSoFarPaise,
      chargedAfterPaise: soFar.value.chargedSoFarPaise,
    });
  }

  const afterRun = startedAfterRun(input.timeline, input.month, period);
  const soFar = rentalChargedSoFar(target);
  if (!soFar.ok) return soFar;
  // A month whose rent was netted down to ₹0 (an earlier back-dated stop) has a base charge but
  // charges nothing: a start in it follows the policy like an uncharged month, as a plan-change
  // netting debit on top of the existing base (T-042 allows only one base charge).
  if (soFar.value.charged && soFar.value.chargedSoFarPaise === 0 && afterRun) {
    const policyOnly = midMonthStartForPeriod({
      ...target,
      records: [],
      policy: input.policy,
      rentalPaise: input.rentalPaise,
      startedAfterRun: true,
    });
    if (!policyOnly.ok) return policyOnly;
    const outcome = policyOnly.value.outcome;
    if (outcome.kind === "none") {
      return ok({
        ...base,
        outcome,
        draft: null,
        chargedBeforePaise: ZERO_PAISE,
        chargedAfterPaise: ZERO_PAISE,
      });
    }
    const netted = planChangeForPeriod({ ...target, newAmountPaise: outcome.amountPaise });
    return netted.ok ? ok({ ...base, ...netted.value }) : netted;
  }
  const decided: Result<AdjustmentDecision, AdjustmentError> = midMonthStartForPeriod({
    ...target,
    policy: input.policy,
    rentalPaise: input.rentalPaise,
    startedAfterRun: afterRun,
  });
  return decided.ok ? ok({ ...base, ...decided.value }) : decided;
}

/** What the monthly bill would charge the connection for `period` with this history. */
export function expectedRentPaise(timeline: RentalTimeline, period: Period): Paise {
  return isBillable(timeline, period) ? rentalForPeriod(timeline, period) : ZERO_PAISE;
}

/** The correction one later billed month needs (see the module comment). */
export function laterMonthEffect(input: {
  readonly assignmentId: string;
  readonly period: Period;
  readonly timeline: RentalTimeline;
  readonly records: readonly RentalChargeRecord[];
}): Result<MonthEffect, AdjustmentError> {
  const { assignmentId, period, records } = input;
  const base = { period, scope: "later_month" as const };
  const soFar = rentalChargedSoFar({ assignmentId, period, records });
  if (!soFar.ok) return soFar;
  const expected = expectedRentPaise(input.timeline, period);
  const charged = soFar.value.chargedSoFarPaise;

  if (!soFar.value.charged) {
    if (expected === 0) {
      return ok({
        ...base,
        outcome: none("same_amount"),
        draft: null,
        chargedBeforePaise: ZERO_PAISE,
        chargedAfterPaise: ZERO_PAISE,
      });
    }
    // The month's base charge: what the bill would have had as a rent line.
    return ok({
      ...base,
      outcome: { kind: "debit", amountPaise: expected },
      draft: {
        assignmentId,
        period,
        direction: "debit",
        amountPaise: expected,
        source: "mid_month_start",
      },
      chargedBeforePaise: ZERO_PAISE,
      chargedAfterPaise: expected,
    });
  }
  const netted = planChangeForPeriod({ assignmentId, period, records, newAmountPaise: expected });
  if (!netted.ok) return netted;
  if (subtractPaise(netted.value.chargedAfterPaise, expected) !== 0) {
    return err(
      domainError("INVARIANT_VIOLATION", "netting did not reach the expected rent", {
        assignmentId,
        period,
        charged,
        expected,
      }),
    );
  }
  return ok({ ...base, ...netted.value });
}

/** Σ of the effects as a signed amount (+ more to pay, − less to pay). */
export function signedTotalPaise(effects: readonly MonthEffect[]): Paise {
  return sumPaise(effects.map((effect) => signedAdjustmentPaise(effect.outcome)));
}
