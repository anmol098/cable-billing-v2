/**
 * Operations reports (T-081, BRD §12): daily collections (cash and UPI apart), cash handover
 * reconciliation, connection status and rent, and the monthly bill run. Read only, one REPEATABLE
 * READ snapshot each, capability `reports.view` (Owner, Staff).
 */
export {
  BILLING_RUN_REPORT_PAGE_SIZE,
  type BillingRunReportCommand,
  BillingRunReportInput,
  billingRunReport,
} from "./billing-runs";
export {
  COLLECTIONS_PAGE_SIZE,
  type CollectionsReportCommand,
  CollectionsReportInput,
  collectionsReport,
} from "./collections";
export {
  CONNECTIONS_PAGE_SIZE,
  type ConnectionsReportCommand,
  ConnectionsReportInput,
  connectionsReport,
  OWN_AMOUNT,
} from "./connections";
export {
  HANDOVER_DEFAULT_DAYS,
  HANDOVER_DIFFERENCES,
  HANDOVER_PAGE_SIZE,
  type HandoverDifferenceFilter,
  type HandoverReportCommand,
  HandoverReportInput,
  handoverReport,
} from "./handover";
export { daysInRange, REPORT_MAX_DAYS, resolveDayRange } from "./range";
export type {
  BillingRunReport,
  BillingRunReportRow,
  BillingRunReportRun,
  CollectionAmounts,
  CollectionDayRow,
  CollectionPerson,
  CollectionPersonRow,
  CollectionsReport,
  ConnectionReportRow,
  ConnectionsReport,
  HandoverReport,
  HandoverReportHandover,
  HandoverReportRow,
  ReportPerson,
} from "./types";
