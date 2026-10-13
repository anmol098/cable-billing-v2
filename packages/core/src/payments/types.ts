/**
 * What the payment services return (T-046). Shaped so that T-061 (mobile batch) and T-048 (web
 * counter) can map them onto the T-051 contract (`PaymentBatchResult` / `PostedPayment`) without
 * another database read:
 *
 * | contract (`PostedPayment`) | here |
 * |---|---|
 * | `id`, `customer_id`, `amount_paise`, `method` | `payment.*` |
 * | `receipt_number`, `provisional_ref` | `receipt.receiptNumber`, `receipt.provisionalRef` |
 * | `recorded_at`, `posted_at`, `business_date` | `payment.*` |
 * | `allocations[]` (`invoice_id`, `invoice_number`, `kind`, `period`, `amount_paise`, `outstanding_after_paise`) | `allocations[]` |
 * | `credit_added_paise` | `creditAddedPaise` |
 * | `balance_after_paise`, `credit_after_paise` | `newBalance`, `credit` |
 * | outcome `posted` / `posted_needs_review` / `duplicate` | `outcome` |
 * | `review_reason` (only for `posted_needs_review`) | `payment.reviewReason` |
 */
import type {
  InvoiceKind,
  PaymentMethod,
  PaymentReviewReason,
  PaymentReviewStatus,
  PaymentSource,
} from "@cb/db";
import type { BusinessDate, Paise, Period } from "@cb/domain";

/** A stored payment (`payments` row), as the services return it. */
export interface PaymentView {
  /** The client's idempotency key. */
  readonly id: string;
  readonly customerId: string;
  readonly amountPaise: Paise;
  readonly method: PaymentMethod;
  /** Not proof of payment (BR-10). */
  readonly upiReference: string | null;
  readonly notes: string | null;
  /** The signed-in user who posted it (never the phone's claim). */
  readonly collectorId: string | null;
  /** The signed-in device (Android only). */
  readonly deviceId: string | null;
  readonly source: PaymentSource;
  /** Device clock (web: the server time of the counter entry). */
  readonly recordedAt: Date;
  /** Server time of posting. */
  readonly postedAt: Date;
  /** IST date of `recordedAt`: the collection session it counts for. */
  readonly businessDate: BusinessDate;
  readonly reviewStatus: PaymentReviewStatus;
  /** Set exactly when the payment was flagged at posting. */
  readonly reviewReason: PaymentReviewReason | null;
}

/** One `posting` allocation row with the invoice details a receipt prints. Oldest bill first. */
export interface PaymentAllocationView {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceKind: InvoiceKind;
  readonly period: Period;
  /** > 0. */
  readonly amountPaise: Paise;
  /** The invoice's outstanding right after this row (0 = paid off). */
  readonly outstandingAfterPaise: Paise;
}

export interface ReceiptView {
  readonly id: string;
  /** `R-YYMM-NNNNN`. */
  readonly receiptNumber: string;
  /** The phone's `P-XXX-NNNN` alias (FR-016); null for counter payments. */
  readonly provisionalRef: string | null;
  readonly issuedAt: Date;
}

/**
 * - `posted`: saved now.
 * - `posted_needs_review`: saved now and flagged (`payment.reviewReason`); the money is kept.
 * - `duplicate`: this id was already saved with the same data; everything is the stored result.
 */
export type PostPaymentOutcome = "posted" | "posted_needs_review" | "duplicate";

export interface PostPaymentResult {
  readonly outcome: PostPaymentOutcome;
  readonly payment: PaymentView;
  /** The payment's own allocations (`kind = 'posting'`), oldest bill first. */
  readonly allocations: readonly PaymentAllocationView[];
  readonly receipt: ReceiptView;
  /** The customer's balance right after this payment (signed; > 0 owes). A replay returns the same. */
  readonly newBalance: Paise;
  /** The customer's credit (advance) right after this payment (≥ 0). */
  readonly credit: Paise;
  /** The part of this payment that became credit (amount − Σ allocations). */
  readonly creditAddedPaise: Paise;
  /**
   * Every review reason found at posting, first = `payment.reviewReason` (empty when not flagged).
   * For a `duplicate` only the stored reason is known.
   */
  readonly reviewReasons: readonly PaymentReviewReason[];
  /** True when the payment has been reversed since (only possible for a `duplicate`). */
  readonly reversed: boolean;
}

/** One negative `reversal` allocation row. */
export interface ReversalAllocationView {
  readonly id: string;
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly invoiceKind: InvoiceKind;
  readonly period: Period;
  /** < 0: minus the cancelled row's amount. */
  readonly amountPaise: Paise;
  /** The invoice's outstanding right after this row. */
  readonly outstandingAfterPaise: Paise;
  /** The positive row this one cancels. */
  readonly reversesAllocationId: string;
}

export interface PaymentReversalView {
  readonly id: string;
  readonly paymentId: string;
  readonly customerId: string;
  readonly reason: string;
  /** The Owner who reversed it. */
  readonly actorId: string;
  readonly at: Date;
}

export interface ReversePaymentResult {
  readonly reversal: PaymentReversalView;
  /** The original payment, unchanged. */
  readonly payment: PaymentView;
  /** One row per cancelled allocation (posting and credit application), by original row id. */
  readonly allocations: readonly ReversalAllocationView[];
  /** The customer's balance after the reversal (+ the payment amount). */
  readonly newBalance: Paise;
  /** The customer's credit after the reversal (the payment's unallocated remainder removed). */
  readonly credit: Paise;
  /** How much credit the reversal removed (≥ 0). */
  readonly creditRemovedPaise: Paise;
}
