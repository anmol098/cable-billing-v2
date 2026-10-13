/**
 * Test support for the billing-run tests (not exported from the package; no side effects, so the
 * isolation discovery can import it). Seeds connections the way T-034 will store them (T-022
 * completion notes), adjustments the way T-045 will, and runs the `billing.run` job through the
 * real worker with a fixed clock.
 */
import {
  adjustments,
  assignmentEvents,
  customerBalances,
  type DbClient,
  ledgerEntries,
  type Tx,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { sql } from "drizzle-orm";
import { createJobRegistry } from "../jobs/registry";
import { type JobWorkerOptions, type JobWorkerReport, runJobWorker } from "../jobs/worker";
import { captureLogs } from "../testing/fixtures";
import { billingRunJob } from "./job";

export { insertCustomer, readLedgerState } from "../payments/test-support";

export type ConnectionEvent =
  | { type: "suspended" | "reactivated" | "disconnected"; date: string }
  | { type: "plan_changed"; date: string; fromPaise: number; toPaise: number };

/**
 * Adds a VC connection (asset + assignment + its `activated` event and any later events), keeping
 * `status`, `end_date` and `rental_amount_paise` in step with the events as T-034 will.
 */
export async function addConnection(
  tx: Tx,
  operatorId: string,
  customerId: string,
  input: { startDate: string; rentalPaise: number; events?: ConnectionEvent[] },
): Promise<string> {
  const assetId = uuidv7();
  await tx
    .insert(vcAssets)
    .values({ id: assetId, operatorId, vcNumber: `VC${assetId.slice(-12)}` });
  const events = input.events ?? [];
  let status: "active" | "suspended" | "disconnected" = "active";
  let endDate: string | null = null;
  let rental = input.rentalPaise;
  for (const e of events) {
    if (e.type === "suspended") status = "suspended";
    else if (e.type === "reactivated") status = "active";
    else if (e.type === "disconnected") {
      status = "disconnected";
      endDate = e.date;
    } else if (e.type === "plan_changed") rental = e.toPaise;
  }
  const id = uuidv7();
  await tx.insert(vcAssignments).values({
    id,
    operatorId,
    vcAssetId: assetId,
    customerId,
    startDate: input.startDate,
    endDate,
    status,
    rentalAmountPaise: rental,
  });
  let at = Date.parse(`${input.startDate}T00:00:00Z`);
  const rows = [{ type: "activated" as const, date: input.startDate }, ...events];
  for (const e of rows) {
    at += 1_000;
    await tx.insert(assignmentEvents).values({
      id: uuidv7(),
      operatorId,
      assignmentId: id,
      type: e.type,
      effectiveDate: e.date,
      ...(e.type === "plan_changed"
        ? { fromRentalPaise: e.fromPaise, toRentalPaise: e.toPaise }
        : {}),
      at: new Date(at),
    });
  }
  return id;
}

/**
 * Adds an adjustment as T-045 will: a debit stays pending until a bill picks it up; a credit
 * gets its `credit_adjustment` ledger entry (−amount) and becomes customer credit at once.
 */
export async function addAdjustment(
  tx: Tx,
  operatorId: string,
  input: {
    customerId: string;
    direction: "debit" | "credit";
    amountPaise: number;
    source: "plan_change" | "mid_month_start" | "manual" | "migration";
    assignmentId?: string;
    period?: string;
    createdBy?: string;
    reason?: string;
    at?: Date;
  },
): Promise<string> {
  const id = uuidv7();
  await tx
    .insert(customerBalances)
    .values({ customerId: input.customerId, operatorId })
    .onConflictDoNothing();
  await tx.execute(
    sql`select 1 from customer_balances where customer_id = ${input.customerId} for update`,
  );
  await tx.insert(adjustments).values({
    id,
    operatorId,
    customerId: input.customerId,
    assignmentId: input.assignmentId ?? null,
    period: input.period ?? null,
    direction: input.direction,
    amountPaise: input.amountPaise,
    source: input.source,
    reason: input.reason ?? (input.source === "manual" ? "Test adjustment" : null),
    createdBy: input.createdBy ?? null,
    ...(input.at ? { createdAt: input.at } : {}),
  });
  if (input.direction === "credit") {
    await tx.insert(ledgerEntries).values({
      id: uuidv7(),
      operatorId,
      customerId: input.customerId,
      type: "credit_adjustment",
      amountPaise: -input.amountPaise,
      adjustmentId: id,
    });
    await tx
      .update(customerBalances)
      .set({
        balancePaise: sql`${customerBalances.balancePaise} - ${input.amountPaise}`,
        creditPaise: sql`${customerBalances.creditPaise} + ${input.amountPaise}`,
      })
      .where(sql`${customerBalances.customerId} = ${input.customerId}`);
  }
  return id;
}

/** Runs queued `billing.run` jobs with the real worker until the queue is empty. */
export async function drainBillingJobs(
  db: DbClient,
  clock: () => Date,
  options: Partial<Omit<JobWorkerOptions, "db" | "registry" | "clock">> = {},
): Promise<JobWorkerReport> {
  const logs = captureLogs();
  return runJobWorker({
    db,
    registry: createJobRegistry([billingRunJob]),
    logger: logs.logger,
    clock,
    ...options,
  });
}
