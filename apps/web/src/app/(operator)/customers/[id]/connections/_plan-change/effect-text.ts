/**
 * The effect preview in plain words (T-045, PLAN §12.2 / §2.2 rules 2 and 7: numbers first, say
 * what will happen before saving): "October: ₹50 extra will be added to the next bill." One line
 * per month the change touches, then the total. Pure and client-safe; message keys are in the
 * `adjustments` namespace (`effect.*`).
 */
import { type DisplayLocale, isPeriod, periodLabel } from "@cb/domain";
import type { PreviewData } from "./results";

export interface EffectTextLine {
  readonly key: string;
  readonly values: Record<string, string>;
  /** `due`: more to pay (red text); `credit`: less to pay (green text); `plain`. */
  readonly tone: "due" | "credit" | "plain";
}

export interface EffectText {
  /** The rent headline, or "nothing changes". */
  readonly headline: EffectTextLine;
  readonly months: readonly EffectTextLine[];
  readonly total: EffectTextLine | null;
  /**
   * The change reaches back into a billed month: Staff can't save it (`billed_staff`); the Owner
   * saves it through the back-dated flow with a reason (`billed_owner` is only the note).
   */
  readonly billed: EffectTextLine | null;
}

const monthOf = (period: string, locale: DisplayLocale) =>
  isPeriod(period) ? periodLabel(period, locale, "long") : period;

export function effectText(
  preview: PreviewData,
  options: {
    readonly locale: DisplayLocale;
    readonly rupees: (paise: number) => string;
    readonly isOwner: boolean;
  },
): EffectText {
  const { locale, rupees } = options;
  if (preview.noChange) {
    return {
      headline: { key: "effect.same", values: {}, tone: "plain" },
      months: [],
      total: null,
      billed: null,
    };
  }
  const headline: EffectTextLine =
    preview.kind === "plan"
      ? {
          key: "effect.new_rent",
          values: { to: rupees(preview.toRentalPaise), from: rupees(preview.fromRentalPaise) },
          tone: "plain",
        }
      : { key: `backdate.kind.${preview.kind}`, values: {}, tone: "plain" };

  const months = preview.months.map((month): EffectTextLine => {
    const values = { month: monthOf(month.period, locale) };
    if (month.outcome.kind === "none") {
      return { key: `effect.reason.${month.outcome.reason}`, values, tone: "plain" };
    }
    return {
      key: `effect.${month.outcome.kind}`,
      values: { ...values, amount: rupees(month.outcome.amountPaise) },
      tone: month.outcome.kind === "debit" ? "due" : "credit",
    };
  });

  const total: EffectTextLine =
    preview.totalPaise > 0
      ? { key: "effect.total_debit", values: { amount: rupees(preview.totalPaise) }, tone: "due" }
      : preview.totalPaise < 0
        ? {
            key: "effect.total_credit",
            values: { amount: rupees(-preview.totalPaise) },
            tone: "credit",
          }
        : { key: "effect.total_none", values: {}, tone: "plain" };

  const billed: EffectTextLine | null =
    preview.backDated && preview.latestBilledPeriod
      ? {
          key: options.isOwner ? "effect.billed_owner" : "effect.billed_staff",
          values: { month: monthOf(preview.latestBilledPeriod, locale) },
          tone: "plain",
        }
      : null;

  return { headline, months, total, billed };
}
