/**
 * What the Home page's read returns (T-083, PLAN §12.1 "Home", BRD §12 "Operator dashboard").
 * Amounts are integer paise, instants UTC `Date`s, business dates and periods IST.
 */
import type { SubscriptionStatus } from "@cb/db";
import type { BusinessDate, Paise, Period } from "@cb/domain";
import type { TenantMode } from "../authz/writable";
import type { BillingRunView } from "../billing/types";

/** Cash and UPI of payments that count (not undone), kept apart (PLAN §2.2 rule 4). */
export interface CollectedMoney {
  readonly cashPaise: Paise;
  readonly upiPaise: Paise;
  /** Number of payments (cash + UPI). */
  readonly paymentCount: number;
}

/** The setup checklist's steps (PLAN §12.3 step 3), each `true` once the data exists. */
export const SETUP_STEP_KEYS = ["plans", "customers", "linemen", "app"] as const;
export type SetupStepKey = (typeof SETUP_STEP_KEYS)[number];

export interface SubscriptionSummary {
  /** `null`: no subscription row (read-only, failing closed like `tenantModeOf`). */
  readonly status: SubscriptionStatus | null;
  readonly mode: TenantMode;
  /** The IST day the free trial ends (only while `trialing`). */
  readonly trialEndsOn: BusinessDate | null;
  /** Whole IST days from today to `trialEndsOn` (0 = ends today); `null` when not trialing. */
  readonly trialDaysLeft: number | null;
  /** The IST day the grace period ends (only while `grace`). */
  readonly graceEndsOn: BusinessDate | null;
}

export interface HomeDashboard {
  /** The IST day "today" means (from the service call's clock). */
  readonly today: BusinessDate;
  /** The IST month of `today` (its first day). */
  readonly period: Period;
  /** Payments taken today (by IST business date), like the payment register for "Today". */
  readonly collectedToday: CollectedMoney;
  /** Payments taken from the 1st of this month to today, like the register for "This month". */
  readonly collectedThisMonth: CollectedMoney;
  /** This month's bills (regular, not cancelled), like the Bills calendar's month card. */
  readonly billedThisMonth: { readonly billCount: number; readonly totalPaise: Paise };
  /**
   * Money customers owe now: Σ of every positive customer balance in the ledger (customers with
   * an advance count 0, not minus), like the dues report's total due.
   */
  readonly due: { readonly duePaise: Paise; readonly customerCount: number };
  /** The newest month's bill run (any status), or `null` before the first one. */
  readonly latestRun: BillingRunView | null;
  /** Months whose run was skipped while view-only (D-25), oldest first. */
  readonly missedRuns: { readonly count: number; readonly oldestPeriod: Period | null };
  /** Cash handovers the office has not accepted or sent back yet (`submitted`), any day. */
  readonly handoversWaiting: { readonly count: number; readonly oldestDate: BusinessDate | null };
  /** Payments flagged for the office to check (`needs_review`), like "Payments to check". */
  readonly paymentsToCheck: number;
  readonly subscription: SubscriptionSummary;
  /** The setup checklist's done flags, from the tenant's data. */
  readonly setup: Readonly<Record<SetupStepKey, boolean>>;
}
