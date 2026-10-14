/**
 * The effect of a back-dated new connection in plain words (T-045a): "New connection: ₹300 a month
 * from 10 Sep 2026.", then one line per month ("September 2026: ₹300 extra will be added to the
 * next bill." / "… no charge. Rent starts from the next month."), the total, and "Bills up to
 * November 2026 are already made. …". The month, total and billed lines are T-045's
 * (../_plan-change/effect-text.ts), so a change and an add read the same. Pure, client-safe.
 */
import { businessDate, type DisplayLocale, formatBusinessDate, isBusinessDate } from "@cb/domain";
import { type EffectText, type EffectTextLine, effectText } from "../_plan-change/effect-text";
import type { AddPreviewData } from "./state";

export function addEffectText(
  preview: AddPreviewData,
  options: {
    readonly locale: DisplayLocale;
    readonly rupees: (paise: number) => string;
    readonly isOwner: boolean;
  },
): EffectText {
  // T-045's lines for the months, the total and the "bills are made" note; the rent stays the same.
  const lines = effectText(
    {
      kind: "plan",
      fromRentalPaise: preview.rentalPaise,
      toRentalPaise: preview.rentalPaise,
      noChange: false,
      backDated: preview.backDated,
      latestBilledPeriod: preview.latestBilledPeriod,
      months: preview.months,
      totalPaise: preview.totalPaise,
    },
    options,
  );
  const headline: EffectTextLine = {
    key: "add_backdated.headline",
    values: {
      amount: options.rupees(preview.rentalPaise),
      date: isBusinessDate(preview.startDate)
        ? formatBusinessDate(businessDate(preview.startDate), options.locale)
        : preview.startDate,
    },
    tone: "plain",
  };
  return { ...lines, headline };
}
