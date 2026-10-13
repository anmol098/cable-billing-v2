/**
 * Row helpers for the connection services (T-034). Not exported from the package: services use
 * them inside their own tenant transaction.
 *
 * **Lock order** (every connection write takes them in this order, so two writers never wait on
 * each other in a cycle):
 * 1. the customer row, `FOR NO KEY UPDATE` (serialises connection changes of one customer with
 *    T-033's close/reopen, which takes `FOR UPDATE`; it does not block foreign-key checks, so
 *    payments and the billing run are not held up);
 * 2. the customer's `customer_balances` row (`lockCustomerBalance`, T-046): serialises with
 *    payments, reversals and the billing run, so "is this month billed?" cannot change under us;
 * 3. the VC asset row, `FOR UPDATE`: serialises every assignment change of one VC, whichever
 *    customer it is on (two people adding the same VC at once: the second sees the first's row);
 * 4. the assignment row, `FOR UPDATE`.
 * Payments and the billing run take only (2). T-033 takes only (1).
 *
 * Every query names `operator_id` too (RLS already limits the rows) so the `(operator_id, …)`
 * indexes are used.
 */
import {
  assignmentEvents,
  customers,
  normalizeVcNumber,
  type Tx,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import {
  type AssignmentEvent,
  type AssignmentTimeline,
  type BusinessDate,
  businessDate,
  type Period,
  toPaise,
  period as toPeriod,
} from "@cb/domain";
import { and, asc, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
import { lockCustomerBalance } from "../payments/ledger-io";

export type AssignmentRow = typeof vcAssignments.$inferSelect;
export type AssignmentEventRow = typeof assignmentEvents.$inferSelect;
export type VcAssetRow = typeof vcAssets.$inferSelect;

export interface LockedCustomer {
  readonly id: string;
  readonly status: "active" | "inactive";
}

/** Locks (1) and (2) of the module comment. `null` when the customer is not in this tenant. */
export async function lockCustomerForConnections(
  tx: Tx,
  operatorId: string,
  customerId: string,
): Promise<LockedCustomer | null> {
  const [row] = await tx
    .select({ id: customers.id, status: customers.status })
    .from(customers)
    .where(and(eq(customers.operatorId, operatorId), eq(customers.id, customerId)))
    .for("no key update");
  if (!row) return null;
  await lockCustomerBalance(tx, operatorId, customerId);
  return row;
}

/** Bumps `customers.updated_at` (the lineman roster syncs by it, PLAN §10.3). */
export async function touchCustomer(
  tx: Tx,
  operatorId: string,
  customerId: string,
  now: Date,
): Promise<void> {
  await tx
    .update(customers)
    .set({ updatedAt: now })
    .where(and(eq(customers.operatorId, operatorId), eq(customers.id, customerId)));
}

/**
 * The customer's latest **billed** month: a regular invoice exists for it, or the month's
 * billing run already looked at the customer and decided (`created`, `already_exists`, or
 * `skipped` = nothing to bill). A `failed` item is not billed: its retry reads the state again.
 */
export async function latestBilledPeriod(
  tx: Tx,
  operatorId: string,
  customerId: string,
): Promise<Period | null> {
  const result = await tx.execute<{ period: string | null }>(sql`
    SELECT max(p)::text AS period FROM (
      SELECT i.period AS p FROM invoices i
       WHERE i.operator_id = ${operatorId}::uuid AND i.customer_id = ${customerId}::uuid
         AND i.kind = 'regular'
      UNION ALL
      SELECT r.period AS p FROM billing_run_items it
        JOIN billing_runs r ON r.operator_id = it.operator_id AND r.id = it.run_id
       WHERE it.operator_id = ${operatorId}::uuid AND it.customer_id = ${customerId}::uuid
         AND it.outcome IN ('created', 'already_exists', 'skipped')
    ) billed`);
  const value = result.rows[0]?.period ?? null;
  return value === null ? null : toPeriod(value);
}

/**
 * Finds the VC asset for `vcNumber` (by its normalised number) or creates it, and locks it
 * (lock 3). A concurrent creator of the same number makes this wait for it and then use its row.
 */
export async function findOrCreateVcAsset(
  tx: Tx,
  operatorId: string,
  vcNumber: string,
  now: Date,
): Promise<{ readonly asset: VcAssetRow; readonly created: boolean }> {
  const inserted = await tx
    .insert(vcAssets)
    .values({ id: uuidv7(), operatorId, vcNumber, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: [vcAssets.operatorId, vcAssets.vcNumberNorm] })
    .returning({ id: vcAssets.id });
  const [asset] = await tx
    .select()
    .from(vcAssets)
    .where(
      and(
        eq(vcAssets.operatorId, operatorId),
        eq(vcAssets.vcNumberNorm, normalizeVcNumber(vcNumber)),
      ),
    )
    .for("update");
  if (!asset) throw new Error("vc asset missing after insert");
  return { asset, created: inserted.length > 0 };
}

/** Lock 3 for an asset known by id. */
export async function lockVcAsset(
  tx: Tx,
  operatorId: string,
  vcAssetId: string,
): Promise<VcAssetRow | null> {
  const [asset] = await tx
    .select()
    .from(vcAssets)
    .where(and(eq(vcAssets.operatorId, operatorId), eq(vcAssets.id, vcAssetId)))
    .for("update");
  return asset ?? null;
}

/** Who has the VC on or after `from`: the latest assignment that is open or ends on/after it. */
export async function holderFrom(
  tx: Tx,
  operatorId: string,
  vcAssetId: string,
  from: BusinessDate,
): Promise<AssignmentRow | null> {
  const [row] = await tx
    .select()
    .from(vcAssignments)
    .where(
      and(
        eq(vcAssignments.operatorId, operatorId),
        eq(vcAssignments.vcAssetId, vcAssetId),
        or(isNull(vcAssignments.endDate), gte(vcAssignments.endDate, from)),
      ),
    )
    .orderBy(desc(vcAssignments.startDate), desc(vcAssignments.id))
    .limit(1);
  return row ?? null;
}

/** The VC's latest assignment (any status), for "used before by …". */
export async function latestAssignmentOf(
  tx: Tx,
  operatorId: string,
  vcAssetId: string,
): Promise<AssignmentRow | null> {
  const [row] = await tx
    .select()
    .from(vcAssignments)
    .where(and(eq(vcAssignments.operatorId, operatorId), eq(vcAssignments.vcAssetId, vcAssetId)))
    .orderBy(desc(vcAssignments.startDate), desc(vcAssignments.id))
    .limit(1);
  return row ?? null;
}

/** The customer code and name of a customer of this tenant (for "this VC is with …"). */
export async function customerLabel(
  tx: Tx,
  operatorId: string,
  customerId: string,
): Promise<{ readonly customerCode: string; readonly name: string } | null> {
  const [row] = await tx
    .select({ customerCode: customers.customerCode, name: customers.name })
    .from(customers)
    .where(and(eq(customers.operatorId, operatorId), eq(customers.id, customerId)));
  return row ?? null;
}

/** An assignment of this tenant (no lock), or null. */
export async function findAssignment(
  tx: Tx,
  operatorId: string,
  assignmentId: string,
  options: { readonly lock?: boolean } = {},
): Promise<AssignmentRow | null> {
  const query = tx
    .select()
    .from(vcAssignments)
    .where(and(eq(vcAssignments.operatorId, operatorId), eq(vcAssignments.id, assignmentId)));
  const [row] = options.lock ? await query.for("update") : await query;
  return row ?? null;
}

/** The assignment's events in recorded order (`at, id`). */
export async function eventsOf(
  tx: Tx,
  operatorId: string,
  assignmentId: string,
): Promise<AssignmentEventRow[]> {
  return tx
    .select()
    .from(assignmentEvents)
    .where(
      and(
        eq(assignmentEvents.operatorId, operatorId),
        eq(assignmentEvents.assignmentId, assignmentId),
      ),
    )
    .orderBy(asc(assignmentEvents.at), asc(assignmentEvents.id));
}

/** One stored event → T-040's `AssignmentEvent` (the T-022 mapping). */
export function toDomainEvent(row: {
  readonly type: AssignmentEventRow["type"];
  readonly effectiveDate: string;
  readonly toRentalPaise: number | null;
}): AssignmentEvent {
  const effectiveDate = businessDate(row.effectiveDate);
  if (row.type === "plan_changed") {
    if (row.toRentalPaise === null) throw new Error("plan_changed event without to_rental_paise");
    return { type: "plan_changed", effectiveDate, rentalPaise: toPaise(row.toRentalPaise) };
  }
  return { type: row.type, effectiveDate };
}

/** An assignment and its events → T-040's timeline (T-022 completion notes). */
export function toTimeline(
  row: { readonly startDate: string; readonly endDate: string | null },
  events: readonly {
    readonly type: AssignmentEventRow["type"];
    readonly effectiveDate: string;
    readonly toRentalPaise: number | null;
  }[],
): AssignmentTimeline {
  return {
    startDate: businessDate(row.startDate),
    endDate: row.endDate === null ? null : businessDate(row.endDate),
    events: events.map(toDomainEvent),
  };
}

/** The latest effective date among the events (the start date when there are none). */
export function lastChangeDate(
  startDate: string,
  events: readonly { readonly effectiveDate: string }[],
): BusinessDate {
  let latest = startDate;
  for (const event of events) if (event.effectiveDate > latest) latest = event.effectiveDate;
  return businessDate(latest);
}
