/**
 * URL query → export filters (T-082). Each kind reads **the same query parameters, with the same
 * pickers and defaults, as its page** (the customer list, `/reports/*`), so "Download this list"
 * on a page gives a file with exactly the rows that page lists, every page of them. The download
 * page's forms use the same names. Pure.
 *
 * Unlike the pages, an id that is not this business's is not silently dropped: the export answers
 * NOT_FOUND (the page would show everything instead, but a file should be what was asked for).
 */
import {
  BILL_PAY_STATES,
  DUES_LIST_KINDS,
  type ExportInput,
  type ExportKind,
  HANDOVER_DEFAULT_DAYS,
  HANDOVER_DIFFERENCES,
  OWN_AMOUNT,
  PAYMENT_LIST_STATUSES,
} from "@cb/core";
import {
  ASSIGNMENT_STATUSES,
  BILLING_RUN_ITEM_OUTCOMES,
  COLLECTION_SESSION_STATUSES,
} from "@cb/db";
import { type BusinessDate, businessDateOf, periodOfInstant } from "@cb/domain";
import { pickDays } from "@/app/(operator)/reports/collections/_lib/days";
import { monthParam } from "@/components/bills/format";
import { dayParam, monthStart } from "@/components/payments/format";
import {
  BUCKETS,
  firstParam,
  pickId,
  pickMonthRange,
  pickOption,
  pickPastDate,
} from "@/components/reports/format";

export type Param = string | string[] | undefined;
export type Params = Readonly<Record<string, Param>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bill register's "Paid?" choices (as on `/reports/bills`). */
const BILL_FILTER_STATES = BILL_PAY_STATES.filter((state) => state !== "no_charge");

/** Paging and anything that only steers the page, never the rows. */
const NOT_FILTERS = new Set(["page"]);

/** A `YYYY-MM` from a month field → the `YYYY-MM-01` period the pickers take. */
function monthOf(raw: Param): Param {
  const value = firstParam(raw);
  return value && /^\d{4}-\d{2}$/.test(value) ? `${value}-01` : raw;
}

/** `URLSearchParams` → the record shape pages get as `searchParams`. */
export function paramsOf(search: URLSearchParams): Params {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(search.keys())) {
    const values = search.getAll(key);
    out[key] = values.length === 1 ? (values[0] ?? "") : values;
  }
  return out;
}

/** The export of `kind` with the filters in `params`, read as the page reads them. */
export function exportInputFromParams(kind: ExportKind, params: Params, now: Date): ExportInput {
  const today = businessDateOf(now);
  switch (kind) {
    case "customers": {
      const q = (firstParam(params.q) ?? "").slice(0, 100);
      const area = firstParam(params.area) ?? "";
      const status = pickOption(params.status, ["active", "inactive"] as const) ?? "all";
      return {
        kind,
        filters: {
          ...(q.trim() ? { q } : {}),
          ...(area === "none" || UUID.test(area) ? { areaId: area.toLowerCase() } : {}),
          status,
        },
      };
    }
    case "bills": {
      const range = pickMonthRange(monthOf(params.from), monthOf(params.to), periodOfInstant(now));
      const payState = pickOption(params.paid, BILL_FILTER_STATES);
      const areaId = pickId(params.area);
      return { kind, filters: { from: range.from, to: range.to, payState, areaId } };
    }
    case "payments": {
      let from: BusinessDate = dayParam(params.from) ?? monthStart(today);
      let to: BusinessDate = dayParam(params.to) ?? today;
      if (from > to) {
        from = monthStart(today);
        to = today;
      }
      const collectorId = pickId(params.collector);
      const method = pickOption(params.method, ["cash", "upi"] as const);
      const status = pickOption(params.status, PAYMENT_LIST_STATUSES) ?? "all";
      return { kind, filters: { from, to, collectorId, method, status } };
    }
    case "dues": {
      const asOfDate = pickPastDate(params.date, today);
      const show = pickOption(params.show, DUES_LIST_KINDS) ?? "due";
      const bucket = show === "due" ? pickOption(params.age, BUCKETS) : undefined;
      return { kind, filters: { asOfDate, areaId: pickId(params.area), kind: show, bucket } };
    }
    case "collections": {
      const { from, to } = pickDays(params.from, params.to, today);
      return { kind, filters: { from, to, collectorId: pickId(params.collector) } };
    }
    case "handover": {
      const { from, to } = pickDays(params.from, params.to, today, HANDOVER_DEFAULT_DAYS);
      return {
        kind,
        filters: {
          from,
          to,
          linemanId: pickId(params.lineman),
          status: pickOption(params.status, COLLECTION_SESSION_STATUSES),
          difference: pickOption(params.difference, HANDOVER_DIFFERENCES),
        },
      };
    }
    case "connections": {
      const date = pickPastDate(params.date, today) ?? today;
      const plan = firstParam(params.plan) === OWN_AMOUNT ? OWN_AMOUNT : pickId(params.plan);
      return {
        kind,
        filters: {
          date,
          areaId: pickId(params.area),
          status: pickOption(params.status, ASSIGNMENT_STATUSES),
          plan,
        },
      };
    }
    case "billing_runs": {
      return {
        kind,
        filters: {
          period: monthParam(monthOf(params.month)),
          outcome: pickOption(params.outcome, BILLING_RUN_ITEM_OUTCOMES),
          areaId: pickId(params.area),
        },
      };
    }
  }
}

/** `/api/exports/<kind>?…` with a page's filters (its paging left out). */
export function exportHref(kind: ExportKind, params: Params = {}): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (NOT_FILTERS.has(key) || raw === undefined) continue;
    for (const value of Array.isArray(raw) ? raw : [raw])
      if (value !== "") search.append(key, value);
  }
  const query = search.toString();
  return `/api/exports/${kind.replace(/_/g, "-")}${query ? `?${query}` : ""}`;
}

/** The kind of `/api/exports/<slug>` (`billing-runs` → `billing_runs`), or `undefined`. */
export function kindOfSlug(slug: string, kinds: readonly ExportKind[]): ExportKind | undefined {
  const kind = slug.replace(/-/g, "_");
  return kinds.find((k) => k === kind);
}
