/**
 * What the office payment read services return (T-048): the payment register, one payment's
 * details, and the result of marking a flagged payment as checked. Amounts are integer paise;
 * instants are UTC `Date`s (shown in IST by the web), business dates are IST `YYYY-MM-DD`.
 */
import type {
  InvoiceKind,
  PaymentMethod,
  PaymentReviewReason,
  PaymentReviewStatus,
  PaymentSource,
  UserRole,
} from "@cb/db";
import type { BusinessDate, Paise, Period } from "@cb/domain";

/** Register filter on the payment's state. */
export const PAYMENT_LIST_STATUSES = ["all", "counted", "cancelled", "to_check"] as const;
export type PaymentListStatus = (typeof PAYMENT_LIST_STATUSES)[number];

/** One row of the payment register. */
export interface PaymentRegisterRow {
  readonly id: string;
  readonly customerId: string;
  readonly customerCode: string;
  readonly customerName: string;
  readonly amountPaise: Paise;
  readonly method: PaymentMethod;
  readonly source: PaymentSource;
  /** `null` only for migrated payments. */
  readonly collectorId: string | null;
  readonly collectorName: string | null;
  readonly recordedAt: Date;
  readonly postedAt: Date;
  readonly businessDate: BusinessDate;
  /** `R-YYMM-NNNNN` (`null` only for a migrated payment without a receipt). */
  readonly receiptNumber: string | null;
  readonly provisionalRef: string | null;
  readonly reviewStatus: PaymentReviewStatus;
  readonly reviewReason: PaymentReviewReason | null;
  /** The Owner undid it (a `payment_reversals` row exists). */
  readonly cancelled: boolean;
}

/** Totals of every payment matching the filters (not only the page shown). */
export interface PaymentRegisterTotals {
  /** Payments matching the filters, cancelled ones included. */
  readonly count: number;
  /** Σ cash of the matching payments that still count (cancelled ones left out). */
  readonly cashPaise: Paise;
  /** Σ UPI of the matching payments that still count. */
  readonly upiPaise: Paise;
  readonly cancelledCount: number;
  /** Matching payments still waiting for the office to check them. */
  readonly toCheckCount: number;
}

/** Someone who can have taken a payment (the register's "Taken by" filter). */
export interface PaymentCollectorOption {
  readonly id: string;
  readonly name: string;
  readonly role: UserRole;
  readonly active: boolean;
}

export interface PaymentRegister {
  readonly rows: readonly PaymentRegisterRow[];
  readonly hasMore: boolean;
  readonly totals: PaymentRegisterTotals;
  readonly collectors: readonly PaymentCollectorOption[];
}

/** One bill this payment went to at posting (oldest first). */
export interface PaymentDetailBill {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceKind: InvoiceKind;
  readonly period: Period;
  readonly amountPaise: Paise;
  /** What was left on that bill right after this payment (0 = paid off). */
  readonly outstandingAfterPaise: Paise;
}

/** A payment with everything the office's payment page shows. */
export interface PaymentDetail {
  readonly id: string;
  readonly amountPaise: Paise;
  readonly method: PaymentMethod;
  /** Not proof of payment (BR-10). */
  readonly upiReference: string | null;
  readonly notes: string | null;
  readonly source: PaymentSource;
  readonly recordedAt: Date;
  readonly postedAt: Date;
  readonly businessDate: BusinessDate;
  readonly customer: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly phone: string | null;
    /** The customer's balance **now** (signed: > 0 due, < 0 advance). */
    readonly balancePaise: Paise;
    /** The customer's advance (credit) now (≥ 0). */
    readonly creditPaise: Paise;
  };
  readonly collector: { readonly id: string; readonly name: string } | null;
  /** `null` only for a migrated payment without a receipt. */
  readonly receipt: {
    readonly id: string;
    readonly receiptNumber: string;
    readonly provisionalRef: string | null;
    readonly issuedAt: Date;
  } | null;
  /** The bills it paid at posting (`posting` allocations). */
  readonly bills: readonly PaymentDetailBill[];
  /** The part that became advance at posting (amount − Σ bills). */
  readonly creditAddedPaise: Paise;
  /** Balance / advance right after posting (`null` for migrated payments). */
  readonly balanceAfterPaise: Paise | null;
  readonly creditAfterPaise: Paise | null;
  readonly review: {
    readonly status: PaymentReviewStatus;
    readonly reason: PaymentReviewReason | null;
    readonly reviewedBy: { readonly id: string; readonly name: string } | null;
    readonly reviewedAt: Date | null;
    readonly note: string | null;
  };
  /** Set when the Owner undid the payment. */
  readonly cancellation: {
    readonly id: string;
    readonly reason: string;
    readonly by: { readonly id: string; readonly name: string };
    readonly at: Date;
  } | null;
}

export interface ResolvePaymentReviewResult {
  readonly paymentId: string;
  readonly reviewStatus: "resolved";
  readonly reviewedAt: Date;
}
