/**
 * The plain-language effect of a status change (PLAN §12.2: "Rent stops from November. ₹450 old
 * due stays."), as message keys + values. Client-safe: only `@cb/domain` (the same month rules as
 * `@cb/core`'s connections/rules.ts; a unit test keeps them equal).
 *
 * - Stop / Remove effective D: rent stops from the month after D's month (PLAN §8.1: a change takes
 *   effect at the end of its day, so D's month stays charged); old due stays (BR-08, RULE-08).
 * - Remove also frees the VC from D + 1 (both date ends inclusive, T-022).
 * - Start again effective D: the monthly bill charges it again from the month after D's month.
 *   D's own month is the D-18 mid-month case (T-045's hook): under `charge_full_month` the full
 *   rent for D's month goes on the next bill, unless that month already has rent for this
 *   connection (`startCharge.chargedPeriods`, from `adjustments.charged_months`).
 */
import {
  addDays,
  type BusinessDate,
  type DisplayLocale,
  formatBusinessDate,
  nextPeriod,
  type Period,
  periodLabel,
  periodOf,
} from "@cb/domain";

export type StatusActionName = "suspend" | "reactivate" | "disconnect";

export interface EffectLine {
  readonly key: "rent_stops" | "rent_starts" | "charge_month" | "old_due" | "reuse" | "final";
  readonly values: Record<string, string>;
}

/** What "Start again" needs to say whether D's month gets a full-month charge (D-18, T-045). */
export interface StartCharge {
  readonly policy: "charge_full_month" | "start_next_month";
  readonly rentalPaise: number;
  /** Recent months (`YYYY-MM-01`) that already have rent for this connection. */
  readonly chargedPeriods: readonly string[];
}

/** First month without rent after a stop / removal effective `date`. */
export function rentStopsFrom(date: BusinessDate): Period {
  return nextPeriod(periodOf(date));
}

/** First month the monthly bill charges a connection started again effective `date`. */
export function rentStartsAgainFrom(date: BusinessDate): Period {
  return nextPeriod(periodOf(date));
}

/**
 * The effect lines for `action` effective `date`. `duePaise` is the customer's current balance
 * (> 0 = due); `formatRupees` turns paise into "1,234" (no ₹: the messages add it).
 */
export function effectLines(input: {
  readonly action: StatusActionName;
  readonly date: BusinessDate;
  readonly duePaise: number;
  readonly locale: DisplayLocale;
  readonly rupees: (paise: number) => string;
  readonly startCharge?: StartCharge | null;
}): EffectLine[] {
  const { action, date, locale } = input;
  const lines: EffectLine[] = [];
  if (action === "reactivate") {
    const charge = input.startCharge;
    const month = periodOf(date);
    if (
      charge &&
      charge.policy === "charge_full_month" &&
      charge.rentalPaise > 0 &&
      !charge.chargedPeriods.includes(month)
    ) {
      lines.push({
        key: "charge_month",
        values: { amount: input.rupees(charge.rentalPaise), month: periodLabel(month, locale) },
      });
    }
    lines.push({
      key: "rent_starts",
      values: { month: periodLabel(rentStartsAgainFrom(date), locale) },
    });
    return lines;
  }
  lines.push({ key: "rent_stops", values: { month: periodLabel(rentStopsFrom(date), locale) } });
  if (input.duePaise > 0) {
    lines.push({ key: "old_due", values: { amount: input.rupees(input.duePaise) } });
  }
  if (action === "disconnect") {
    lines.push({ key: "reuse", values: { date: formatBusinessDate(addDays(date, 1), locale) } });
    lines.push({ key: "final", values: {} });
  }
  return lines;
}
