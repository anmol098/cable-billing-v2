/**
 * Public result shapes of the billing run services (T-044). Money is integer paise, instants are
 * UTC `Date`s, periods are `YYYY-MM-01` strings (IST months). Ids only: no names or phones.
 */
import type {
  BillingRunItemOutcome,
  BillingRunSkipReason,
  BillingRunStatus,
  BillingRunTrigger,
} from "@cb/db";
import type { Paise, Period } from "@cb/domain";
import type { TenantMode } from "../authz/writable";

/** Customers handled per job slice (PLAN §8.2 "batches of 200"); one transaction per customer. */
export const BILLING_BATCH_SIZE = 200;

/** A `billing_runs` row. */
export interface BillingRunView {
  readonly id: string;
  readonly period: Period;
  readonly trigger: BillingRunTrigger;
  readonly status: BillingRunStatus;
  readonly skipReason: BillingRunSkipReason | null;
  readonly customerCount: number;
  readonly createdCount: number;
  readonly alreadyExistsCount: number;
  readonly skippedCount: number;
  readonly failedCount: number;
  /** Σ charges of the invoices this run created. */
  readonly totalChargesPaise: Paise;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /** Who last started it by hand (manual runs). */
  readonly actorId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** What one customer's billing gave (also the `billing_run_items` row written for it). */
export interface BillingItemResult {
  readonly customerId: string;
  readonly outcome: BillingRunItemOutcome;
  /** The customer's regular invoice for the period (created now, or the one that existed). */
  readonly invoiceId: string | null;
  /** `nothing_to_bill`, a T-040 `details.reason`, `balance_mismatch`, `internal_error` … */
  readonly reason: string | null;
  /** Ids and amounts only. */
  readonly details: Readonly<Record<string, unknown>>;
}

/** A customer the preview (or the run) can't bill, and why (J-03 exception queue). */
export interface BillingProblem {
  readonly customerId: string;
  readonly reason: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * `billing.preview` (PLAN §8.2 "Preview = the same function, executed read-only"): "128 customers
 * will get a bill, total ₹57,600. 3 problems."
 */
export interface BillingPreview {
  readonly period: Period;
  /** Billing is paused while the tenant is read-only (D-13): a run would be recorded as skipped. */
  readonly tenantMode: TenantMode;
  /** The period's run, if one was ever recorded (completed, skipped …). */
  readonly run: BillingRunView | null;
  /** Customers with something that could be billed for the period (the run's candidates). */
  readonly customerCount: number;
  /** Customers who would get a new bill now. */
  readonly willBillCount: number;
  /** Σ charges of those new bills. */
  readonly totalChargesPaise: Paise;
  /** Customers who already have their bill for the period (RULE-05). */
  readonly alreadyBilledCount: number;
  /** Customers with nothing to bill (e.g. every connection suspended before the 1st). */
  readonly nothingToBillCount: number;
  /** Customers the run would mark as failed, with the reason. */
  readonly problems: readonly BillingProblem[];
}

export type StartBillingRunOutcome =
  /** A job was queued (a new run, or a finished / skipped run started again). */
  | "started"
  /** The period's run is already pending or running; nothing new was started. */
  | "already_running";

export interface StartBillingRunResult {
  readonly outcome: StartBillingRunOutcome;
  readonly run: BillingRunView;
}

export type RetryFailedItemsOutcome = "started" | "already_running" | "nothing_to_retry";

export interface RetryFailedItemsResult {
  readonly outcome: RetryFailedItemsOutcome;
  readonly run: BillingRunView;
  /** Failed items that will be retried. */
  readonly failedCount: number;
}

/** A period whose run was skipped (read-only tenant, D-13): the Owner may run it by hand (D-25). */
export interface MissedRun {
  readonly runId: string;
  readonly period: Period;
  readonly skipReason: BillingRunSkipReason | null;
  /** When the skip was recorded. */
  readonly skippedAt: Date | null;
}
