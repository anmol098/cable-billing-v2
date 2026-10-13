/**
 * New connection or reactivation after the month's run (PLAN §8.3, D-18).
 *
 * Rules, from the source documents:
 * - D-18: each operator chooses, in the setting `mid_month_start_policy`:
 *   - `charge_full_month` → a debit adjustment for the **full** rental in the current period
 *     (no proration, as for plan changes: BRD §9, BR-07);
 *   - `start_next_month` → nothing now; the connection is billed from the next run.
 * - PLAN §8.1: a connection that is active at any time on the 1st is charged by that month's run,
 *   so a start on the 1st **before** the run needs no adjustment (the run bills it).
 * - PRD §15 #5 / FR-008 (no double charge): a connection that already has rent for the period
 *   (it was billed on the 1st, then suspended and reactivated in the same month) is not charged
 *   again.
 */
import { isPaise, type Paise } from "../money";
import { ok, type Result } from "../result";
import type { Period } from "../time";
import { rentalChargedSoFar } from "./charged-so-far";
import { validation } from "./errors";
import { type AdjustmentDecision, draftFor } from "./outcome";
import {
  type AdjustmentError,
  type AdjustmentOutcome,
  MID_MONTH_START_POLICIES,
  type MidMonthStartPolicy,
  type RentalChargeRecord,
} from "./types";

export type MidMonthStartAdjustmentInput = {
  /** The operator's `mid_month_start_policy` (D-18). */
  readonly policy: MidMonthStartPolicy;
  /** The connection's monthly rental (≥ 0). */
  readonly rentalPaise: Paise;
  /**
   * True when this period's billing run will **not** charge the connection: it starts (or
   * reactivates) after the 1st, or on the 1st after the run has already dealt with this customer.
   * False only when the run is still to bill it (PLAN §8.1 "starts on the 1st before the run").
   * The service decides this (T-045); see the T-042 completion notes.
   */
  readonly startedAfterRun: boolean;
};

/**
 * The policy on its own: a debit for the full rental, or nothing (`billed_by_run`,
 * `start_next_month`, `zero_rental`). Use {@link midMonthStartForPeriod} in services: it also
 * refuses to charge a connection that already has rent for the period.
 *
 * Errors: `VALIDATION` for an unknown policy, a negative rental or a non-boolean flag.
 */
export function midMonthStartAdjustment(
  input: MidMonthStartAdjustmentInput,
): Result<AdjustmentOutcome, AdjustmentError> {
  const { policy, rentalPaise, startedAfterRun } = input;
  if (!(MID_MONTH_START_POLICIES as readonly string[]).includes(policy)) {
    return validation("unknown mid_month_start_policy", { field: "policy", policy });
  }
  if (!isPaise(rentalPaise) || rentalPaise < 0) {
    return validation("rentalPaise must be an integer of paise ≥ 0", { field: "rentalPaise" });
  }
  if (typeof startedAfterRun !== "boolean") {
    return validation("startedAfterRun must be a boolean", { field: "startedAfterRun" });
  }

  if (!startedAfterRun) return ok({ kind: "none", reason: "billed_by_run" });
  if (policy === "start_next_month") return ok({ kind: "none", reason: "start_next_month" });
  if (rentalPaise === 0) return ok({ kind: "none", reason: "zero_rental" });
  return ok({ kind: "debit", amountPaise: rentalPaise });
}

export type MidMonthStartForPeriodInput = MidMonthStartAdjustmentInput & {
  readonly assignmentId: string;
  /** The period of the start (or reactivation) date. */
  readonly period: Period;
  /** Every rent line and adjustment of this assignment for this period (see `RentalChargeRecord`). */
  readonly records: readonly RentalChargeRecord[];
};

/**
 * What a new connection or a reactivation does to the connection's rent for the period:
 * `already_charged` when it already has rent for the period, else {@link midMonthStartAdjustment}
 * as a `mid_month_start` draft for this assignment and period. After storing the draft, a repeated
 * call (a retry, or a second reactivation in the same month) gives `already_charged`.
 *
 * Errors: `VALIDATION` and `INVARIANT_VIOLATION`, as for {@link midMonthStartAdjustment} and
 * `rentalChargedSoFar`.
 */
export function midMonthStartForPeriod(
  input: MidMonthStartForPeriodInput,
): Result<AdjustmentDecision, AdjustmentError> {
  const policyOutcome = midMonthStartAdjustment(input);
  if (!policyOutcome.ok) return policyOutcome;
  const soFar = rentalChargedSoFar(input);
  if (!soFar.ok) return soFar;

  const { charged, chargedSoFarPaise } = soFar.value;
  const outcome: AdjustmentOutcome = charged
    ? { kind: "none", reason: "already_charged" }
    : policyOutcome.value;
  return ok({
    outcome,
    draft: draftFor(outcome, input, "mid_month_start"),
    chargedBeforePaise: chargedSoFarPaise,
    chargedAfterPaise: outcome.kind === "debit" ? outcome.amountPaise : chargedSoFarPaise,
  });
}
