/**
 * Fixtures for the report component tests (T-080): real translators over the generated messages,
 * and report objects shaped like the `@cb/core` report services return them.
 */
import type { DuesAreaTotals, DuesRow, DuesTotals } from "@cb/core";
import { businessDate, type Paise, period } from "@cb/domain";
import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";
import type { Translate } from "./format";

export function reportsT(locale: "en" | "hi" = "en"): Translate {
  const t = createTranslator({
    locale,
    messages: locale === "en" ? en : hi,
    namespace: "reports",
  });
  return t as unknown as Translate;
}

const p = (value: number) => value as Paise;

export const AS_OF_NOW = {
  at: new Date("2026-11-02T04:30:00.000Z"),
  date: businessDate("2026-11-02"),
  endOfDay: false,
};

export function duesTotals(overrides: Partial<DuesTotals> = {}): DuesTotals {
  return {
    dueCustomers: 5,
    duePaise: p(405_000),
    buckets: { d0_30: p(0), d31_60: p(145_000), d61_90: p(125_000), d90_plus: p(135_000) },
    advanceCustomers: 1,
    advancePaise: p(160_000),
    netPaise: p(245_000),
    customersByBucket: { d0_30: 0, d31_60: 0, d61_90: 2, d90_plus: 3 },
    ...overrides,
  };
}

export function areaTotals(
  areaId: string | null,
  areaName: string | null,
  overrides: Partial<DuesTotals> = {},
): DuesAreaTotals {
  return { areaId, areaName, ...duesTotals(overrides) };
}

export function duesRow(overrides: Partial<DuesRow> = {}): DuesRow {
  return {
    customerId: "0193a000-0000-7000-8000-0000000000a1",
    customerCode: "A-1",
    customerName: "Asha Devi",
    phone: "9876543210",
    customerStatus: "active",
    areaId: "0193a000-0000-7000-8000-0000000000f1",
    areaName: "North",
    balancePaise: p(100_000),
    duePaise: p(100_000),
    advancePaise: p(0),
    buckets: { d0_30: p(0), d31_60: p(30_000), d61_90: p(30_000), d90_plus: p(40_000) },
    oldestDuePeriod: period("2026-07-01"),
    oldestBucket: "d90_plus",
    ...overrides,
  };
}
