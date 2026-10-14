/**
 * The words of the subscription emails (T-085): trial ending (T-7, T-1), grace started, grace
 * ending (T-7, T-1) and "working again" with the missed bill months (D-25). i18n namespace
 * `subscription`, in the owner's language; dates in IST, amounts in whole rupees (formatted in
 * code). Honest: says only what we know (dates, that the payment has not reached us).
 */
import type { RenderSubscriptionNotice } from "@cb/core";
import { formatBusinessDate, formatINR, period, periodLabel } from "@cb/domain";
import { createTranslator } from "next-intl";
import { baseUrls } from "@/env";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";

const MESSAGES = { en, hi } as const;

/** Path of the subscription page (the email's link). */
export const SUBSCRIPTION_PAGE_PATH = "/settings/subscription";
/** Path of the bill runs page (missed bill runs, T-047). */
export const BILL_RUNS_PAGE_PATH = "/bills/runs";

/** `YYYY-MM-01` periods → "October 2026, November 2026". */
export function missedMonthsText(periods: readonly string[], locale: "en" | "hi"): string {
  return periods.map((p) => periodLabel(period(p), locale)).join(", ");
}

export const renderSubscriptionNotice: RenderSubscriptionNotice = ({
  language,
  notice,
  plan,
  missedRunPeriods,
}) => {
  const t = createTranslator({
    locale: language,
    messages: MESSAGES[language],
    namespace: "subscription.email",
  });
  const date = formatBusinessDate(notice.lastDay, language);
  const total = formatINR(plan.totalPaise);
  const path =
    notice.kind === "reactivated" && missedRunPeriods.length > 0
      ? BILL_RUNS_PAGE_PATH
      : SUBSCRIPTION_PAGE_PATH;
  let url = path;
  try {
    url = `${baseUrls().app}${path}`;
  } catch {
    // No base URL configured: the path alone still tells the Owner where to go.
  }
  const lines: string[] = [t(`${notice.kind}.body`, { date, total })];
  if (notice.kind === "reactivated" && missedRunPeriods.length > 0) {
    lines.push(
      "",
      t("reactivated.missed", { months: missedMonthsText(missedRunPeriods, language) }),
    );
  }
  lines.push("", t("open", { url }), "", t("data_kept"));
  return { subject: t(`${notice.kind}.subject`, { date }), text: lines.join("\n") };
};
