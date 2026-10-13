/**
 * Reads what the billing rules need, for one or many customers of the current tenant (T-044).
 * Not exported from the package. The run reads one customer at a time **after** taking that
 * customer's balance row lock; the preview reads pages of customers without locks.
 *
 * - Assignments: every `vc_assignments` row that overlaps the 1st of the period
 *   (`start_date ≤ P` and `end_date` empty or `≥ P`): the only ones `isBillable` can say yes to.
 *   Each comes with all its `assignment_events` (`at, id` order) and is mapped onto T-040's
 *   `BillingAssignment` exactly as T-022's completion notes say.
 * - Pending adjustments: the customer's **debit** adjustments with `invoice_id IS NULL` (T-040
 *   leaves later-period ones pending itself). Credit adjustments are credit sources (T-041).
 * - **Double-charge guard (T-040 Q-4, T-042 Q-2):** an assignment that already has a
 *   `mid_month_start` adjustment for the period (pending or invoiced) gets no rent line: the
 *   adjustment *is* its charge for that month (D-18 "charge full month"). Its id is reported in
 *   `midMonthStartAssignmentIds` so the run item can show why.
 *
 * Every query names `operator_id` too (RLS already limits the rows) so the `(operator_id, …)`
 * indexes are used.
 */
import { adjustments, assignmentEvents, type Tx, vcAssignments } from "@cb/db";
import {
  type AssignmentEvent,
  type BillingAssignment,
  businessDate,
  type PendingAdjustment,
  type Period,
  toPaise,
  period as toPeriod,
} from "@cb/domain";
import { and, asc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";

/** What `buildInvoice` needs for one customer (minus the opening balance). */
export interface CustomerBillingInputs {
  readonly customerId: string;
  /** Assignments to bill rent for (the mid-month-start ones are already left out). */
  readonly assignments: BillingAssignment[];
  readonly pendingAdjustments: PendingAdjustment[];
  /** Assignments left out because a `mid_month_start` adjustment already charges them for P. */
  readonly midMonthStartAssignmentIds: string[];
}

function emptyInputs(customerId: string): CustomerBillingInputs {
  return { customerId, assignments: [], pendingAdjustments: [], midMonthStartAssignmentIds: [] };
}

/** Billing inputs of `customerIds` for `period`, one entry per id (empty when nothing). */
export async function loadBillingInputs(
  tx: Tx,
  operatorId: string,
  customerIds: readonly string[],
  period: Period,
): Promise<Map<string, CustomerBillingInputs>> {
  const result = new Map<string, CustomerBillingInputs>();
  for (const id of customerIds) result.set(id, emptyInputs(id));
  if (customerIds.length === 0) return result;
  const ids = [...customerIds];

  const assignmentRows = await tx
    .select({
      id: vcAssignments.id,
      customerId: vcAssignments.customerId,
      startDate: vcAssignments.startDate,
      endDate: vcAssignments.endDate,
      rentalAmountPaise: vcAssignments.rentalAmountPaise,
    })
    .from(vcAssignments)
    .where(
      and(
        eq(vcAssignments.operatorId, operatorId),
        inArray(vcAssignments.customerId, ids),
        lte(vcAssignments.startDate, period),
        or(isNull(vcAssignments.endDate), gte(vcAssignments.endDate, period)),
      ),
    )
    .orderBy(asc(vcAssignments.id));

  const assignmentIds = assignmentRows.map((a) => a.id);
  const eventsByAssignment = new Map<string, (typeof assignmentEvents.$inferSelect)[]>();
  const midMonthStart = new Set<string>();
  if (assignmentIds.length > 0) {
    const eventRows = await tx
      .select()
      .from(assignmentEvents)
      .where(
        and(
          eq(assignmentEvents.operatorId, operatorId),
          inArray(assignmentEvents.assignmentId, assignmentIds),
        ),
      )
      .orderBy(asc(assignmentEvents.at), asc(assignmentEvents.id));
    for (const event of eventRows) {
      const list = eventsByAssignment.get(event.assignmentId) ?? [];
      list.push(event);
      eventsByAssignment.set(event.assignmentId, list);
    }
    const charged = await tx
      .select({ assignmentId: adjustments.assignmentId })
      .from(adjustments)
      .where(
        and(
          eq(adjustments.operatorId, operatorId),
          inArray(adjustments.assignmentId, assignmentIds),
          eq(adjustments.period, period),
          eq(adjustments.source, "mid_month_start"),
        ),
      );
    for (const row of charged) if (row.assignmentId) midMonthStart.add(row.assignmentId);
  }

  for (const row of assignmentRows) {
    const inputs = result.get(row.customerId);
    if (!inputs) continue;
    if (midMonthStart.has(row.id)) {
      inputs.midMonthStartAssignmentIds.push(row.id);
      continue;
    }
    const events = eventsByAssignment.get(row.id) ?? [];
    const firstPlanChange = events.find((e) => e.type === "plan_changed");
    inputs.assignments.push({
      id: row.id,
      customerId: row.customerId,
      startDate: businessDate(row.startDate),
      endDate: row.endDate === null ? null : businessDate(row.endDate),
      initialRentalPaise: toPaise(firstPlanChange?.fromRentalPaise ?? row.rentalAmountPaise),
      events: events.map(toAssignmentEvent),
    });
  }

  const adjustmentRows = await tx
    .select({
      id: adjustments.id,
      customerId: adjustments.customerId,
      assignmentId: adjustments.assignmentId,
      period: adjustments.period,
      direction: adjustments.direction,
      amountPaise: adjustments.amountPaise,
      source: adjustments.source,
    })
    .from(adjustments)
    .where(
      and(
        eq(adjustments.operatorId, operatorId),
        inArray(adjustments.customerId, ids),
        isNull(adjustments.invoiceId),
        eq(adjustments.direction, "debit"),
      ),
    )
    .orderBy(asc(adjustments.id));
  for (const row of adjustmentRows) {
    result.get(row.customerId)?.pendingAdjustments.push({
      id: row.id,
      customerId: row.customerId,
      assignmentId: row.assignmentId,
      period: row.period === null ? null : toPeriod(row.period),
      direction: row.direction,
      amountPaise: toPaise(row.amountPaise),
      source: row.source,
    });
  }
  return result;
}

function toAssignmentEvent(row: typeof assignmentEvents.$inferSelect): AssignmentEvent {
  const effectiveDate = businessDate(row.effectiveDate);
  if (row.type === "plan_changed") {
    // The DB CHECK requires to_rental_paise on plan_changed: a missing one is a bug (the run
    // records the customer as failed with internal_error).
    if (row.toRentalPaise === null) throw new Error("plan_changed event without to_rental_paise");
    return { type: "plan_changed", effectiveDate, rentalPaise: toPaise(row.toRentalPaise) };
  }
  return { type: row.type, effectiveDate };
}
