/**
 * Invoice calculation for one customer and one period (PLAN §8.2; FR-009, FR-011, B-003, B-006,
 * RULE-04, RULE-05; PRD §13.1, §15 #3).
 *
 * ```text
 * lines = eligible assignments' rent lines (§8.1)
 *       + pending debit adjustments (invoice_id is null)
 * if lines empty → 'skipped: nothing to bill'
 * opening = customer ledger balance before this invoice
 * invoice = (opening, charges = Σ lines, total_due = opening + charges)
 * ```
 *
 * One customer gets **one consolidated invoice** per period with one rent line per billable VC
 * assignment, each at its own rental (BRD B-003 / RULE-04, PRD BR-05 / §15 #3). The function only
 * computes: the billing run (T-044) checks that no invoice exists yet, numbers it, stores it with its
 * lines, adds `chargesPaise` to the ledger, marks the adjustments invoiced and then applies credit
 * (T-041 `applyCredit`).
 */
import { addPaise, isPaise, sumPaise } from "../money";
import { domainError, err, ok, type Result } from "../result";
import { type BusinessDate, compareBusinessDates, isPeriod, type Period } from "../time";
import { billingOf } from "./timeline";
import type {
  AdjustmentLine,
  BillingError,
  BillingValidationReason,
  BuildInvoiceInput,
  BuildInvoiceOutcome,
  PendingAdjustment,
  RentLine,
} from "./types";

function invalid(
  reason: BillingValidationReason,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): Result<never, BillingError> {
  return err(domainError("VALIDATION", message, { reason, ...details }));
}

/** By UTF-16 code unit, like T-041: matches Postgres `ORDER BY id` for canonical UUIDs. */
function compareIds(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** `null` (no period) sorts first, then oldest period. */
function compareOptionalPeriods(a: Period | null, b: Period | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compareBusinessDates(a, b);
}

/**
 * Whether a pending debit adjustment goes on the invoice for `period`: it has no period, or its
 * period is not after `period`. An adjustment for a later month stays pending for that month's
 * invoice (this only happens when a missed month is billed late, D-25).
 */
function belongsOn(adjustment: PendingAdjustment, period: Period): boolean {
  return adjustment.period === null || compareBusinessDates(adjustment.period, period) <= 0;
}

/**
 * Builds the regular invoice of `customer` for `period`, or says there is nothing to bill.
 *
 * - **Rent lines**: one per assignment that {@link isBillable} for the period (active at any time
 *   on the 1st), at {@link rentalForPeriod}. Ordered by `startDate`, then assignment id. A ₹0
 *   rental still gets a ₹0 line (the VC was billable; see the open questions).
 * - **Adjustment lines**: every pending **debit** adjustment whose period is empty or not after
 *   `period`, ordered by period (empty first), then id. Their ids come back in
 *   `invoicedAdjustmentIds`. Later-period adjustments stay pending.
 * - **Totals**: `chargesPaise` = Σ lines; `totalDuePaise` = `openingBalancePaise` + charges (see
 *   {@link InvoiceDraft} for what each means).
 * - **Nothing to bill** when there are no lines: no assignment billable and no adjustment due.
 *
 * The result does not depend on the order of `assignments` or `pendingAdjustments`.
 *
 * Errors (`VALIDATION`, `details.reason`): `invalid_period`, `invalid_amount` (a bad opening
 * balance, rental or adjustment amount), `invalid_id`, `duplicate_id`, `other_customer` (an
 * assignment or adjustment of another customer: RULE-07, no charge transfer), `credit_adjustment`
 * (credit adjustments are credit, not lines: PLAN §8.5), and every timeline reason of
 * {@link validateAssignmentTimeline} (with `assignmentId`).
 */
export function buildInvoice(input: BuildInvoiceInput): Result<BuildInvoiceOutcome, BillingError> {
  const { customer, period, openingBalancePaise } = input;
  if (!isPeriod(period)) return invalid("invalid_period", "period must be the 1st of a month");
  if (!isId(customer.id))
    return invalid("invalid_id", "customer id is empty", { field: "customer" });
  if (!isPaise(openingBalancePaise)) {
    return invalid("invalid_amount", "openingBalancePaise must be whole paise", {
      field: "openingBalancePaise",
    });
  }

  const rentLines: { readonly startDate: BusinessDate; readonly line: RentLine }[] = [];
  const assignmentIds = new Set<string>();
  for (const assignment of input.assignments) {
    const ref = { assignmentId: assignment.id };
    if (!isId(assignment.id)) return invalid("invalid_id", "assignment id is empty", ref);
    if (assignmentIds.has(assignment.id)) {
      return invalid("duplicate_id", "assignment listed twice", ref);
    }
    assignmentIds.add(assignment.id);
    if (assignment.customerId !== customer.id) {
      return invalid("other_customer", "assignment belongs to another customer", ref);
    }
    const billing = billingOf(assignment, period);
    if (!billing.ok) {
      return err({ ...billing.error, details: { ...billing.error.details, ...ref } });
    }
    if (billing.value.billable) {
      rentLines.push({
        startDate: assignment.startDate,
        line: {
          type: "rent",
          assignmentId: assignment.id,
          adjustmentId: null,
          amountPaise: billing.value.rentalPaise,
        },
      });
    }
  }

  const adjustmentLines: AdjustmentLine[] = [];
  const adjustmentIds = new Set<string>();
  for (const adjustment of input.pendingAdjustments) {
    const ref = { adjustmentId: adjustment.id };
    if (!isId(adjustment.id)) return invalid("invalid_id", "adjustment id is empty", ref);
    if (adjustmentIds.has(adjustment.id)) {
      return invalid("duplicate_id", "adjustment listed twice", ref);
    }
    adjustmentIds.add(adjustment.id);
    if (adjustment.customerId !== customer.id) {
      return invalid("other_customer", "adjustment belongs to another customer", ref);
    }
    if (adjustment.direction !== "debit") {
      return invalid(
        "credit_adjustment",
        "only debit adjustments become invoice lines; credit adjustments are applied as credit",
        ref,
      );
    }
    if (!isPaise(adjustment.amountPaise) || adjustment.amountPaise <= 0) {
      return invalid("invalid_amount", "adjustment amountPaise must be paise > 0", ref);
    }
    if (adjustment.period !== null && !isPeriod(adjustment.period)) {
      return invalid("invalid_period", "adjustment period must be the 1st of a month", ref);
    }
    if (!belongsOn(adjustment, period)) continue;
    adjustmentLines.push({
      type: "adjustment",
      assignmentId: adjustment.assignmentId,
      adjustmentId: adjustment.id,
      adjustmentPeriod: adjustment.period,
      source: adjustment.source,
      amountPaise: adjustment.amountPaise,
    });
  }

  rentLines.sort(
    (a, b) =>
      compareBusinessDates(a.startDate, b.startDate) ||
      compareIds(a.line.assignmentId, b.line.assignmentId),
  );
  adjustmentLines.sort(
    (a, b) =>
      compareOptionalPeriods(a.adjustmentPeriod, b.adjustmentPeriod) ||
      compareIds(a.adjustmentId, b.adjustmentId),
  );

  const lines = [...rentLines.map((entry) => entry.line), ...adjustmentLines];
  if (lines.length === 0) {
    return ok({ outcome: "nothing_to_bill", customerId: customer.id, period });
  }

  const chargesPaise = sumPaise(lines.map((line) => line.amountPaise));
  return ok({
    outcome: "invoice",
    kind: "regular",
    customerId: customer.id,
    period,
    lines,
    chargesPaise,
    openingBalancePaise,
    totalDuePaise: addPaise(openingBalancePaise, chargesPaise),
    invoicedAdjustmentIds: adjustmentLines.map((line) => line.adjustmentId),
  });
}
