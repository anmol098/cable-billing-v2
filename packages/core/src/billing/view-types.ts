/**
 * Result shapes of the Bills read services (T-047; PLAN §12.1 "Bills"; FR-009, FR-011). Money is
 * integer paise, instants are UTC `Date`s, periods are `YYYY-MM-01` strings (IST months).
 *
 * Unlike the run services (ids only), these views carry customer names, codes and contact
 * details: they are what the office reads on screen and prints. They are never logged.
 */
import type { InvoiceKind, InvoiceStatus, Language, PaymentMethod } from "@cb/db";
import type { AdjustmentDirection, AdjustmentSource, Paise, Period } from "@cb/domain";
import type { TenantMode } from "../authz/writable";
import type { BillingRunView } from "./types";

/** One month of the Bills calendar. */
export interface BillingMonth {
  readonly period: Period;
  /** The month's run, if one was ever recorded (any status, incl. skipped). */
  readonly run: BillingRunView | null;
  /** Regular, not cancelled bills of the month (whoever made them: run, migration). */
  readonly billCount: number;
  /** Σ charges of those bills. */
  readonly billTotalPaise: Paise;
}

/** `billing.months`: the Bills calendar. */
export interface BillingMonthsView {
  /** The current IST month (nothing later can be previewed or run). */
  readonly currentPeriod: Period;
  /** The tenant's first month (the IST month it was created in). */
  readonly firstPeriod: Period;
  /** Billing is paused while the tenant is read-only (D-13). */
  readonly tenantMode: TenantMode;
  /** Every month from `from` to `to`, oldest first. */
  readonly months: readonly BillingMonth[];
}

/** A customer, as the office names them. */
export interface BillCustomerLabel {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly areaName: string | null;
}

/** One customer the run could not bill (a `failed` item). */
export interface BillingRunProblemView {
  readonly customer: BillCustomerLabel;
  /** `balance_mismatch`, `credit_mismatch`, `internal_error`, a T-040 reason … */
  readonly reason: string;
  /** Ids and amounts only. */
  readonly details: Readonly<Record<string, unknown>>;
  readonly attempts: number;
  readonly lastTriedAt: Date;
}

/** `billing.run_problems`: the run and its failed items (J-03 exception queue). */
export interface BillingRunProblemsView {
  readonly run: BillingRunView;
  /** Up to `RUN_PROBLEMS_LIMIT`, by customer code. */
  readonly problems: readonly BillingRunProblemView[];
  /** All failed items of the run (may be more than `problems.length`). */
  readonly failedCount: number;
}

/**
 * How much of a bill is paid (charges − Σ its allocations): `void` = cancelled bill,
 * `no_charge` = a ₹0 bill, `paid`, `part_paid`, `unpaid`.
 */
export const BILL_PAY_STATES = ["unpaid", "part_paid", "paid", "no_charge", "void"] as const;
export type BillPayState = (typeof BILL_PAY_STATES)[number];

/** One row of the bill register. */
export interface BillRow {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly period: Period;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly customer: BillCustomerLabel;
  /** This month's charges (old dues for an opening-balance bill). */
  readonly chargesPaise: Paise;
  /** Σ payments and credit applied to this bill (net of undone payments). */
  readonly paidPaise: Paise;
  /** charges − paid. */
  readonly outstandingPaise: Paise;
  readonly payState: BillPayState;
}

export interface BillArea {
  readonly id: string;
  readonly name: string;
}

/** `billing.list_bills`: the bill register for a month. */
export interface BillRegisterView {
  readonly period: Period;
  /** Every area of the tenant, by name (the filter's options). */
  readonly areas: readonly BillArea[];
  readonly rows: readonly BillRow[];
  readonly page: number;
  readonly pageSize: number;
  /** Totals over every row matching the filters (not only this page). */
  readonly totals: {
    readonly count: number;
    readonly chargesPaise: Paise;
    readonly paidPaise: Paise;
    readonly outstandingPaise: Paise;
  };
}

/** A bill change (debit adjustment) billed on a line, or a credit applied to the bill. */
export interface BillAdjustmentView {
  readonly id: string;
  readonly source: AdjustmentSource;
  readonly direction: AdjustmentDirection;
  /** The month it corrects (plan change / mid-month start). */
  readonly period: Period | null;
  /** The Owner's reason (manual changes). */
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface BillLineView {
  readonly id: string;
  readonly type: "rent" | "adjustment";
  readonly amountPaise: Paise;
  /** Set for adjustment lines. */
  readonly adjustment: BillAdjustmentView | null;
  /** Legacy free text (migrated lines); the UI words lines from their type. */
  readonly description: string | null;
}

/** The lines of one connection (VC) on the bill. */
export interface BillConnectionView {
  readonly assignmentId: string;
  readonly vcNumber: string;
  readonly lines: readonly BillLineView[];
  /** Σ its lines. */
  readonly totalPaise: Paise;
}

/** One payment or credit that paid (part of) this bill. */
export interface BillPaymentView {
  readonly sourceType: "payment" | "credit_adjustment";
  readonly sourceId: string;
  /** What it paid on this bill (Σ positive allocation rows). */
  readonly amountPaise: Paise;
  /** The part undone later (Σ reversal rows, as a positive amount); 0 when none. */
  readonly undonePaise: Paise;
  /** When it was put on this bill (first allocation row). */
  readonly appliedAt: Date;
  readonly payment: {
    readonly receiptNumber: string | null;
    readonly method: PaymentMethod;
    readonly amountPaise: Paise;
    readonly recordedAt: Date;
    /** The Owner undid the payment (PLAN §8.6). */
    readonly reversed: boolean;
  } | null;
  readonly creditAdjustment: BillAdjustmentView | null;
}

/** `billing.get_bill`: one bill with everything the detail page and the printed bill show. */
export interface BillDetailView {
  readonly bill: {
    readonly id: string;
    readonly invoiceNumber: string;
    readonly period: Period;
    readonly kind: InvoiceKind;
    readonly status: InvoiceStatus;
    readonly issuedAt: Date;
    /** The customer's balance before this bill (negative = credit). */
    readonly openingBalancePaise: Paise;
    readonly chargesPaise: Paise;
    /** opening + charges: what the bill asked for when it was made. */
    readonly totalDuePaise: Paise;
    readonly paidPaise: Paise;
    readonly outstandingPaise: Paise;
    readonly payState: BillPayState;
    readonly voidedAt: Date | null;
    readonly voidReason: string | null;
  };
  readonly customer: BillCustomerLabel & {
    readonly phone: string | null;
    readonly address: string | null;
  };
  /** The operator, for the printed bill's header and footer. */
  readonly operator: {
    readonly name: string;
    /** `office_phone`, else the operator's phone. */
    readonly phone: string | null;
    readonly address: string | null;
    /** The printed bill's language (`settings.default_language`). */
    readonly language: Language;
    readonly footer: string | null;
  };
  /** Lines grouped per connection, in line order. */
  readonly connections: readonly BillConnectionView[];
  /** Lines that name no connection (e.g. a manual bill change for the customer). */
  readonly otherLines: readonly BillLineView[];
  /** Payments and credit applied to this bill, oldest first. */
  readonly payments: readonly BillPaymentView[];
  /** The customer's account now (`customer_balances`). */
  readonly balance: { readonly balancePaise: Paise; readonly creditPaise: Paise };
}
