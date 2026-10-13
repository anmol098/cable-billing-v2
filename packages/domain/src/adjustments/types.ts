/**
 * Shapes for changes made after the month's bill (T-042, PLAN §8.3).
 *
 * They mirror the T-023 `adjustments` and `invoice_lines` tables (PLAN §7.2) closely enough that
 * services can map rows one to one, but hold only what the pure functions need. Ids are opaque
 * strings (UUIDv7 in the DB).
 */
import type { Paise } from "../money";
import type { DomainError } from "../result";
import type { Period } from "../time";

/** `adjustments.direction`: a debit adds to what the customer owes, a credit takes away. */
export type AdjustmentDirection = "debit" | "credit";

export const ADJUSTMENT_DIRECTIONS = [
  "debit",
  "credit",
] as const satisfies readonly AdjustmentDirection[];

/** `adjustments.source` (PLAN §7.2). */
export type AdjustmentSource = "plan_change" | "mid_month_start" | "manual" | "migration";

export const ADJUSTMENT_SOURCES = [
  "plan_change",
  "mid_month_start",
  "manual",
  "migration",
] as const satisfies readonly AdjustmentSource[];

/**
 * The adjustment sources that are part of a connection's **rent** for a period, and so count in
 * "charged for this assignment+period so far" (PLAN §8.3).
 *
 * `manual` (an Owner's discount or correction, with a reason) and `migration` adjustments are
 * **not** netted: a later plan change leaves them standing instead of cancelling them. This is an
 * interpretation (BRD §9 / BR-07: "the full new monthly **rental**" applies), flagged for review in
 * the T-042 completion notes. To net every adjustment instead, add the sources to this list.
 */
export const RENTAL_ADJUSTMENT_SOURCES = [
  "plan_change",
  "mid_month_start",
] as const satisfies readonly AdjustmentSource[];

/** The operator setting `mid_month_start_policy` (D-18, PLAN §7.2 `operators.settings`). */
export type MidMonthStartPolicy = "charge_full_month" | "start_next_month";

export const MID_MONTH_START_POLICIES = [
  "charge_full_month",
  "start_next_month",
] as const satisfies readonly MidMonthStartPolicy[];

/** Why no adjustment is needed. Stable machine codes: the UI maps them to i18n keys. */
export type NoAdjustmentReason =
  /** Plan change: the new amount equals what is already charged for the period. */
  | "same_amount"
  /**
   * Plan change: the connection has no rent for this period yet (no bill line, no mid-month
   * charge), so there is nothing to correct. The next bill charges the new amount.
   */
  | "not_billed_this_period"
  /** Mid-month start: the period's billing run will charge this connection itself. */
  | "billed_by_run"
  /** Mid-month start: the operator's policy is `start_next_month`. */
  | "start_next_month"
  /** Mid-month start: the connection already has rent for this period (no second charge). */
  | "already_charged"
  /** Mid-month start: the rental is ₹0, so a full month is ₹0. */
  | "zero_rental";

/**
 * What a change does to the money: nothing, or one adjustment.
 *
 * `amountPaise` is always > 0; the direction carries the sign. No rounding ever happens here (no
 * proration, BR-07), so whole-rupee inputs always give whole-rupee amounts (D-17).
 */
export type AdjustmentOutcome =
  | { readonly kind: "none"; readonly reason: NoAdjustmentReason }
  | { readonly kind: AdjustmentDirection; readonly amountPaise: Paise };

/**
 * An `adjustments` row to insert (T-045). `customer_id`, `operator_id`, `reason` and
 * `created_by` come from the service. A debit is "pending" (`invoice_id` null) until the next
 * bill picks it up as a line (PLAN §8.2); a credit acts as customer credit (PLAN §8.5).
 */
export type AdjustmentDraft = {
  readonly assignmentId: string;
  /** The period the adjustment belongs to (the month whose rent it corrects). */
  readonly period: Period;
  readonly direction: AdjustmentDirection;
  /** Always > 0. */
  readonly amountPaise: Paise;
  readonly source: AdjustmentSource;
};

/**
 * One thing that charged a connection for a period, as stored. Pass **every** record for the
 * assignment and period; the functions decide which ones count.
 *
 * - `rent`: the `invoice_lines` row of type `rent` for this assignment, on the customer's regular
 *   invoice for this period. Leave out lines of voided invoices.
 * - `adjustment`: an `adjustments` row with this `assignment_id` and `period`, whether it is
 *   still pending or already on a bill (both count: a pending debit will be billed).
 */
export type RentalChargeRecord =
  | {
      readonly kind: "rent";
      /** The invoice line id. */
      readonly id: string;
      readonly assignmentId: string;
      readonly period: Period;
      /** ≥ 0. */
      readonly amountPaise: Paise;
    }
  | {
      readonly kind: "adjustment";
      /** The adjustment id. */
      readonly id: string;
      readonly assignmentId: string;
      readonly period: Period;
      readonly direction: AdjustmentDirection;
      /** > 0 (the direction carries the sign). */
      readonly amountPaise: Paise;
      readonly source: AdjustmentSource;
    };

/**
 * Errors from the adjustment functions.
 * - `VALIDATION`: malformed input (a negative amount, an unknown policy, a record for another
 *   assignment or period, a repeated id).
 * - `INVARIANT_VIOLATION`: the stored records already break the rules (the connection was charged
 *   rent twice for the period, or its rent nets below zero). Always a bug: alert, don't continue.
 */
export type AdjustmentError = DomainError<"VALIDATION" | "INVARIANT_VIOLATION">;
