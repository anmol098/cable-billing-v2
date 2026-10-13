/**
 * Month and date labels in English and Hindi (PLAN §2.2 rule 10): `12 Oct 2026` / `12 अक्टू 2026`,
 * and periods as `October 2026` / `अक्टूबर 2026`. Digits stay Latin in Hindi (PLAN §11.4).
 *
 * These live here, not in `packages/i18n`, because the server, receipts, CSV exports and the mobile
 * API all need the same text without an i18n runtime, and month names are data rather than copy.
 * The Hindi names are machine-drafted and part of the H-03 Hindi review (D-23); the short forms
 * follow the glossary's `अक्टू`.
 *
 * No `Intl`: ICU builds disagree on Hindi abbreviations (`अक्तू॰` vs `अक्टू`), and Android must match.
 */

import { type BusinessDate, dateParts } from "./business-date";
import type { DisplayLocale } from "./locale";
import type { Period } from "./period";

type Months = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

export const MONTH_NAMES: Readonly<Record<DisplayLocale, { long: Months; short: Months }>> = {
  en: {
    long: [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ],
    short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
  hi: {
    long: [
      "जनवरी",
      "फ़रवरी",
      "मार्च",
      "अप्रैल",
      "मई",
      "जून",
      "जुलाई",
      "अगस्त",
      "सितंबर",
      "अक्टूबर",
      "नवंबर",
      "दिसंबर",
    ],
    short: ["जन", "फ़र", "मार्च", "अप्रैल", "मई", "जून", "जुल", "अग", "सित", "अक्टू", "नव", "दिस"],
  },
};

export type MonthStyle = "long" | "short";

/** The name of `month` (1–12). */
export function monthName(
  month: number,
  locale: DisplayLocale,
  style: MonthStyle = "long",
): string {
  const name = MONTH_NAMES[locale][style][month - 1];
  if (name === undefined) throw new RangeError(`month must be 1–12, got ${month}`);
  return name;
}

/** `"October 2026"` / `"अक्टूबर 2026"` (`style: "short"`: `"Oct 2026"` / `"अक्टू 2026"`). */
export function periodLabel(
  current: Period,
  locale: DisplayLocale,
  style: MonthStyle = "long",
): string {
  const { year, month } = dateParts(current);
  return `${monthName(month, locale, style)} ${year}`;
}

/** `"12 Oct 2026"` / `"12 अक्टू 2026"` (`style: "long"`: `"12 October 2026"`). */
export function formatBusinessDate(
  date: BusinessDate,
  locale: DisplayLocale,
  style: MonthStyle = "short",
): string {
  const { year, month, day } = dateParts(date);
  return `${day} ${monthName(month, locale, style)} ${year}`;
}
