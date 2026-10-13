/**
 * Shapes shared by allocation, credit application, reversal and the ledger checker (T-041).
 *
 * These mirror the T-023 tables (PLAN §7.2) closely enough that services can map rows one to one,
 * but they hold only what the pure functions need. Ids are opaque strings (UUIDv7 in the DB).
 */
import type { Paise } from "../money";
import type { DomainError } from "../result";
import type { Instant, Period } from "../time";

/** What an allocation row draws its money from (`allocations.source_type`, PLAN §7.2). */
export type AllocationSourceType = "payment" | "credit_adjustment";

/** Every {@link AllocationSourceType}, in the order used as a tie-break. */
export const ALLOCATION_SOURCE_TYPES = [
  "credit_adjustment",
  "payment",
] as const satisfies readonly AllocationSourceType[];

/**
 * An invoice that may still be owed, as {@link allocate} and {@link applyCredit} see it.
 *
 * `outstandingPaise` = the invoice's charges − Σ its allocation rows (see `invoiceOutstanding`).
 * It is **not** `invoices.total_due_paise`: that figure also carries the opening balance (earlier
 * months' dues), which are still owed on those earlier invoices, so counting it here would make a
 * payment settle the same rupee twice.
 *
 * Invoices with `outstandingPaise === 0` may be passed and are skipped; a negative value breaks
 * invariant 4 and is refused.
 */
export type OpenInvoice = {
  readonly id: string;
  /** The billing period (`invoices.period`). Allocation goes oldest period first. */
  readonly period: Period;
  readonly outstandingPaise: Paise;
};

/** One allocation of a payment to an invoice, before it is stored (always > 0). */
export type InvoiceAllocation = {
  readonly invoiceId: string;
  readonly amountPaise: Paise;
};

/**
 * Unallocated money that can pay invoices (PLAN §8.5): a payment's remainder or a credit
 * adjustment. `availablePaise` is what is still unallocated (see `unallocatedRemainder`).
 */
export type CreditSource = {
  readonly sourceType: AllocationSourceType;
  readonly sourceId: string;
  readonly availablePaise: Paise;
  /**
   * When the credit came into existence; older sources are used first. Use the payment's
   * `posted_at` and the adjustment's creation time (UTC instants).
   */
  readonly at: Instant;
};

/** One allocation from a credit source to an invoice, before it is stored (always > 0). */
export type CreditAllocation = {
  readonly sourceType: AllocationSourceType;
  readonly sourceId: string;
  readonly invoiceId: string;
  readonly amountPaise: Paise;
};

/** A stored `allocations` row (PLAN §7.2). Negative amounts come only from reversals. */
export type AllocationRow = {
  readonly id: string;
  readonly invoiceId: string;
  readonly sourceType: AllocationSourceType;
  readonly sourceId: string;
  readonly amountPaise: Paise;
  /** Set on the negative rows a reversal inserts (`allocations.reversal_id`). */
  readonly reversalId: string | null;
};

/** Errors from {@link allocate} and {@link applyCredit}. */
export type AllocationError = DomainError<"VALIDATION" | "INVARIANT_VIOLATION">;

/** Errors from {@link reverse}. `CONFLICT`: the payment is already reversed. */
export type ReversalError = DomainError<"VALIDATION" | "CONFLICT" | "INVARIANT_VIOLATION">;
