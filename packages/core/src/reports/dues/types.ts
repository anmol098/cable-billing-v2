/**
 * What the dues and ageing report returns (T-080). Amounts are integer paise, instants UTC `Date`s,
 * business dates and periods IST.
 */
import type { CustomerStatus } from "@cb/db";
import type { Paise, Period } from "@cb/domain";
import type { AgeingBucket, BucketAmounts } from "./ageing";
import type { ReportAsOf } from "./as-of";

/** Which customers the list shows: those who owe money (default) or those with an advance. */
export const DUES_LIST_KINDS = ["due", "advance"] as const;
export type DuesListKind = (typeof DUES_LIST_KINDS)[number];

/** One customer of the list. Exactly one of `duePaise` / `advancePaise` is > 0. */
export interface DuesRow {
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly phone: string | null;
  readonly customerStatus: CustomerStatus;
  readonly areaId: string | null;
  readonly areaName: string | null;
  /** The ledger balance as of the report (signed: > 0 owes, < 0 advance). */
  readonly balancePaise: Paise;
  /** max(balance, 0). */
  readonly duePaise: Paise;
  /** max(−balance, 0). */
  readonly advancePaise: Paise;
  /** The due spread over the ageing buckets (Σ = `duePaise`). */
  readonly buckets: BucketAmounts;
  /** The oldest month with an unpaid part of the due ("Unpaid since"), `null` if none on a bill. */
  readonly oldestDuePeriod: Period | null;
  /** The bucket of `oldestDuePeriod` (0–30 when `null`); `null` for an advance row. */
  readonly oldestBucket: AgeingBucket | null;
}

/** Totals of a group of customers. `netPaise` = `duePaise − advancePaise` = Σ their ledger. */
export interface DuesTotals {
  /** Customers who owe money. */
  readonly dueCustomers: number;
  readonly duePaise: Paise;
  readonly buckets: BucketAmounts;
  /** Customers with an advance. */
  readonly advanceCustomers: number;
  readonly advancePaise: Paise;
  readonly netPaise: Paise;
  /** Customers per oldest bucket (owing customers only). */
  readonly customersByBucket: Readonly<Record<AgeingBucket, number>>;
}

/** One area's totals (`areaId: null` = customers without an area). */
export interface DuesAreaTotals extends DuesTotals {
  readonly areaId: string | null;
  readonly areaName: string | null;
}

export interface DuesReport {
  readonly asOf: ReportAsOf;
  /** Every area of the tenant, by name (the filter's options). */
  readonly areas: readonly { readonly id: string; readonly name: string }[];
  /** Totals of every customer matching the area filter (all buckets, both kinds). */
  readonly totals: DuesTotals;
  /** The same per area (only areas with a due or an advance), by name; no-area last. */
  readonly byArea: readonly DuesAreaTotals[];
  /** The list page (filters: area, kind, bucket). */
  readonly rows: readonly DuesRow[];
  /** Totals of every row matching the list's filters (not only this page): the totals row. */
  readonly listTotals: DuesTotals;
  readonly page: number;
  readonly pageSize: number;
}
