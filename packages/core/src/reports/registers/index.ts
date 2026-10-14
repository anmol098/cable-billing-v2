/**
 * Register reports (T-080): the bill register over a range of months (`billRegisterReport`).
 * The payment register report reuses T-048's `listPayments` (see the T-080 completion notes).
 */
export {
  BILL_REPORT_MAX_MONTHS,
  BILL_REPORT_PAGE_SIZE,
  type BillRegisterReportCommand,
  BillRegisterReportInput,
  billRegisterReport,
} from "./bills";
export type { BillRegisterReport } from "./types";
