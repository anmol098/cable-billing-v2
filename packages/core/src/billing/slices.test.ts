/**
 * Large runs are worked in slices (T-044; PLAN §8.2 "batches of 200", §14 "within a time budget,
 * then reschedules"): a full slice of 200 customers continues later, and a handler that runs out
 * of time yields mid-slice and resumes from its cursor. Every customer is billed exactly once.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it } from "vitest";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { startBillingRun } from "./services";
import { drainBillingJobs } from "./test-support";
import { BILLING_BATCH_SIZE } from "./types";

const NOV = "2026-11-01";
const CUSTOMERS = BILLING_BATCH_SIZE + 5;

describeDb("billing run: slices", () => {
  const t = useTestDatabase();

  /** CUSTOMERS customers, each with one ₹100 VC since 1 Oct (bulk SQL through the admin pool). */
  async function bulkTenant(): Promise<SeededTenant> {
    const tenant = await seedTenant(t.current);
    await t.current.admin.query(
      `WITH c AS (
         INSERT INTO customers (id, operator_id, customer_code, name)
         SELECT gen_random_uuid(), $1, 'B' || g, 'Bulk customer' FROM generate_series(1, $2::int) g
         RETURNING id, customer_code
       ), a AS (
         INSERT INTO vc_assets (id, operator_id, vc_number)
         SELECT gen_random_uuid(), $1, 'VC' || customer_code FROM c
         RETURNING id, vc_number
       ), s AS (
         INSERT INTO vc_assignments (id, operator_id, vc_asset_id, customer_id, start_date, rental_amount_paise)
         SELECT gen_random_uuid(), $1, a.id, c.id, '2026-10-01', 10000
           FROM c JOIN a ON a.vc_number = 'VC' || c.customer_code
         RETURNING id
       )
       INSERT INTO assignment_events (id, operator_id, assignment_id, type, effective_date)
       SELECT gen_random_uuid(), $1, s.id, 'activated', '2026-10-01' FROM s`,
      [tenant.operatorId, CUSTOMERS],
    );
    return tenant;
  }

  async function assertAllBilledOnce(tenant: SeededTenant) {
    const result = await t.current.admin.query(
      `SELECT count(*)::int AS n, count(DISTINCT customer_id)::int AS customers, max(invoice_number) AS max
         FROM invoices WHERE operator_id = $1 AND period = $2`,
      [tenant.operatorId, NOV],
    );
    expect(result.rows[0]).toEqual({
      n: CUSTOMERS,
      customers: CUSTOMERS,
      max: `INV-2611-${String(CUSTOMERS).padStart(5, "0")}`,
    });
    const run = await t.current.admin.query(
      `SELECT status, customer_count, created_count, total_charges_paise::int AS total
         FROM billing_runs WHERE operator_id = $1`,
      [tenant.operatorId],
    );
    expect(run.rows[0]).toEqual({
      status: "completed",
      customer_count: CUSTOMERS,
      created_count: CUSTOMERS,
      total: CUSTOMERS * 10_000,
    });
  }

  async function start(tenant: SeededTenant, now: Date) {
    const rt = testRuntime(t.current.db, { now: () => now });
    const owner = await contextFor(rt, tenant, "owner");
    const started = await startBillingRun.call(rt, owner, { period: NOV });
    expect(started.ok).toBe(true);
  }

  it(`a full slice of ${BILLING_BATCH_SIZE} continues later and the next slice finishes`, async () => {
    const tenant = await bulkTenant();
    const now = new Date("2026-11-01T03:00:00.000Z");
    await start(tenant, now);
    const report = await drainBillingJobs(t.current.db, () => now);
    expect(report).toMatchObject({ claimed: 2, continued: 1, succeeded: 1, failed: 0 });
    await assertAllBilledOnce(tenant);
  }, 120_000);

  it("a handler out of time yields mid-slice and resumes from its cursor", async () => {
    const tenant = await bulkTenant();
    // A clock that moves 1 s every time anyone reads it: the 240 s budget runs out mid-slice.
    let ms = Date.parse("2026-11-01T03:00:00.000Z");
    const clock = () => {
      ms += 1_000;
      return new Date(ms);
    };
    await start(tenant, new Date(ms));
    let continued = 0;
    for (let invocation = 0; invocation < 20; invocation += 1) {
      const report = await drainBillingJobs(t.current.db, clock);
      expect(report.failed).toBe(0);
      continued += report.continued;
      if (report.claimed === 0) break;
    }
    // Without a mid-slice yield 205 customers would take exactly one continue (the full slice).
    expect(continued).toBeGreaterThanOrEqual(2);
    await assertAllBilledOnce(tenant);
  }, 120_000);
});
