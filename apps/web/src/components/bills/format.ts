/**
 * Display helpers for the Bills pages (T-047). Pure: no next-intl import (the translator is
 * passed in) and no `@cb/core` import (client-safe), so they are unit-tested directly. Amounts
 * arrive as integer paise and are shown as whole, Indian-grouped rupees; instants in IST.
 */
import type { BillingRunStatus } from "@cb/db";
import {
  addPeriods,
  businessDateOf,
  comparePeriods,
  type DisplayLocale,
  dateParts,
  formatBusinessDate,
  isPeriod,
  type Period,
  periodFromYearMonth,
  periodLabel,
} from "@cb/domain";
import { formatRupees, type IconName, type StatusPillVariant } from "@cb/ui";

/** A translator for the `bills` namespace (next-intl's `t`, or a test double). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Paise → Indian-grouped rupees without the sign (`12345600` → `"1,23,456"`); for `₹{amount}`. */
export function rupees(paise: number): string {
  return formatRupees(paise).text.replace(/^₹/, "");
}

/** `"November 2026"` / `"नवंबर 2026"`. */
export function monthText(period: Period, locale: DisplayLocale): string {
  return periodLabel(period, locale, "long");
}

const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** An instant's IST date: `"5 Nov 2026"` / `"5 नव 2026"`. */
export function istDate(at: Date, locale: DisplayLocale): string {
  return formatBusinessDate(businessDateOf(at), locale);
}

/** An instant in IST: `"5 Nov 2026, 11:30 am"`. */
export function istDateTime(at: Date, locale: DisplayLocale): string {
  return `${istDate(at, locale)}, ${IST_CLOCK.format(at)}`;
}

/** `?month=` (a `YYYY-MM-01` period) when it is one, else `undefined`. */
export function monthParam(raw: string | string[] | undefined): Period | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && isPeriod(value) ? value : undefined;
}

/** The month to show: `?month=` clamped to [first, current], else the current month. */
export function pickMonth(
  raw: string | string[] | undefined,
  current: Period,
  first: Period,
): Period {
  const wanted = monthParam(raw);
  if (wanted === undefined || comparePeriods(wanted, current) > 0) return current;
  if (comparePeriods(wanted, first) < 0) return first;
  return wanted;
}

/** `?year=` as a year between 2000 and the current year, else the current year. */
export function pickYear(raw: string | string[] | undefined, current: Period): number {
  const currentYear = dateParts(current).year;
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(value) || value < 2000 || value > currentYear) return currentYear;
  return value;
}

/** The twelve periods of a year. */
export function yearPeriods(year: number): { from: Period; to: Period } {
  return { from: periodFromYearMonth(year, 1), to: periodFromYearMonth(year, 12) };
}

/** Previous / next month links inside [first, current] (null at the ends). */
export function monthNeighbours(
  period: Period,
  current: Period,
  first: Period,
): { previous: Period | null; next: Period | null } {
  const previous = addPeriods(period, -1);
  const next = addPeriods(period, 1);
  return {
    previous: comparePeriods(previous, first) < 0 ? null : previous,
    next: comparePeriods(next, current) > 0 ? null : next,
  };
}

export function runsHref(period: Period, options: { preview?: boolean } = {}): string {
  const params = new URLSearchParams({ month: period });
  if (options.preview) params.set("preview", "1");
  return `/bills/runs?${params.toString()}`;
}

export function registerHref(
  period: Period,
  filters: { areaId?: string | undefined; payState?: string | undefined; page?: number } = {},
): string {
  const params = new URLSearchParams({ month: period });
  if (filters.areaId) params.set("area", filters.areaId);
  if (filters.payState) params.set("paid", filters.payState);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  return `/bills/register?${params.toString()}`;
}

export function billHref(invoiceId: string): string {
  return `/bills/${invoiceId}`;
}

/** What the calendar and the run page say about a month's run. */
export type RunState = BillingRunStatus | "none";

/** Status pill per run state (icon + colour + word, PLAN §2.2). */
export const RUN_STATE_PILL: Record<RunState, { variant: StatusPillVariant; icon: IconName }> = {
  none: { variant: "pending", icon: "pending" },
  pending: { variant: "pending", icon: "pending" },
  running: { variant: "pending", icon: "pending" },
  completed: { variant: "success", icon: "success" },
  completed_with_errors: { variant: "danger", icon: "danger" },
  failed: { variant: "danger", icon: "danger" },
  skipped: { variant: "danger", icon: "danger" },
};

/** True while a job owns the run (the page refreshes itself, Run/Retry are hidden). */
export function isRunInProgress(state: RunState): boolean {
  return state === "pending" || state === "running";
}

/** Status pill per bill pay state. */
export const PAY_STATE_PILL: Record<
  "unpaid" | "part_paid" | "paid" | "no_charge" | "void",
  { variant: StatusPillVariant; icon: IconName }
> = {
  unpaid: { variant: "danger", icon: "danger" },
  part_paid: { variant: "pending", icon: "pending" },
  paid: { variant: "success", icon: "success" },
  no_charge: { variant: "success", icon: "success" },
  void: { variant: "danger", icon: "close" },
};

/** Item reasons whose meaning is "the customer's account rows don't add up" (T-044). */
const BOOK_REASONS = new Set(["balance_mismatch", "credit_mismatch"]);

/** T-040's validation reasons: the connection timeline is inconsistent. */
const CONNECTION_REASONS = new Set([
  "invalid_period",
  "invalid_amount",
  "invalid_id",
  "duplicate_id",
  "other_customer",
  "credit_adjustment",
  "invalid_date",
  "unknown_event_type",
  "end_before_start",
  "event_before_start",
  "event_after_end",
  "activated_not_on_start",
  "invalid_transition",
  "end_date_mismatch",
  "invalid_input",
]);

/** A run item's machine reason → `problems.reason.<key>`. */
export function problemReasonKey(reason: string): "books" | "connection" | "other" {
  if (BOOK_REASONS.has(reason)) return "books";
  if (CONNECTION_REASONS.has(reason)) return "connection";
  return "other";
}

/** The word for a bill line (`line.<key>`): rent, or the bill change's source. */
export function lineKey(line: {
  readonly type: "rent" | "adjustment";
  readonly adjustment: { readonly source: string } | null;
}): string {
  if (line.type === "rent") return "rent";
  return line.adjustment?.source ?? "manual";
}
