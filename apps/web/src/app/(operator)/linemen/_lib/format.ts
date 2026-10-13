/**
 * Display helpers for the Linemen pages (T-062). Pure: no next-intl import, the translator is
 * passed in, so they are unit-tested directly. Amounts arrive as integer paise and are shown as
 * Indian-grouped rupees; instants are shown in IST (CLAUDE.md "Time").
 */
import type { CollectionSessionStatus } from "@cb/db";
import {
  type BusinessDate,
  businessDateOf,
  type DisplayLocale,
  formatBusinessDate,
  isBusinessDate,
} from "@cb/domain";
import { formatRupees, type IconName, type StatusPillVariant } from "@cb/ui";

/** A translator for the `linemen` namespace (next-intl's `t`, or a test double). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Paise → Indian-grouped rupees without the sign (`12345600` → `"1,23,456"`); for `₹{amount}`. */
export function rupees(paise: number): string {
  return formatRupees(paise).text.replace(/^₹/, "");
}

const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** `"4:05"` + AM/PM of an instant, in IST. */
export function istClock(at: Date): { time: string; pm: boolean } {
  const parts = IST_CLOCK.formatToParts(at);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const period = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  return { time: `${hour}:${minute}`, pm: period.toLowerCase().startsWith("p") };
}

/** An instant as words: `"4:05 PM"` on `sameDay`, else `"12 Oct 2026, 4:05 PM"` (IST). */
export function whenText(
  t: Translate,
  at: Date,
  sameDay: BusinessDate,
  locale: DisplayLocale,
): string {
  const { time, pm } = istClock(at);
  const clock = t(pm ? "time_pm" : "time_am", { time });
  const day = businessDateOf(at);
  if (day === sameDay) return clock;
  return t("date_time", { date: formatBusinessDate(day, locale), time: clock });
}

/** "Cash matches" / "₹300 short" / "₹200 extra" for a discrepancy (handed − expected). */
export function differenceText(t: Translate, discrepancyPaise: number): string {
  if (discrepancyPaise === 0) return t("difference.match");
  if (discrepancyPaise < 0) return t("difference.short", { amount: rupees(-discrepancyPaise) });
  return t("difference.extra", { amount: rupees(discrepancyPaise) });
}

/** Status pill per handover status (icon + colour + word, PLAN §2.2). */
export const STATUS_PILL: Record<
  CollectionSessionStatus,
  { variant: StatusPillVariant; icon: IconName }
> = {
  open: { variant: "pending", icon: "pending" },
  submitted: { variant: "pending", icon: "handover" },
  accepted: { variant: "success", icon: "success" },
  returned: { variant: "danger", icon: "undo" },
};

/**
 * The day to show from `?date=`: a real `YYYY-MM-DD` not after today (IST), else today. The
 * services refuse future days, so the page never asks for one.
 */
export function pickDay(raw: string | string[] | undefined, now: Date): BusinessDate {
  const today = businessDateOf(now);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || !isBusinessDate(value)) return today;
  return value > today ? today : value;
}

/** `/linemen?date=…` (no query for today) and `/linemen/<id>?date=…`. */
export function linemenHref(date: BusinessDate, today: BusinessDate): string {
  return date === today ? "/linemen" : `/linemen?date=${date}`;
}

export function linemanHref(linemanId: string, date: BusinessDate): string {
  return `/linemen/${linemanId}?date=${date}`;
}
