/**
 * Display and URL helpers for the money reports (T-080). Pure: no next-intl import (the translator
 * is passed in) and no `@cb/core` runtime import (client-safe), so they are unit-tested directly.
 * Amounts arrive as integer paise and are shown as whole, Indian-grouped rupees; instants in IST.
 */
import {
  addPeriods,
  type BusinessDate,
  comparePeriods,
  type DisplayLocale,
  formatBusinessDate,
  isBusinessDate,
  isPeriod,
  monthsBetween,
  type Period,
} from "@cb/domain";
import type { IconName, StatusPillVariant } from "@cb/ui";
import { istDateTime } from "@/components/bills/format";

/** A translator (next-intl's `t`, or a test double). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** The ageing buckets, newest first (same values as `@cb/core` `AGEING_BUCKETS`). */
export const BUCKETS = ["d0_30", "d31_60", "d61_90", "d90_plus"] as const;
export type Bucket = (typeof BUCKETS)[number];

/** Older is more urgent: amber for the first two months, red after (icon + colour + word). */
export const BUCKET_PILL: Record<Bucket, { variant: StatusPillVariant; icon: IconName }> = {
  d0_30: { variant: "pending", icon: "pending" },
  d31_60: { variant: "pending", icon: "pending" },
  d61_90: { variant: "danger", icon: "danger" },
  d90_plus: { variant: "danger", icon: "danger" },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Param = string | string[] | undefined;
export const firstParam = (value: Param) => (Array.isArray(value) ? value[0] : value);

/** `?area=` when it is a UUID (lower-cased), else undefined. */
export function pickId(raw: Param): string | undefined {
  const value = firstParam(raw);
  return value && UUID.test(value) ? value.toLowerCase() : undefined;
}

/** `?x=` when it is one of `options`, else undefined. */
export function pickOption<T extends string>(raw: Param, options: readonly T[]): T | undefined {
  const value = firstParam(raw);
  return options.find((option) => option === value);
}

/** `?page=` as 1 … 10,000. */
export function pickPage(raw: Param): number {
  const value = Number.parseInt(firstParam(raw) ?? "1", 10);
  return Math.max(1, Math.min(10_000, Number.isFinite(value) ? value : 1));
}

/** `?date=` when it is a real date not after `today`; `undefined` = today (now). */
export function pickPastDate(raw: Param, today: BusinessDate): BusinessDate | undefined {
  const value = firstParam(raw);
  if (value === undefined || !isBusinessDate(value)) return undefined;
  return value < today ? value : undefined;
}

/** `?from=&to=` months (at most 12, from ≤ to, not after `current`); else the last 3 months. */
export function pickMonthRange(
  rawFrom: Param,
  rawTo: Param,
  current: Period,
): { from: Period; to: Period; fixed: boolean } {
  const from = firstParam(rawFrom);
  const to = firstParam(rawTo);
  const fallback = { from: addPeriods(current, -2), to: current };
  if (from === undefined && to === undefined) return { ...fallback, fixed: false };
  if (!isPeriod(from) || !isPeriod(to)) return { ...fallback, fixed: true };
  const span = monthsBetween(from, to);
  if (span < 0 || span >= 12 || comparePeriods(to, current) > 0) {
    return { from: current, to: current, fixed: true };
  }
  return { from, to, fixed: false };
}

/** The months a report can choose from: `current` back `count` months, newest first. */
export function monthOptions(current: Period, count = 36): Period[] {
  return Array.from({ length: count }, (_, index) => addPeriods(current, -index));
}

/** "Numbers as of 2 Nov 2026, 10:00 am" / "… as of the end of 31 Oct 2026". */
export function asOfText(
  asOf: { at: Date; date: BusinessDate; endOfDay: boolean },
  locale: DisplayLocale,
  t: Translate,
): string {
  return asOf.endOfDay
    ? t("as_of.end_of_day", { date: formatBusinessDate(asOf.date, locale) })
    : t("as_of.now", { when: istDateTime(asOf.at, locale) });
}

/** A query string from defined, non-default values (`page` 1 is left out). */
export function query(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === "") continue;
    if (key === "page" && Number(value) <= 1) continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function duesHref(filters: {
  date?: string | undefined;
  area?: string | undefined;
  show?: "due" | "advance" | undefined;
  age?: Bucket | undefined;
  page?: number | undefined;
}): string {
  return `/reports/dues${query({
    date: filters.date,
    area: filters.area,
    show: filters.show === "advance" ? "advance" : undefined,
    age: filters.show === "advance" ? undefined : filters.age,
    page: filters.page,
  })}`;
}

export function customerHref(customerId: string): string {
  return `/customers/${customerId}`;
}
