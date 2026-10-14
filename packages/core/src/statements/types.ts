/**
 * Result shapes of the customer statement services (T-049; BRD §12 "Customer account statement",
 * FR-011, B-009, PLAN §12.1 Customers → Bills / History). Money is integer paise (signed where it
 * says so: + = the customer owes), instants are UTC `Date`s, business dates are IST `YYYY-MM-DD`.
 *
 * These views carry customer names and contact details for the screen and the printed statement.
 * They are never logged.
 */
import type {
  InvoiceKind,
  InvoiceStatus,
  Language,
  LEDGER_ENTRY_TYPES,
  PaymentMethod,
  PaymentSource,
} from "@cb/db";
import type {
  AdjustmentDirection,
  AdjustmentSource,
  BusinessDate,
  Paise,
  Period,
} from "@cb/domain";

/** One `ledger_entries.type`. */
export type StatementLineType = (typeof LEDGER_ENTRY_TYPES)[number];

/** The customer the statement is for. */
export interface StatementCustomer {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly areaName: string | null;
  readonly phone: string | null;
  readonly address: string | null;
  readonly status: "active" | "inactive";
}

/** The operator, for the printed statement's header and footer. */
export interface StatementOperator {
  readonly name: string;
  /** `office_phone`, else the operator's phone. */
  readonly phone: string | null;
  readonly address: string | null;
  /** The printed statement's language (`settings.default_language`, like the printed bill). */
  readonly language: Language;
}

/** The bill a line posts (`invoice` / `opening_balance` lines). */
export interface StatementBillRef {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly period: Period;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
}

/** The payment a line posts or undoes (`payment` / `payment_reversal` lines). */
export interface StatementPaymentRef {
  readonly id: string;
  readonly method: PaymentMethod;
  readonly source: PaymentSource;
  readonly amountPaise: Paise;
  /** `R-…`; null only for a payment that has no receipt row (never for a posted payment). */
  readonly receiptNumber: string | null;
  /** The IST day the money was taken (can be before the line's date for an offline payment). */
  readonly businessDate: BusinessDate;
  /** Who took it (the lineman, or the office user at the counter). */
  readonly collectorName: string | null;
  /** The Owner undid this payment later (PLAN §8.6). */
  readonly reversed: boolean;
}

/** The Owner's undo of a payment (`payment_reversal` lines). */
export interface StatementReversalRef {
  readonly id: string;
  /** The Owner's own words. */
  readonly reason: string;
  readonly at: Date;
}

/** The bill change a line posts (`debit_adjustment` / `credit_adjustment` lines). */
export interface StatementAdjustmentRef {
  readonly id: string;
  readonly direction: AdjustmentDirection;
  readonly source: AdjustmentSource;
  /** The month it corrects (plan change / mid-month start). */
  readonly period: Period | null;
  /** The Owner's reason (manual changes). */
  readonly reason: string | null;
}

/** One ledger entry of the statement, with the balance right after it. */
export interface StatementLine {
  readonly id: string;
  /** Posting order (`ledger_entries.seq`). Lines are in this order. */
  readonly seq: number;
  readonly type: StatementLineType;
  /** When it was posted (`ledger_entries.at`). */
  readonly at: Date;
  /** The IST date of `at`: the statement's date column and its date filter. */
  readonly date: BusinessDate;
  /** Signed: + = the customer owes more (bill, payment undone), − = less (payment, discount). */
  readonly amountPaise: Paise;
  /** The account balance right after this line (signed; < 0 = credit). */
  readonly balanceAfterPaise: Paise;
  readonly bill: StatementBillRef | null;
  readonly payment: StatementPaymentRef | null;
  readonly reversal: StatementReversalRef | null;
  readonly adjustment: StatementAdjustmentRef | null;
}

/** The statement's date range (IST business dates, both ends included). */
export interface StatementRange {
  /** null: from the first line ever. */
  readonly from: BusinessDate | null;
  /** The last day; never after `today`. */
  readonly to: BusinessDate;
  /** The IST date of the request. */
  readonly today: BusinessDate;
  /** `to` is today: the closing balance is the balance now. */
  readonly asOfNow: boolean;
}

/** Σ of the range's lines by kind (positive amounts). */
export interface StatementTotals {
  /** Bills (incl. old dues brought in) and extra charges. */
  readonly billedPaise: Paise;
  /** Payments. */
  readonly paidPaise: Paise;
  /** Payments the Owner undid. */
  readonly undonePaise: Paise;
  /** Discounts / money given back as credit (credit bill changes). */
  readonly discountPaise: Paise;
}

/** `statements.customer`: what was charged, paid, adjusted and remains due (BRD §12). */
export interface CustomerStatementView {
  readonly customer: StatementCustomer;
  readonly operator: StatementOperator;
  readonly range: StatementRange;
  /** The balance at the start of `range.from` (0 when `from` is null). Signed. */
  readonly openingBalancePaise: Paise;
  /** The range's lines in posting order (at most `STATEMENT_MAX_LINES`, the newest). */
  readonly lines: readonly StatementLine[];
  /**
   * Older lines of the range left out because of `STATEMENT_MAX_LINES`; their sum is already in
   * `openingBalancePaise`, so the running balances stay exact.
   */
  readonly hiddenLines: number;
  readonly totals: StatementTotals;
  /** opening + Σ lines: the balance at the end of `range.to`. Signed. */
  readonly closingBalancePaise: Paise;
  /** The account now (`customer_balances`, read in the same snapshot). */
  readonly now: {
    readonly balancePaise: Paise;
    /** Unused credit (payment remainders and discounts not yet put on a bill). */
    readonly creditPaise: Paise;
    readonly oldestDuePeriod: Period | null;
    /** Σ every ledger entry: equals `balancePaise` when the books are right. */
    readonly ledgerPaise: Paise;
  };
  /** When the statement was read (the service clock). */
  readonly generatedAt: Date;
}

/** One bill of the customer's Bills tab. */
export interface CustomerBillRow {
  readonly id: string;
  readonly invoiceNumber: string;
  readonly period: Period;
  readonly kind: InvoiceKind;
  readonly status: InvoiceStatus;
  readonly issuedAt: Date;
  /** This month's charges (old dues for an opening-balance bill). */
  readonly chargesPaise: Paise;
  /** Σ payments and credit put on this bill (net of undone payments). */
  readonly paidPaise: Paise;
  /** charges − paid. */
  readonly outstandingPaise: Paise;
  readonly payState: "unpaid" | "part_paid" | "paid" | "no_charge" | "void";
}

/** `statements.customer_bills`: every bill of one customer, newest month first. */
export interface CustomerBillsView {
  readonly customerId: string;
  readonly rows: readonly CustomerBillRow[];
  /** Totals over every bill that is not cancelled. */
  readonly totals: {
    readonly count: number;
    readonly chargesPaise: Paise;
    readonly paidPaise: Paise;
    readonly outstandingPaise: Paise;
  };
  /** Debit bill changes not on a bill yet (they go on the next bill). */
  readonly pendingChargesPaise: Paise;
  /** The account now (`customer_balances`). */
  readonly balancePaise: Paise;
  readonly creditPaise: Paise;
}
