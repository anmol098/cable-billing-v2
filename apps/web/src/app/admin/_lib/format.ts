/**
 * Display helpers for the admin console: times in IST, money as whole rupees (from paise),
 * percents through `Intl`. Nothing here holds words: a missing value shows the caller's fallback,
 * which comes from the messages (`admin.common.none`, `admin.common.never`).
 */
import {
  businessDateOf,
  type DisplayLocale,
  formatBusinessDate,
  formatINR,
  IST_TIME_ZONE,
  period,
  periodLabel,
} from "@cb/domain";

export function displayLocale(locale: string): DisplayLocale {
  return locale === "hi" ? "hi" : "en";
}

function intlLocale(locale: DisplayLocale): string {
  return locale === "hi" ? "hi-IN" : "en-IN";
}

/** "12 Nov 2026" (the IST day of an instant), or the fallback. */
export function dayText(at: Date, locale: DisplayLocale): string;
export function dayText(at: Date | null, locale: DisplayLocale, fallback: string): string;
export function dayText(at: Date | null, locale: DisplayLocale, fallback = ""): string {
  return at ? formatBusinessDate(businessDateOf(at), locale) : fallback;
}

/** The last IST day of paid access ending at `end` (an IST midnight): the day before. */
export function lastDayText(end: Date, locale: DisplayLocale): string;
export function lastDayText(end: Date | null, locale: DisplayLocale, fallback: string): string;
export function lastDayText(end: Date | null, locale: DisplayLocale, fallback = ""): string {
  return end ? formatBusinessDate(businessDateOf(new Date(end.getTime() - 1)), locale) : fallback;
}

/** "12 Nov 2026, 3:05 pm" in IST, or the fallback. */
export function timeText(at: Date, locale: DisplayLocale): string;
export function timeText(at: Date | null, locale: DisplayLocale, fallback: string): string;
export function timeText(at: Date | null, locale: DisplayLocale, fallback = ""): string {
  if (!at) return fallback;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: IST_TIME_ZONE,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

export function monthText(value: string, locale: DisplayLocale): string {
  return periodLabel(period(value), locale);
}

/** Whole rupees with Indian grouping, from integer paise. */
export function rupeesText(paise: number): string {
  return formatINR(paise);
}

/**
 * A percent (`66.7` → "66.7%", in the reader's locale), or the fallback for "nothing to
 * measure" (`null`). `value` is already a percent (0–100, one decimal; see core `percent()`).
 */
export function percentText(value: number | null, locale: DisplayLocale, fallback: string): string {
  if (value === null) return fallback;
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 1,
  }).format(value / 100);
}

/** First value of a search param. */
export function param(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
