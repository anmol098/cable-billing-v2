/**
 * Test support for the connection tests (not exported from the package; no side effects, so the
 * isolation discovery can import it). A tenant whose `created_at` is early in 2026 (so billing
 * runs for any 2026 month are allowed whatever the real date is), plans, customers through the
 * T-033 service, and the real billing run (T-044) with a fixed clock.
 */
import { type DbClient, plans, type Tx, uuidv7 } from "@cb/db";
import type { TestDatabase } from "@cb/db/testing";
import { startBillingRun } from "../billing/services";
import { drainBillingJobs } from "../billing/test-support";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { createCustomer } from "../customers/customers";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";

/** An instant at `time` IST on `date` (default 11:30, the middle of the business day). */
export function ist(date: string, time = "11:30"): Date {
  return new Date(`${date}T${time}:00+05:30`);
}

export interface ConnectionSetup {
  readonly tenant: SeededTenant;
  readonly op: string;
  readonly db: DbClient;
  readonly owner: TenantContext;
  readonly staff: TenantContext;
  readonly lineman: TenantContext;
  /** A runtime whose clock says `now`. */
  rt(now: Date): ServiceRuntime;
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
}

export async function setupTenant(
  database: Pick<TestDatabase, "db" | "admin">,
  db: DbClient = database.db,
): Promise<ConnectionSetup> {
  const tenant = await seedTenant(database);
  await database.admin.query(
    "UPDATE operators SET created_at = '2026-01-01T00:00:00Z' WHERE id = $1",
    [tenant.operatorId],
  );
  const base = testRuntime(db);
  return {
    tenant,
    op: tenant.operatorId,
    db,
    owner: await contextFor(base, tenant, "owner"),
    staff: await contextFor(base, tenant, "staff"),
    lineman: await contextFor(base, tenant, "lineman"),
    rt: (now) => testRuntime(db, { now: () => now }),
    tx: (fn) => db.withTenant(tenant.operatorId, fn),
  };
}

export async function addPlan(
  s: ConnectionSetup,
  name: string,
  monthlyAmountPaise: number,
  status: "active" | "retired" = "active",
): Promise<string> {
  const id = uuidv7();
  await s.tx((tx) =>
    tx.insert(plans).values({ id, operatorId: s.op, name, monthlyAmountPaise, status }),
  );
  return id;
}

let customerSeq = 0;

/** A customer saved through `customers.create` (as the Owner). */
export async function newCustomer(s: ConnectionSetup, now: Date, name?: string): Promise<string> {
  customerSeq += 1;
  const result = await createCustomer.call(s.rt(now), s.owner, {
    customerCode: `C${customerSeq}-${uuidv7().slice(-4)}`,
    name: name ?? `Customer ${customerSeq}`,
  });
  if (!result.ok) throw new Error(`createCustomer: ${JSON.stringify(result.error)}`);
  return result.value.customer.id;
}

/** Runs the month's bills as the Owner at `now` (the real T-044 run and job worker). */
export async function runBilling(s: ConnectionSetup, period: string, now: Date): Promise<void> {
  const started = await startBillingRun.call(s.rt(now), s.owner, { period });
  if (!started.ok) throw new Error(`startBillingRun: ${JSON.stringify(started.error)}`);
  const report = await drainBillingJobs(s.db, () => now);
  if (report.failed > 0) throw new Error(`billing jobs failed: ${report.failed}`);
}
