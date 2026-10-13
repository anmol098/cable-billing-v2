/**
 * "Charged for this assignment+period so far, incl. earlier adjustments" (PLAN §8.3): the number
 * every plan-change adjustment nets against.
 *
 * A connection's rent for a period comes from exactly one **base charge**, plus any number of
 * plan-change corrections:
 *
 * - base charge: the `rent` line on the period's bill (PLAN §8.2), **or** a `mid_month_start`
 *   debit adjustment when it started after the run under `charge_full_month` (PLAN §8.3, D-18);
 * - corrections: `plan_change` debit (+) and credit (−) adjustments for the same period.
 *
 * `manual` and `migration` adjustments are reported but not counted (see
 * {@link RENTAL_ADJUSTMENT_SOURCES}).
 */
import { addPaise, isPaise, negatePaise, type Paise, ZERO_PAISE } from "../money";
import { ok, type Result } from "../result";
import { isPeriod, type Period } from "../time";
import { invariant, validation } from "./errors";
import {
  ADJUSTMENT_DIRECTIONS,
  ADJUSTMENT_SOURCES,
  type AdjustmentError,
  type AdjustmentSource,
  RENTAL_ADJUSTMENT_SOURCES,
  type RentalChargeRecord,
} from "./types";

export type RentalChargedSoFar = {
  /**
   * True when the connection has rent for this period (a base charge exists). When false, a plan
   * change needs no adjustment: the next bill charges the new amount.
   */
  readonly charged: boolean;
  /** Where the rent came from: the bill's `rent` line, a `mid_month_start` adjustment, or none. */
  readonly baseCharge: "rent" | "mid_month_start" | null;
  /** Base charge + Σ plan-change debits − Σ plan-change credits. ≥ 0; 0 when not charged. */
  readonly chargedSoFarPaise: Paise;
  /** Ids of the records that were not counted (`manual` / `migration` adjustments), sorted. */
  readonly notNettedIds: readonly string[];
};

export type RentalChargedSoFarInput = {
  readonly assignmentId: string;
  readonly period: Period;
  /** Every rent line and adjustment of this assignment for this period, in any order. */
  readonly records: readonly RentalChargeRecord[];
};

/**
 * Adds up what a connection has been charged as rent for a period (see the module comment).
 *
 * Errors:
 * - `VALIDATION`: a record for another assignment or period, a repeated id, an unknown direction
 *   or source, a negative rent line, or an adjustment amount that is not > 0.
 * - `INVARIANT_VIOLATION`: more than one base charge (rent charged twice for the period), a
 *   `mid_month_start` credit, plan-change adjustments without a base charge, or rent that nets
 *   below zero. None of these can come from this module's own output.
 */
export function rentalChargedSoFar(
  input: RentalChargedSoFarInput,
): Result<RentalChargedSoFar, AdjustmentError> {
  const { assignmentId, period, records } = input;
  if (typeof assignmentId !== "string" || assignmentId === "") {
    return validation("assignmentId must be a non-empty string", { field: "assignmentId" });
  }
  if (!isPeriod(period)) return validation("period must be a period", { field: "period" });

  const seen = new Set<string>();
  const bases: { kind: "rent" | "mid_month_start"; id: string }[] = [];
  const notNettedIds: string[] = [];
  let baseAmount = ZERO_PAISE;
  let corrections = ZERO_PAISE;

  for (const record of records) {
    const checked = checkRecord(record, assignmentId, period, seen);
    if (!checked.ok) return checked;

    if (record.kind === "rent") {
      bases.push({ kind: "rent", id: record.id });
      baseAmount = addPaise(baseAmount, record.amountPaise);
      continue;
    }
    if (!isRentalSource(record.source)) {
      notNettedIds.push(record.id);
      continue;
    }
    if (record.source === "mid_month_start") {
      if (record.direction !== "debit") {
        return invariant("a mid_month_start adjustment must be a debit", { id: record.id });
      }
      bases.push({ kind: "mid_month_start", id: record.id });
      baseAmount = addPaise(baseAmount, record.amountPaise);
      continue;
    }
    corrections = addPaise(
      corrections,
      record.direction === "debit" ? record.amountPaise : negatePaise(record.amountPaise),
    );
  }

  if (bases.length > 1) {
    return invariant("the connection was charged rent more than once for this period", {
      assignmentId,
      period,
      ids: bases.map((base) => base.id).sort(),
    });
  }
  const base = bases[0];
  if (base === undefined) {
    const corrected = records.some((r) => r.kind === "adjustment" && r.source === "plan_change");
    if (corrected) {
      return invariant("plan_change adjustments exist but the period has no rent to correct", {
        assignmentId,
        period,
      });
    }
    return ok({
      charged: false,
      baseCharge: null,
      chargedSoFarPaise: ZERO_PAISE,
      notNettedIds: notNettedIds.sort(),
    });
  }

  const chargedSoFarPaise = addPaise(baseAmount, corrections);
  if (chargedSoFarPaise < 0) {
    return invariant("the connection's rent for this period nets below zero", {
      assignmentId,
      period,
      chargedSoFarPaise,
    });
  }
  return ok({
    charged: true,
    baseCharge: base.kind,
    chargedSoFarPaise,
    notNettedIds: notNettedIds.sort(),
  });
}

function checkRecord(
  record: RentalChargeRecord,
  assignmentId: string,
  period: Period,
  seen: Set<string>,
): Result<null, AdjustmentError> {
  if (typeof record.id !== "string" || record.id === "") {
    return validation("every record needs a non-empty id", { field: "id" });
  }
  if (seen.has(record.id)) return validation("a record is listed twice", { id: record.id });
  seen.add(record.id);
  if (record.assignmentId !== assignmentId || record.period !== period) {
    return validation("a record belongs to another assignment or period", { id: record.id });
  }
  if (!isPaise(record.amountPaise)) {
    return validation("amountPaise must be an integer of paise", { id: record.id });
  }
  if (record.kind === "rent") {
    return record.amountPaise < 0
      ? validation("a rent line cannot be negative", { id: record.id })
      : ok(null);
  }
  if (record.kind !== "adjustment") {
    return validation("record kind must be rent or adjustment", {
      id: (record as { id: string }).id,
    });
  }
  if (!(ADJUSTMENT_DIRECTIONS as readonly string[]).includes(record.direction)) {
    return validation("unknown adjustment direction", { id: record.id });
  }
  if (!(ADJUSTMENT_SOURCES as readonly string[]).includes(record.source)) {
    return validation("unknown adjustment source", { id: record.id });
  }
  if (record.amountPaise <= 0) {
    return validation("an adjustment amount must be > 0", { id: record.id });
  }
  return ok(null);
}

function isRentalSource(source: AdjustmentSource): boolean {
  return (RENTAL_ADJUSTMENT_SOURCES as readonly AdjustmentSource[]).includes(source);
}
