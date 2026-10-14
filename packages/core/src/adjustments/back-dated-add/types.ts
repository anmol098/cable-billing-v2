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
   * The add must correct months whose bills are made or whose billing run has been (./months.ts;
   * PLAN §8.3): only the Owner may do it, through `adjustments.back_dated_add`, with a reason.
   * Staff get CONFLICT `billed_period` from `connections.add` when the start reaches before the
   * customer's latest billed month.
   */
  readonly backDated: boolean;
  /**
   * The latest month whose bills are made for the customer or whose run has been (null: none):
   * "Bills up to {month} are already made".
   */
  readonly latestBilledPeriod: Period | null;
  readonly policy: MidMonthStartPolicy;
  /**
   * The start month (`change_month`: the D-18 policy, or its full rent for a start on the 1st of a
   * covered month) and every covered month after it (its full rent, `later_month`), oldest first.
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
