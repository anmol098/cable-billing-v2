/**
 * Result types of the adjustment services (T-045). Money is integer paise (`Paise`), months are
 * `Period`s (the 1st of the month, IST).
 */
import type {
  AdjustmentDirection,
  AdjustmentOutcome,
  AdjustmentSource,
  BusinessDate,
  MidMonthStartPolicy,
  Paise,
  Period,
} from "@cb/domain";
import type { ConnectionView } from "../connections/types";

/** One stored adjustment. */
export interface AdjustmentView {
  readonly id: string;
  readonly customerId: string;
  readonly assignmentId: string | null;
  readonly period: Period | null;
  readonly direction: AdjustmentDirection;
  readonly amountPaise: Paise;
  readonly source: AdjustmentSource;
  readonly reason: string | null;
  /** The bill that charged this debit; null while pending (and always for credits). */
  readonly invoiceId: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

/** What one month gets from a connection change (preview and result). */
export interface MonthEffectView {
  readonly period: Period;
  /** `change_month`: the change's own month; `later_month`: a billed month after it. */
  readonly scope: "change_month" | "later_month";
  readonly outcome: AdjustmentOutcome;
  /** The connection's rent for the month before and after the change. */
  readonly chargedBeforePaise: Paise;
  readonly chargedAfterPaise: Paise;
}

/** The kinds of change the preview and the Owner's back-dated flow take. */
export type ConnectionChangeKind = "plan" | "suspend" | "reactivate" | "disconnect";

export interface ConnectionChangePreview {
  readonly assignmentId: string;
  readonly customerId: string;
  readonly kind: ConnectionChangeKind;
  readonly effectiveDate: BusinessDate;
  /** The connection's rent before and after (the same unless it is a plan change). */
  readonly fromRentalPaise: Paise;
  readonly toRentalPaise: Paise;
  /** Nothing would change (the same plan and amount again). */
  readonly noChange: boolean;
  /**
   * The date reaches back into a month that is already billed for the customer (PLAN §8.3):
   * only the Owner may do it, through the back-dated flow, with a reason.
   */
  readonly backDated: boolean;
  /** The customer's latest billed month (null: never billed). */
  readonly latestBilledPeriod: Period | null;
  readonly policy: MidMonthStartPolicy;
  /** Every month that changes or is looked at, oldest first. */
  readonly months: readonly MonthEffectView[];
  /** Σ of the adjustments: + more to pay, − less to pay. */
  readonly totalPaise: Paise;
}

export interface ManualAdjustmentResult {
  /** `created`, or `duplicate` when the same request (same id and data) was saved before. */
  readonly outcome: "created" | "duplicate";
  readonly adjustment: AdjustmentView;
  /** Of a credit, how much paid open bills at once. */
  readonly creditAppliedPaise: Paise;
}

export interface BackDatedChangeResult {
  readonly connection: ConnectionView;
  /** Whether the connection changed (a plan change to the same plan and amount does not). */
  readonly changed: boolean;
  readonly eventId: string | null;
  /** The adjustments made, oldest month first. */
  readonly adjustments: readonly AdjustmentView[];
  readonly months: readonly MonthEffectView[];
  readonly totalPaise: Paise;
}

/** `adjustments.list` row. */
export interface AdjustmentListRow {
  readonly id: string;
  readonly createdAt: Date;
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly vcNumber: string | null;
  readonly period: Period | null;
  readonly direction: AdjustmentDirection;
  readonly amountPaise: Paise;
  readonly source: AdjustmentSource;
  readonly reason: string | null;
  /**
   * `pending`: a debit waiting for the next bill; `billed`: a debit on a bill (`invoiceNumber`);
   * `credit`: a credit (`creditUsedPaise` of it already paid bills).
   */
  readonly state: "pending" | "billed" | "credit";
  readonly invoiceId: string | null;
  readonly invoiceNumber: string | null;
  readonly creditUsedPaise: Paise;
  readonly createdByName: string | null;
}

export interface AdjustmentListView {
  readonly rows: readonly AdjustmentListRow[];
  readonly page: number;
  readonly hasMore: boolean;
  /** Σ pending debits (what the next bills will add) and Σ credits on this tenant. */
  readonly pendingDebitPaise: Paise;
}

/** `connections.charged_months`: for the Connections tab's "Start again" effect. */
export interface ConnectionChargedMonths {
  readonly policy: MidMonthStartPolicy;
  /** Per connection, the recent months that already have rent (> ₹0) for it. */
  readonly charged: Readonly<Record<string, readonly Period[]>>;
}
