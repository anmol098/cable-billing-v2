/**
 * Result types of the Owner's back-dated new connection (T-045a). Money is integer paise, months
 * are `Period`s (the 1st of the month, IST).
 */
import type { BusinessDate, MidMonthStartPolicy, Paise, Period } from "@cb/domain";
import type { AddConnectionResult } from "../../connections/types";
import type { AdjustmentView, MonthEffectView } from "../types";

/** `adjustments.preview_add`: what adding the connection would do to the bills, month by month. */
export interface AddConnectionPreview {
  readonly customerId: string;
  readonly startDate: BusinessDate;
  /** The monthly rent the connection would have (the plan's amount, or the own amount). */
  readonly rentalPaise: Paise;
  /**
   * The start day is in a month that is already billed for the customer while a later month is
   * billed too (PLAN §8.3): only the Owner may add it, through `adjustments.back_dated_add`, with
   * a reason. Staff get CONFLICT `billed_period` from `connections.add`.
   */
  readonly backDated: boolean;
  /** The customer's latest billed month (null: never billed). */
  readonly latestBilledPeriod: Period | null;
  readonly policy: MidMonthStartPolicy;
  /**
   * The start month (D-18 policy, `change_month`) and every billed month after it (its full rent,
   * `later_month`), oldest first.
   */
  readonly months: readonly MonthEffectView[];
  /** Σ of the adjustments the add would make (always ≥ 0: a start only adds rent). */
  readonly totalPaise: Paise;
}

/** `adjustments.back_dated_add` result. */
export interface BackDatedAddConnectionResult extends AddConnectionResult {
  /** The `activated` event of the new connection. */
  readonly eventId: string;
  /** The adjustments made, oldest month first, each with the Owner's reason. */
  readonly adjustments: readonly AdjustmentView[];
  readonly months: readonly MonthEffectView[];
  readonly totalPaise: Paise;
}
