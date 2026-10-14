/**
 * What can be exported (T-082, FR-029: "customer, invoice and payment data"; PLAN §12.1 "CSV export
 * (Owner)" of every report) and with which filters. Each kind's filters are **the input of the
 * service that shows the same list on screen**, so an export always has exactly the rows of the
 * page with the same filters; paging is left out (an export walks every page).
 */
import { z } from "zod";
import type { BillRow } from "../billing/view-types";
import { SearchCustomersInput } from "../customers/queries";
import type { CustomerListRow } from "../customers/types";
import { ListPaymentsInput } from "../payment-register/queries";
import type { PaymentRegisterRow } from "../payment-register/types";
import { DuesReportInput } from "../reports/dues/queries";
import type { DuesRow } from "../reports/dues/types";
import { BillingRunReportInput } from "../reports/operations/billing-runs";
import { CollectionsReportInput } from "../reports/operations/collections";
import { ConnectionsReportInput } from "../reports/operations/connections";
import { HandoverReportInput } from "../reports/operations/handover";
import type {
  BillingRunReportRow,
  CollectionDayRow,
  ConnectionReportRow,
  HandoverReportRow,
} from "../reports/operations/types";
import { BillRegisterReportInput } from "../reports/registers/bills";

export const EXPORT_KINDS = [
  "customers",
  "bills",
  "payments",
  "dues",
  "collections",
  "handover",
  "connections",
  "billing_runs",
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];

export function isExportKind(value: unknown): value is ExportKind {
  return typeof value === "string" && (EXPORT_KINDS as readonly string[]).includes(value);
}

/** The customer list: search text, area, active / closed (no paging). */
const CustomersExportFilters = SearchCustomersInput.pick({ q: true, areaId: true, status: true });

/** `{ kind, filters }`: the filters are the on-screen service's own input (paging is ignored). */
export const ExportInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("customers"), filters: CustomersExportFilters }),
  z.object({ kind: z.literal("bills"), filters: BillRegisterReportInput }),
  z.object({ kind: z.literal("payments"), filters: ListPaymentsInput }),
  z.object({ kind: z.literal("dues"), filters: DuesReportInput }),
  z.object({ kind: z.literal("collections"), filters: CollectionsReportInput }),
  z.object({ kind: z.literal("handover"), filters: HandoverReportInput }),
  z.object({ kind: z.literal("connections"), filters: ConnectionsReportInput }),
  z.object({ kind: z.literal("billing_runs"), filters: BillingRunReportInput }),
]);
export type ExportInput = z.input<typeof ExportInput>;
export type ExportCommand = z.output<typeof ExportInput>;

/** The filters of one kind, as parsed. */
export type ExportFilters<K extends ExportKind> = Extract<ExportCommand, { kind: K }>["filters"];

/** One row of each kind: the on-screen service's own row type. */
export interface ExportRowTypes {
  readonly customers: CustomerListRow;
  readonly bills: BillRow;
  readonly payments: PaymentRegisterRow;
  readonly dues: DuesRow;
  readonly collections: CollectionDayRow;
  readonly handover: HandoverReportRow;
  readonly connections: ConnectionReportRow;
  readonly billing_runs: BillingRunReportRow;
}

/** Paging keys of the services' inputs: never part of what an export is "of". */
export const PAGING_KEYS = ["page", "pageSize", "limit", "offset"] as const;
