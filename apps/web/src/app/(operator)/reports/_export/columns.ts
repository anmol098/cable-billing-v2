/**
 * The columns of each export (T-082): a heading and a cell per row, in the reader's language. The
 * rows are the `@cb/core` services' own rows (`ExportRowTypes`); the words are the ones the pages
 * use (one vocabulary: pay states, methods, statuses and reasons come from their own namespaces),
 * plus column headings from the `exports` namespace.
 *
 * - Money: rupees from integer paise (`rupeesCell`), with "(₹)" in the heading; **cash and UPI are
 *   always separate columns** (B-014 / RULE-14), also in the payment register.
 * - Days `YYYY-MM-DD`, months `YYYY-MM`, times IST `YYYY-MM-DD HH:mm` (sortable in a spreadsheet).
 * - Machine codes never appear alone: every code is a word.
 * - Text typed by people (names, notes) is neutralised against formulas by `csvLine`.
 */
import {
  type CsvCell,
  countCell,
  type ExportKind,
  type ExportRowTypes,
  istDateTime,
  rupeesCell,
} from "@cb/core";
import { whyText } from "@/app/(operator)/reports/billing-runs/_components/run-view";
import type { Translate } from "@/components/reports/format";

/** A translator over all namespaces (`t("payments.method.cash")`). */
export type Words = Translate;

export interface ExportColumn<Row> {
  /** The heading, already in the reader's language. */
  readonly header: (t: Words) => string;
  readonly cell: (row: Row, t: Words) => CsvCell;
}

type Columns = { readonly [K in ExportKind]: readonly ExportColumn<ExportRowTypes[K]>[] };

const col = <Row>(
  key: string,
  cell: (row: Row, t: Words) => CsvCell,
  values?: Record<string, string | number>,
): ExportColumn<Row> => ({ header: (t) => t(`exports.columns.${key}`, values), cell });

const month = (period: string | null | undefined) => (period ? period.slice(0, 7) : null);
const time = (at: Date | null | undefined) => (at ? istDateTime(at) : null);
const due = (balance: number) => rupeesCell(Math.max(balance, 0));
const advance = (balance: number) => rupeesCell(Math.max(-balance, 0));

/** A translator for one namespace, from the all-namespaces one. */
const within =
  (t: Words, namespace: string): Words =>
  (key, values) =>
    t(`${namespace}.${key}`, values);

const BUCKET_KEYS = ["d0_30", "d31_60", "d61_90", "d90_plus"] as const;

export const EXPORT_COLUMNS: Columns = {
  customers: [
    col("code", (r) => r.customerCode),
    col("name", (r) => r.name),
    col("phone", (r) => r.phone),
    col("area", (r) => r.areaName),
    col("customer_status", (r, t) => t(`customers.status.${r.status}`)),
    col("due", (r) => due(r.balancePaise)),
    col("advance", (r) => advance(r.balancePaise)),
  ],
  bills: [
    col("bill_number", (r) => r.invoiceNumber),
    col("month", (r) => month(r.period)),
    col("code", (r) => r.customer.code),
    col("name", (r) => r.customer.name),
    col("area", (r) => r.customer.areaName),
    col("bill_kind", (r, t) => t(`exports.values.${r.kind}`)),
    col("bill_amount", (r) => rupeesCell(r.chargesPaise)),
    col("paid", (r) => rupeesCell(r.paidPaise)),
    col("still_due", (r) => rupeesCell(r.outstandingPaise)),
    col("pay_state", (r, t) => t(`bills.pay_state.${r.payState}`)),
  ],
  payments: [
    col("receipt", (r) => r.receiptNumber ?? r.provisionalRef),
    col("day", (r) => r.businessDate),
    col("taken_at", (r) => time(r.recordedAt)),
    col("reached_at", (r) => time(r.postedAt)),
    col("code", (r) => r.customerCode),
    col("name", (r) => r.customerName),
    col("cash", (r) => (r.method === "cash" ? rupeesCell(r.amountPaise) : null)),
    col("upi", (r) => (r.method === "upi" ? rupeesCell(r.amountPaise) : null)),
    col("taken_by", (r, t) => r.collectorName ?? t("reports.collections.old_app")),
    col("where", (r, t) => t(`payments.source.${r.source}`)),
    col("status", (r, t) => t(`payments.status.${r.cancelled ? "cancelled" : "counted"}`)),
    col("check", (r, t) =>
      r.reviewStatus === "needs_review"
        ? t("exports.values.to_check")
        : r.reviewStatus === "resolved"
          ? t("exports.values.checked")
          : null,
    ),
    col("check_reason", (r, t) =>
      r.reviewReason ? t(`payments.review_reason.${r.reviewReason}`) : null,
    ),
  ],
  dues: [
    col("code", (r) => r.customerCode),
    col("name", (r) => r.customerName),
    col("phone", (r) => r.phone),
    col("area", (r) => r.areaName),
    col("due", (r) => rupeesCell(r.duePaise)),
    col("advance", (r) => rupeesCell(r.advancePaise)),
    ...BUCKET_KEYS.map(
      (bucket): ExportColumn<ExportRowTypes["dues"]> => ({
        header: (t) => t("exports.columns.bucket", { age: t(`reports.dues.bucket.${bucket}`) }),
        cell: (r) => rupeesCell(r.buckets[bucket]),
      }),
    ),
    col("unpaid_since", (r) => month(r.oldestDuePeriod)),
    col("customer_status", (r, t) => t(`customers.status.${r.customerStatus}`)),
  ],
  collections: [
    col("day", (r) => r.businessDate),
    col("who", (r, t) => r.name ?? t("reports.collections.old_app")),
    col("role", (r, t) => (r.role ? t(`reports.collections.role.${r.role}`) : null)),
    col("cash", (r) => rupeesCell(r.cashPaise)),
    col("upi", (r) => rupeesCell(r.upiPaise)),
    col("payments", (r) => countCell(r.count)),
    col("cancelled", (r) => countCell(r.cancelledCount)),
    col("cancelled_amount", (r) => rupeesCell(r.cancelledPaise)),
  ],
  handover: [
    col("day", (r) => r.businessDate),
    col("lineman", (r) => r.linemanName),
    col("status", (r, t) => t(`linemen.status.${r.status}`)),
    col("cash_expected", (r) => rupeesCell(r.cashExpectedPaise)),
    col("upi_apart", (r) => rupeesCell(r.upiTotalPaise)),
    col("payments", (r) => countCell(r.paymentCount)),
    col("expected_then", (r) => rupeesCell(r.handover?.cashExpectedPaise)),
    col("handed", (r) => rupeesCell(r.handover?.cashHandedOverPaise)),
    col("difference", (r) => rupeesCell(r.handover?.discrepancyPaise)),
    col("reason", (r, t) =>
      r.handover?.discrepancyReason ? t(`linemen.reason.${r.handover.discrepancyReason}`) : null,
    ),
    col("lineman_note", (r) => r.handover?.note),
    col("handed_at", (r) => time(r.handover?.submittedAt)),
    col("checked_at", (r) => time(r.handover?.reviewedAt)),
    col("checked_by", (r) => r.handover?.reviewedByName),
    col("office_note", (r) => r.handover?.reviewNote),
  ],
  connections: [
    col("code", (r) => r.customerCode),
    col("name", (r) => r.customerName),
    col("area", (r) => r.areaName),
    col("vc", (r) => r.vcNumber),
    col("status", (r, t) => t(`connections.status.${r.status}`)),
    col("since", (r) => r.since),
    col("start", (r) => r.startDate),
    col("end", (r) => r.endDate),
    col("plan", (r, t) => r.planName ?? t("exports.values.own_amount")),
    col("rent", (r) => rupeesCell(r.rentPaise)),
  ],
  billing_runs: [
    col("code", (r) => r.customerCode),
    col("name", (r) => r.customerName),
    col("area", (r) => r.areaName),
    col("result", (r, t) => t(`reports.billing_runs.outcome.${r.outcome}`)),
    col("why", (r, t) => whyText(r, within(t, "reports"), within(t, "bills"))),
    col("bill_number", (r) => r.invoiceNumber),
    col("bill_amount", (r) => rupeesCell(r.chargesPaise)),
    col("tries", (r) => countCell(r.attempts)),
    col("last_tried", (r) => time(r.lastTriedAt)),
  ],
};

/** The heading row of `kind`. */
export function headerCells(kind: ExportKind, t: Words): string[] {
  return EXPORT_COLUMNS[kind].map((column) => column.header(t));
}

/** One row of `kind` as cells. */
export function rowCells<K extends ExportKind>(
  kind: K,
  row: ExportRowTypes[K],
  t: Words,
): CsvCell[] {
  const columns = EXPORT_COLUMNS[kind] as readonly ExportColumn<ExportRowTypes[K]>[];
  return columns.map((column) => column.cell(row, t));
}
