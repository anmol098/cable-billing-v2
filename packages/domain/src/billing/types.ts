/**
 * Shapes for billing eligibility and invoice calculation (T-040, PLAN §8.1–§8.2).
 *
 * They mirror the T-022/T-023 tables (`vc_assignments`, `assignment_events`, `adjustments`,
 * `invoices`, `invoice_lines`; PLAN §7.2) closely enough that services can map rows one to one, but
 * hold only what the pure functions need. Ids are opaque strings (UUIDv7 in the DB).
 */
import type { AdjustmentDirection, AdjustmentSource } from "../adjustments";
import type { Paise } from "../money";
import type { DomainError } from "../result";
import type { BusinessDate, Period } from "../time";

/** `assignment_events.type` (PLAN §7.2). */
export type AssignmentEventType =
  | "activated"
  | "suspended"
  | "reactivated"
  | "disconnected"
  | "plan_changed";

/** Every {@link AssignmentEventType}. */
export const ASSIGNMENT_EVENT_TYPES = [
  "activated",
  "suspended",
  "reactivated",
  "disconnected",
  "plan_changed",
] as const satisfies readonly AssignmentEventType[];

/** An event that changes (or, for `activated`, marks) the assignment's status. */
export type AssignmentStatusEvent = {
  readonly type: "activated" | "suspended" | "reactivated" | "disconnected";
  /** `assignment_events.effective_date` (an IST business date). */
  readonly effectiveDate: BusinessDate;
};

/** A plan change: from `effectiveDate`'s month on, the monthly rental is `rentalPaise`. */
export type AssignmentPlanChangeEvent = {
  readonly type: "plan_changed";
  readonly effectiveDate: BusinessDate;
  /** The new monthly rental (the event's "to" value). ≥ 0. */
  readonly rentalPaise: Paise;
};

/** One row of `assignment_events`, as the billing rules need it. */
export type AssignmentEvent = AssignmentStatusEvent | AssignmentPlanChangeEvent;

/**
 * Everything that decides whether, and at what rental, a VC assignment is billed for a period.
 *
 * - `startDate` (`vc_assignments.start_date`): the **first day of service**. The assignment is
 *   active from the start of this day (PLAN §8.1: "Starts on the 1st before the run, so it is
 *   included in that month's run").
 * - `endDate` (`vc_assignments.end_date`): the **last day of service**, inclusive (the same
 *   `daterange(start_date, end_date, '[]')` the no-overlap constraint uses), i.e. the effective
 *   date of the disconnection. `null` while the assignment has not ended.
 * - `events`: the assignment's `assignment_events`, **in the order they were recorded**
 *   (`at ASC, id ASC`). They may be passed in any effective-date order: the functions sort them by
 *   effective date and use the recorded order only to break ties within one day.
 *
 * Status changes (`suspended`, `reactivated`, `disconnected`) take effect **at the end of their
 * effective day** (PLAN §8.1). See `timeline.ts` for the full rules and every edge case.
 */
export type AssignmentTimeline = {
  readonly startDate: BusinessDate;
  readonly endDate: BusinessDate | null;
  readonly events: readonly AssignmentEvent[];
};

/** The status of an assignment during one business date. */
export type AssignmentStatusOnDate = "not_started" | "active" | "suspended" | "disconnected";

/** A VC assignment as {@link buildInvoice} sees it: its timeline plus who pays and how much. */
export type BillingAssignment = AssignmentTimeline & {
  /** `vc_assignments.id`. Invoice lines keep it as their attribution (PRD §12). */
  readonly id: string;
  /** `vc_assignments.customer_id`. Must be the invoice's customer (RULE-07: no charge transfer). */
  readonly customerId: string;
  /**
   * The monthly rental the assignment **started with**: the first `plan_changed` event's "from"
   * value, or `vc_assignments.rental_amount_paise` if the plan never changed. ≥ 0.
   */
  readonly initialRentalPaise: Paise;
};

/**
 * An adjustment that has not been invoiced yet (`adjustments.invoice_id IS NULL`).
 *
 * Only **debit** adjustments become invoice lines (PLAN §8.2: "+ pending debit adjustments").
 * Credit adjustments (including T-042's credit drafts) are credit sources that pay invoices through
 * allocation (PLAN §8.5, T-041 `applyCredit`), so passing one to {@link buildInvoice} is refused:
 * putting it on the invoice too would count it twice. T-042's debit `AdjustmentDraft`s, once stored,
 * are exactly the rows to pass here (`direction`, `amountPaise`, `assignmentId`, `period`, `source`).
 */
export type PendingAdjustment = {
  readonly id: string;
  readonly customerId: string;
  /** The VC assignment it is about, if any (`adjustments.assignment_id`). */
  readonly assignmentId: string | null;
  /** The period it is for, if any (`adjustments.period`). */
  readonly period: Period | null;
  readonly direction: AdjustmentDirection;
  /** > 0. The direction carries the sign. */
  readonly amountPaise: Paise;
  readonly source: AdjustmentSource;
};

/** One month's rent for one VC assignment (`invoice_lines.type = 'rent'`). */
export type RentLine = {
  readonly type: "rent";
  readonly assignmentId: string;
  readonly adjustmentId: null;
  /** The rental in effect for the period (see `rentalForPeriod`). ≥ 0. */
  readonly amountPaise: Paise;
};

/** A pending debit adjustment carried onto this invoice (`invoice_lines.type = 'adjustment'`). */
export type AdjustmentLine = {
  readonly type: "adjustment";
  readonly assignmentId: string | null;
  readonly adjustmentId: string;
  /** The adjustment's own period (it may be earlier than the invoice's). */
  readonly adjustmentPeriod: Period | null;
  readonly source: AdjustmentSource;
  /** > 0. */
  readonly amountPaise: Paise;
};

/** A line of a new invoice, before it is stored. */
export type InvoiceLineDraft = RentLine | AdjustmentLine;

/**
 * A regular monthly invoice, ready to store (PLAN §8.2).
 *
 * - `chargesPaise` = Σ `lines` (`invoices.charges_paise`): what this invoice adds to the ledger.
 * - `openingBalancePaise` = the customer's ledger balance just before this invoice
 *   (`invoices.opening_balance_paise`): earlier months' dues, or credit when negative. Shown
 *   separately (FR-009: "show prior balance separately").
 * - `totalDuePaise` = opening + charges (`invoices.total_due_paise`): the customer's balance right
 *   after the invoice. It may be negative (more credit than dues).
 *
 * `totalDuePaise` is a **snapshot for display**, never a receivable: what is still owed on this
 * invoice is its charges − its allocations (T-041 `invoiceOutstanding`). The opening balance stays
 * owed on the earlier invoices it came from.
 */
export type InvoiceDraft = {
  readonly outcome: "invoice";
  readonly kind: "regular";
  readonly customerId: string;
  readonly period: Period;
  /** Rent lines first (oldest assignment first), then adjustment lines (oldest first). */
  readonly lines: readonly InvoiceLineDraft[];
  readonly chargesPaise: Paise;
  readonly openingBalancePaise: Paise;
  readonly totalDuePaise: Paise;
  /** The adjustments this invoice carries: set their `invoice_id` in the same transaction. */
  readonly invoicedAdjustmentIds: readonly string[];
};

/**
 * Nothing to put on an invoice for this period: no assignment is billable and no pending debit
 * adjustment applies (PLAN §8.2: "if lines empty → item 'skipped: nothing to bill'"). Earlier dues
 * stay owed on the earlier invoices (RULE-08: "arrears remain due").
 */
export type NothingToBill = {
  readonly outcome: "nothing_to_bill";
  readonly customerId: string;
  readonly period: Period;
};

export type BuildInvoiceOutcome = InvoiceDraft | NothingToBill;

/** Input of {@link buildInvoice}. */
export type BuildInvoiceInput = {
  readonly customer: { readonly id: string };
  /** Every VC assignment of the customer that may be billable (ended ones may be included). */
  readonly assignments: readonly BillingAssignment[];
  /** The customer's adjustments with `invoice_id IS NULL`. Debit only (see {@link PendingAdjustment}). */
  readonly pendingAdjustments: readonly PendingAdjustment[];
  /** The customer's ledger balance before this invoice (Σ `ledger_entries`). Signed. */
  readonly openingBalancePaise: Paise;
  readonly period: Period;
};

/**
 * Why billing input was refused. Always `VALIDATION`: the data is inconsistent (an impossible
 * timeline, a row of another customer, a credit adjustment passed as a line, a bad amount). The
 * billing run records it as a failed item for a person to look at (J-03); nothing is guessed (BR-14).
 * `details.reason` is one of {@link BillingValidationReason}.
 */
export type BillingError = DomainError<"VALIDATION">;

/** Machine reasons in `BillingError.details.reason`. */
export type BillingValidationReason =
  | "invalid_period"
  | "invalid_amount"
  | "invalid_id"
  | "duplicate_id"
  | "other_customer"
  | "credit_adjustment"
  | "invalid_date"
  | "unknown_event_type"
  | "end_before_start"
  | "event_before_start"
  | "event_after_end"
  | "activated_not_on_start"
  | "invalid_transition"
  | "end_date_mismatch";
