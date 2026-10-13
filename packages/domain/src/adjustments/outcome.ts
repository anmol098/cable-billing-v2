import { negatePaise, type Paise, ZERO_PAISE } from "../money";
import type { Period } from "../time";
import type {
  AdjustmentDraft,
  AdjustmentOutcome,
  AdjustmentSource,
  NoAdjustmentReason,
} from "./types";

/**
 * What a change does, ready for the service (T-045) and the effect preview in the UI
 * ("₹50 extra will be added to the next bill").
 */
export type AdjustmentDecision = {
  readonly outcome: AdjustmentOutcome;
  /** The `adjustments` row to insert, or `null` when the outcome is `none`. */
  readonly draft: AdjustmentDraft | null;
  /** The connection's rent for the period before this change (see `rentalChargedSoFar`). */
  readonly chargedBeforePaise: Paise;
  /** … and after the draft is stored. For a plan change on a charged period: the new amount. */
  readonly chargedAfterPaise: Paise;
};

/**
 * The adjustment as a signed amount: + for a debit, − for a credit, 0 for none. This is the
 * amount by which the customer's dues change once the adjustment takes effect (on creation for a
 * credit; for a debit, see the open question Q-A in the T-041 / T-042 completion notes).
 */
export function signedAdjustmentPaise(outcome: AdjustmentOutcome): Paise {
  if (outcome.kind === "none") return ZERO_PAISE;
  return outcome.kind === "debit" ? outcome.amountPaise : negatePaise(outcome.amountPaise);
}

/** An outcome for a signed change in what is owed: > 0 debit, < 0 credit, 0 → `none(reason)`. */
export function outcomeForDelta(delta: Paise, reasonIfZero: NoAdjustmentReason): AdjustmentOutcome {
  if (delta > 0) return { kind: "debit", amountPaise: delta };
  if (delta < 0) return { kind: "credit", amountPaise: negatePaise(delta) };
  return { kind: "none", reason: reasonIfZero };
}

/** The `adjustments` row for an outcome, or `null` for `none`. */
export function draftFor(
  outcome: AdjustmentOutcome,
  target: { readonly assignmentId: string; readonly period: Period },
  source: AdjustmentSource,
): AdjustmentDraft | null {
  if (outcome.kind === "none") return null;
  return {
    assignmentId: target.assignmentId,
    period: target.period,
    direction: outcome.kind,
    amountPaise: outcome.amountPaise,
    source,
  };
}
