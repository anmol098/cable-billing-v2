/**
 * The daily billing scheduler (T-044; PLAN §14 `billing-scheduler`; B-006; D-13, D-25) against a
 * real database with an injected clock. The scheduler covers every tenant in the database, so each
 * test asserts on its own tenants' rows only.
 */
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it } from "vitest";
import {
  captureLogs,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
} from "../testing/fixtures";
import { ensureRun } from "./runs";
import { scheduleBillingRuns } from "./scheduler";
import { addConnection, drainBillingJobs, insertCustomer } from "./test-support";

const NOV = "2026-11-01";
const NOV_1 = new Date("2026-10-31T18:45:00.000Z"); // 00:15 IST, 1 Nov 2026 (the cron's time)
const NOV_5 = new Date("2026-11-04T18:45:00.000Z"); // 00:15 IST, 5 Nov 2026

describeDb("billing scheduler", () => {
  const t = useTestDatabase();

  async function rows<T>(text: string, params: unknown[]): Promise<T[]> {
    return (await t.current.admin.query(text, params)).rows as T[];
  }

  const runOf = async (tenant: SeededTenant) => {
    const [run] = await rows<{
      id: string;
      status: string;
      trigger: string;
      skip_reason: string | null;
    }>(
      "SELECT id, status, trigger, skip_reason FROM billing_runs WHERE operator_id = $1 AND period = $2",
      [tenant.operatorId, NOV],
    );
    return run ?? null;
  };
  const liveJobs = async (tenant: SeededTenant) =>
    (
      await rows<{ n: number }>(
        "SELECT count(*)::int AS n FROM jobs WHERE operator_id = $1 AND type = 'billing.run' AND status IN ('queued', 'running')",
        [tenant.operatorId],
      )
    )[0]?.n ?? 0;

  async function tenantWithCustomer(): Promise<SeededTenant> {
    const tenant = await seedTenant(t.current);
    await t.current.db.withTenant(tenant.operatorId, async (tx) => {
      const id = await insertCustomer(tx, tenant.operatorId);
      await addConnection(tx, tenant.operatorId, id, {
        startDate: "2026-10-01",
        rentalPaise: 30_000,
      });
    });
    return tenant;
  }

  const schedule = (now: Date) =>
    scheduleBillingRuns({ db: t.current.db, now, log: captureLogs().logger, requestId: null });

  it("on the 1st: billable tenants get a cron run and a job; read-only ones a skipped run", async () => {
    const billable = await tenantWithCustomer();
    const readOnly = await tenantWithCustomer();
    await setSubscriptionStatus(t.current, readOnly.operatorId, "read_only");
    const noSubscription = await seedTenant(t.current, { subscription: null });
    const newcomer = await tenantWithCustomer();
    await t.current.admin.query("UPDATE operators SET created_at = $2 WHERE id = $1", [
      newcomer.operatorId,
      new Date("2026-10-31T19:00:00.000Z"), // 00:30 IST on the 1st: after the period began
    ]);
    const suspended = await tenantWithCustomer();
    await t.current.admin.query("UPDATE operators SET status = 'suspended' WHERE id = $1", [
      suspended.operatorId,
    ]);

    const report = await schedule(NOV_1);
    expect(report).toMatchObject({ period: NOV, billingDay: true, errors: 0 });
    expect(await runOf(billable)).toMatchObject({
      status: "pending",
      trigger: "cron",
      skip_reason: null,
    });
    expect(await liveJobs(billable)).toBe(1);
    for (const tenant of [readOnly, noSubscription]) {
      expect(await runOf(tenant)).toMatchObject({
        status: "skipped",
        trigger: "cron",
        skip_reason: "tenant_read_only",
      });
      expect(await liveJobs(tenant)).toBe(0);
    }
    expect(await runOf(newcomer)).toBeNull();
    expect(await runOf(suspended)).toBeNull();
    const audits = await rows<{ operator_id: string; action: string; actor_id: string | null }>(
      "SELECT operator_id, action, actor_id FROM audit_events WHERE entity_type = 'billing_run' AND operator_id = ANY($1) ORDER BY action",
      [[billable.operatorId, readOnly.operatorId]],
    );
    expect(audits).toEqual([
      { operator_id: billable.operatorId, action: "billing.run_scheduled", actor_id: null },
      { operator_id: readOnly.operatorId, action: "billing.run_skipped", actor_id: null },
    ]);

    // Idempotent: a second pass the same day queues nothing new.
    const again = await schedule(NOV_1);
    expect(again.outcomes.queued).toBe(0);
    expect(again.outcomes.skipped).toBe(0);
    expect(await liveJobs(billable)).toBe(1);

    await drainBillingJobs(t.current.db, () => NOV_1);
    expect(await runOf(billable)).toMatchObject({ status: "completed" });
    const invoices = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM invoices WHERE operator_id = ANY($1)",
      [[billable.operatorId, readOnly.operatorId, newcomer.operatorId, suspended.operatorId]],
    );
    expect(invoices[0]?.n).toBe(1);
  }, 60_000);

  it("catch-up on later days: missing or lost runs are queued; finished and skipped runs are left alone (D-25)", async () => {
    const missing = await tenantWithCustomer();
    const missed = await tenantWithCustomer();
    const lost = await tenantWithCustomer();
    const failed = await tenantWithCustomer();
    const done = await tenantWithCustomer();
    // `missed` was read-only on the 1st and is active again: its skipped run stays skipped.
    for (const [tenant, extra] of [
      [missed, { skipReason: "tenant_read_only" as const }],
      [lost, {}],
      [failed, {}],
      [done, {}],
    ] as const) {
      await t.current.db.withTenant(tenant.operatorId, (tx) =>
        ensureRun(tx, {
          operatorId: tenant.operatorId,
          period: NOV as never,
          trigger: "cron",
          actorId: null,
          now: NOV_1,
          ...extra,
        }),
      );
    }
    await t.current.admin.query(
      "UPDATE billing_runs SET status = 'failed', finished_at = $2 WHERE operator_id = $1",
      [failed.operatorId, NOV_1],
    );
    await t.current.admin.query(
      "UPDATE billing_runs SET status = 'completed', finished_at = $2 WHERE operator_id = $1",
      [done.operatorId, NOV_1],
    );

    const report = await schedule(NOV_5);
    expect(report).toMatchObject({ billingDay: false, errors: 0 });
    expect(await runOf(missing)).toMatchObject({ status: "pending", trigger: "catch_up" });
    expect(await runOf(missed)).toMatchObject({ status: "skipped" });
    expect(await runOf(lost)).toMatchObject({ status: "pending", trigger: "cron" });
    expect(await runOf(failed)).toMatchObject({ status: "pending" });
    expect(await runOf(done)).toMatchObject({ status: "completed" });
    expect(
      await Promise.all([missing, missed, lost, failed, done].map((tenant) => liveJobs(tenant))),
    ).toEqual([1, 0, 1, 1, 0]);

    // The queued jobs are live now: another pass changes nothing.
    await schedule(NOV_5);
    expect(await Promise.all([missing, lost, failed].map((tenant) => liveJobs(tenant)))).toEqual([
      1, 1, 1,
    ]);
    await drainBillingJobs(t.current.db, () => NOV_5);
    for (const tenant of [missing, lost, failed]) {
      expect(await runOf(tenant)).toMatchObject({ status: "completed" });
    }
    const missedInvoices = await rows<{ n: number }>(
      "SELECT count(*)::int AS n FROM invoices WHERE operator_id = $1",
      [missed.operatorId],
    );
    expect(missedInvoices[0]?.n).toBe(0);
  }, 60_000);
});
