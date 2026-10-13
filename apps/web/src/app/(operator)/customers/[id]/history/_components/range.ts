/**
 * The History tab's time choice (T-049), from the URL: `?range=month|3m|12m|all`, or
 * `?from=YYYY-MM-DD&to=YYYY-MM-DD` (IST dates, both included). Pure (no next-intl, no core), so it
 * is unit-tested directly and shared by the page and the printed statement.
 */
import {
  addPeriods,
  type BusinessDate,
  compareBusinessDates,
  type DisplayLocale,
  formatBusinessDate,
  isBusinessDate,
  periodOf,
} from "@cb/domain";
import type { Translate } from "@/components/bills/format";

export const STATEMENT_PRESETS = ["month", "3m", "12m", "all"] as const;
export type StatementPreset = (typeof STATEMENT_PRESETS)[number];
/** What the tab shows when the URL says nothing. */
export const DEFAULT_PRESET: StatementPreset = "3m";

export interface StatementChoice {
  /** The preset, or `custom` for typed dates. */
  readonly preset: StatementPreset | "custom";
  /** First day (IST); undefined = from the first line ever. */
  readonly from: BusinessDate | undefined;
  /** Last day (IST); undefined = today. */
  readonly to: BusinessDate | undefined;
  /** The typed dates were wrong (bad date, end before start, start after today): default used. */
  readonly invalid: boolean;
}

type Query = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

/** The dates a preset covers, ending today. */
export function presetRange(
  preset: StatementPreset,
  today: BusinessDate,
): { from: BusinessDate | undefined; to: BusinessDate | undefined } {
  const thisMonth = periodOf(today);
  switch (preset) {
    case "month":
      return { from: thisMonth, to: undefined };
    case "3m":
      return { from: addPeriods(thisMonth, -2), to: undefined };
    case "12m":
      return { from: addPeriods(thisMonth, -11), to: undefined };
    case "all":
      return { from: undefined, to: undefined };
  }
}

/** Reads the choice from the query; anything wrong falls back to the default preset. */
export function pickStatementRange(query: Query, today: BusinessDate): StatementChoice {
  const rawFrom = one(query.from)?.trim() || undefined;
  const rawTo = one(query.to)?.trim() || undefined;
  if (rawFrom !== undefined || rawTo !== undefined) {
    const from = rawFrom !== undefined && isBusinessDate(rawFrom) ? rawFrom : undefined;
    const to = rawTo !== undefined && isBusinessDate(rawTo) ? rawTo : undefined;
    const typo = (rawFrom !== undefined && !from) || (rawTo !== undefined && !to);
    const end = to !== undefined && compareBusinessDates(to, today) < 0 ? to : today;
    const backwards = from !== undefined && compareBusinessDates(from, end) > 0;
    if (!typo && !backwards) return { preset: "custom", from, to, invalid: false };
    return { preset: DEFAULT_PRESET, ...presetRange(DEFAULT_PRESET, today), invalid: true };
  }
  const raw = one(query.range);
  const preset = STATEMENT_PRESETS.find((p) => p === raw) ?? DEFAULT_PRESET;
  return { preset, ...presetRange(preset, today), invalid: false };
}

/** The query string for a choice (`range=` for presets, `from`/`to` for typed dates). */
export function statementQuery(choice: Pick<StatementChoice, "preset" | "from" | "to">): string {
  const params = new URLSearchParams();
  if (choice.preset === "custom") {
    if (choice.from) params.set("from", choice.from);
    if (choice.to) params.set("to", choice.to);
  } else {
    params.set("range", choice.preset);
  }
  return params.toString();
}

/** The History tab's URL for a choice. */
export function historyHref(
  customerId: string,
  choice: Pick<StatementChoice, "preset" | "from" | "to">,
): string {
  return `/customers/${customerId}/history?${statementQuery(choice)}`;
}

/** The printable statement's URL for a choice. */
export function statementPrintHref(
  customerId: string,
  choice: Pick<StatementChoice, "preset" | "from" | "to">,
): string {
  return `/customers/${customerId}/history/print?${statementQuery(choice)}`;
}

/** "1 Oct 2026 to 15 Nov 2026" / "Everything up to 15 Nov 2026". */
export function rangeText(
  range: { readonly from: BusinessDate | null; readonly to: BusinessDate },
  t: Translate,
  locale: DisplayLocale,
): string {
  const to = formatBusinessDate(range.to, locale);
  return range.from === null
    ? t("range.up_to", { to })
    : t("range.between", { from: formatBusinessDate(range.from, locale), to });
}
