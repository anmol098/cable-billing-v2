/**
 * Dues and ageing report (T-080): `duesReport` (`reports.dues`), the ageing rule and the as-of
 * moment shared by the money reports.
 */
export {
  AGEING_BUCKET_LIMITS,
  AGEING_BUCKETS,
  type AgeingBucket,
  ageingBucket,
  ageingBucketOfDays,
  type BucketAmounts,
  billAgeInDays,
  spreadDue,
  type UnpaidBill,
} from "./ageing";
export { type ReportAsOf, type ResolvedAsOf, resolveAsOf } from "./as-of";
export { DUES_PAGE_SIZE, type DuesReportCommand, DuesReportInput, duesReport } from "./queries";
export {
  DUES_LIST_KINDS,
  type DuesAreaTotals,
  type DuesListKind,
  type DuesReport,
  type DuesRow,
  type DuesTotals,
} from "./types";
