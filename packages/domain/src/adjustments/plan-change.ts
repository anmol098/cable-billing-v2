/**
 * Plan change after the month's bill (PLAN §8.3, D-14).
 *
 * Rules, from the source documents:
 * - BRD §9 "Plan change", PRD FR-008 / BR-07: an immediate plan change applies the **full new
 *   monthly rental in the current month** (no proration).
 * - BRD RULE-10 / §16, PRD §15 #5, D-14: the issued invoice is never edited; the difference
 *   becomes an auditable debit or credit **adjustment**, and the customer is never charged twice.
 * - PLAN §8.3: adjustment = `new_amount − (charged for this assignment+period so far, incl.
 *   earlier adjustments)`; positive → debit, negative → credit. Repeated changes in the same month
 *   net out: after any number of changes the period's rent equals the latest plan amount.
 */
import { isPaise, type Paise, subtractPaise } from "../money";
import { ok, type Result } from "../result";
import type { Period } from "../time";
import { rentalChargedSoFar } from "./charged-so-far";
import { validation } from "./errors";
import { type AdjustmentDecision, draftFor, outcomeForDelta } from "./outcome";
import type { AdjustmentError, AdjustmentOutcome, RentalChargeRecord } from "./types";

export type PlanChangeAdjustmentInput = {
  /** What the connection's rent for the period already adds up to (≥ 0). */
  readonly chargedSoFarPaise: Paise;
  /** The new plan's (or custom) monthly amount (≥ 0). */
  readonly newAmountPaise: Paise;
};

/**
 * The netting rule on its own: `newAmount − chargedSoFar` as a debit, a credit or nothing
 * (`same_amount`). Use {@link planChangeForPeriod} in services: it also works out
 * `chargedSoFar` from the stored records and knows when a period has no rent to correct.
 *
 * Errors: `VALIDATION` when an amount is negative or not an integer of paise.
 */
export function planChangeAdjustment(
  input: PlanChangeAdjustmentInput,
): Result<AdjustmentOutcome, AdjustmentError> {
  const { chargedSoFarPaise, newAmountPaise } = input;
  if (!isPaise(chargedSoFarPaise) || chargedSoFarPaise < 0) {
    return validation("chargedSoFarPaise must be an integer of paise ≥ 0", {
      field: "chargedSoFarPaise",
    });
  }
  const checked = checkNewAmount(newAmountPaise);
  if (!checked.ok) return checked;
  return ok(outcomeForDelta(subtractPaise(newAmountPaise, chargedSoFarPaise), "same_amount"));
}

export type PlanChangeForPeriodInput = {
  readonly assignmentId: string;
  /** The period of the change's effective date (`periodOf(effectiveDate)`). */
  readonly period: Period;
  /** Every rent line and adjustment of this assignment for this period (see `RentalChargeRecord`). */
  readonly records: readonly RentalChargeRecord[];
  readonly newAmountPaise: Paise;
};

/**
 * What a plan change does to one connection's rent for one period.
 *
 * - The period has no rent for this connection yet (`not_billed_this_period`): nothing now. That
 *   covers a change before the period's run, a connection that starts next month
 *   (`start_next_month`), and a connection not billable this period. The next bill charges the
 *   new amount.
 * - Otherwise: {@link planChangeAdjustment} against the rent so far, as a `plan_change` draft for
 *   this assignment and period. After storing it the period's rent equals `newAmountPaise`, so a
 *   repeated call with the same amount (a retry) gives `same_amount`.
 *
 * Errors: `VALIDATION` (bad amount or records) and `INVARIANT_VIOLATION` (the stored records
 * already break the rules), from {@link rentalChargedSoFar}.
 */
export function planChangeForPeriod(
  input: PlanChangeForPeriodInput,
): Result<AdjustmentDecision, AdjustmentError> {
  const checked = checkNewAmount(input.newAmountPaise);
  if (!checked.ok) return checked;
  const soFar = rentalChargedSoFar(input);
  if (!soFar.ok) return soFar;

  const { charged, chargedSoFarPaise } = soFar.value;
  if (!charged) {
    return ok({
      outcome: { kind: "none", reason: "not_billed_this_period" },
      draft: null,
      chargedBeforePaise: chargedSoFarPaise,
      chargedAfterPaise: chargedSoFarPaise,
    });
  }
  const outcome = planChangeAdjustment({ chargedSoFarPaise, newAmountPaise: input.newAmountPaise });
  if (!outcome.ok) return outcome;
  return ok({
    outcome: outcome.value,
    draft: draftFor(outcome.value, input, "plan_change"),
    chargedBeforePaise: chargedSoFarPaise,
    chargedAfterPaise: input.newAmountPaise,
  });
}

function checkNewAmount(newAmountPaise: Paise): Result<null, AdjustmentError> {
  return isPaise(newAmountPaise) && newAmountPaise >= 0
    ? ok(null)
    : validation("newAmountPaise must be an integer of paise ≥ 0", { field: "newAmountPaise" });
}
