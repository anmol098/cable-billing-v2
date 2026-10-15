/**
 * Admin console services (T-086) against a real database with an injected clock:
 * - cross-tenant reads are aggregates only: no customer name or phone, no money amount, no
 *   invariant samples, no Razorpay payload ever appears in what they return;
 * - every call (reads included) writes a platform audit event;
 * - extend / record offline payment go through T-085's state machine, are audited in the tenant's
 *   log and the platform log, and the offline payment is an idempotent money record;
 * - job retry re-enqueues a failed job as a new one, once;
 * - create tenant uses provisionTenant (idempotent on the form's id).
 */
import { uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import type { AdminContext } from "./context";
import { createTenantByAdmin } from "./create-tenant";
import { platformMetrics } from "./metrics";
import {
  listBillingRuns,
  listJobs,
  listPlatformAudit,
  listRazorpayEvents,
  retryJob,
} from "./monitor";
import { addMonthsToDate, extendSubscription, recordOfflinePayment } from "./subscription";
import { listTenants, tenantDetail } from "./tenants";
import { adminContextFor, platformAuditActions, seedPlatformAdmin } from "./test-support";

const NOW = new Date("2026-11-02T05:00:00Z"); // 10:30 IST, 2 Nov 2026
const SECRETS = ["Secret Sharma", "9811122233", "987654321", "555444333", "payer@example.com"];

describe("addMonthsToDate", () => {
  it("adds calendar months and clamps the day", async () => {
    const { businessDate } = await import("@cb/domain");
    expect(addMonthsToDate(businessDate("2026-11-03"), 1)).toBe("2026-12-03");
    expect(addMonthsToDate(businessDate("2026-01-31"), 1)).toBe("2026-02-28");
    expect(addMonthsToDate(businessDate("2028-01-31"), 1)).toBe("2028-02-29");
    expect(addMonthsToDate(businessDate("2026-11-30"), 3)).toBe("2027-02-28");
    expect(addMonthsToDate(businessDate("2026-12-15"), 12)).toBe("2027-12-15");
  });
});

describeDb("admin console services (T-086)", () => {
  const t = useTestDatabase();
  const rt = () => testRuntime(t.current.db, { now: () => NOW });
  let a: SeededTenant;
  let b: SeededTenant;
  let adminId: string;
  let ctx: AdminContext;
  let failedJobId: string;

  beforeAll(async () => {
    a = await seedTenant(t.current, { subscription: "active" });
    b = await seedTenant(t.current, { subscription: "trialing" });
    adminId = await seedPlatformAdmin(t.current);
    ctx = await adminContextFor(rt(), adminId);
    const q = (text: string, values: unknown[]) => t.current.admin.query(text, values);
    const customer = await q(
      `INSERT INTO customers (id, operator_id, customer_code, name, phone)
       VALUES (gen_random_uuid(), $1, 'C-7', 'Secret Sharma', '9811122233') RETURNING id`,
      [a.operatorId],
    );
    const customerId = customer.rows[0]?.id as string;
    const run = await q(
      `INSERT INTO billing_runs (id, operator_id, period, trigger, status, customer_count,
         created_count, failed_count, total_charges_paise, started_at, finished_at)
       VALUES (gen_random_uuid(), $1, '2026-11-01', 'cron', 'completed_with_errors', 3, 2, 1,
         987654321, $2, $2) RETURNING id`,
      [a.operatorId, NOW],
    );
    const runId = run.rows[0]?.id as string;
    await q(
      `INSERT INTO billing_run_items (id, operator_id, run_id, customer_id, outcome, reason, details)
       VALUES (gen_random_uuid(), $1, $2, $3, 'failed', 'balance_mismatch', '{"amount": 555444333}')`,
      [a.operatorId, runId, customerId],
    );
    await q(
      `INSERT INTO invariant_checks (id, operator_id, run_id, checked_at, status, violation_count,
         counts, samples, duration_ms)
       VALUES (gen_random_uuid(), $1, gen_random_uuid(), $2, 'breach', 1,
         '{"BALANCE_MISMATCH": 1}', '[{"code":"BALANCE_MISMATCH","details":{"amount":555444333}}]', 5)`,
      [a.operatorId, NOW],
    );
    failedJobId = uuidv7();
    await q(
      `INSERT INTO jobs (id, operator_id, type, payload, status, attempts, max_attempts, last_error,
         dedupe_key, finished_at)
       VALUES ($1, $2, 'billing.run', $3, 'failed', 5, 5, 'Error: boom', 'billing.run:t086', $4)`,
      [
        failedJobId,
        a.operatorId,
        JSON.stringify({ runId, period: "2026-11-01", mode: "run" }),
        NOW,
      ],
    );
    await q(
      `INSERT INTO subscription_events (id, operator_id, razorpay_event_id, type, payload, processed_at)
       VALUES (gen_random_uuid(), $1, $2, 'subscription.charged',
         '{"payload":{"payment":{"entity":{"email":"payer@example.com"}}}}', $3)`,
      [a.operatorId, `evt_${uuidv7()}`, NOW],
    );
  });

  async function expectAudited<T>(call: () => Promise<T>, action: string): Promise<T> {
    const before = await platformAuditActions(t.current, adminId);
    const result = await call();
    const after = await platformAuditActions(t.current, adminId);
    expect(after.slice(before.length)).toContain(action);
    return result;
  }

  it("cross-tenant reads return aggregates only, and every read is audited", async () => {
    const outputs: unknown[] = [];
    const list = await expectAudited(() => listTenants.call(rt(), ctx, {}), "admin.tenants_listed");
    if (!list.ok) throw new Error(list.error.code);
    const rowA = list.value.rows.find((r) => r.operatorId === a.operatorId);
    expect(rowA).toMatchObject({ activeCustomers: 1, linemen: 1, subscriptionStatus: "active" });
    outputs.push(list.value);

    const detail = await expectAudited(
      () => tenantDetail.call(rt(), ctx, { operatorId: a.operatorId }),
      "admin.tenant_viewed",
    );
    if (!detail.ok) throw new Error(detail.error.code);
    expect(detail.value.counts.customers).toEqual({ active: 1, inactive: 0 });
    expect(detail.value.counts.users).toEqual({ owner: 1, staff: 1, lineman: 1 });
    expect(detail.value.billingRuns[0]).toMatchObject({ createdCount: 2, failedCount: 1 });
    expect(detail.value.latestInvariantCheck).toMatchObject({
      status: "breach",
      counts: { BALANCE_MISMATCH: 1 },
    });
    expect(detail.value.failedJobs).toBe(1);
    outputs.push(detail.value);

    const metrics = await expectAudited(
      () => platformMetrics.call(rt(), ctx, {}),
      "admin.metrics_viewed",
    );
    if (!metrics.ok) throw new Error(metrics.error.code);
    expect(metrics.value.period).toBe("2026-11-01");
    expect(metrics.value.billing).toMatchObject({
      billed: 2,
      failed: 1,
      successRate: 66.7,
      failedByReason: { balance_mismatch: 1 },
    });
    expect(metrics.value.books.tenantsWithBreach).toBeGreaterThanOrEqual(1);
    expect(metrics.value.notMeasured).toEqual(["migration_exceptions"]);
    outputs.push(metrics.value);

    const runs = await expectAudited(
      () => listBillingRuns.call(rt(), ctx, { period: "2026-11-01" }),
      "admin.billing_runs_viewed",
    );
    if (!runs.ok) throw new Error(runs.error.code);
    expect(runs.value.find((r) => r.operatorId === a.operatorId)?.failedReasons).toEqual({
      balance_mismatch: 1,
    });
    outputs.push(runs.value);

    const jobs = await expectAudited(
      () => listJobs.call(rt(), ctx, { status: "failed" }),
      "admin.jobs_viewed",
    );
    if (!jobs.ok) throw new Error(jobs.error.code);
    expect(jobs.value.rows.map((j) => j.jobId)).toContain(failedJobId);
    outputs.push(jobs.value);

    const events = await expectAudited(
      () => listRazorpayEvents.call(rt(), ctx, {}),
      "admin.razorpay_events_viewed",
    );
    if (!events.ok) throw new Error(events.error.code);
    expect(events.value.rows.some((e) => e.operatorId === a.operatorId)).toBe(true);
    outputs.push(events.value);

    const audit = await expectAudited(
      () => listPlatformAudit.call(rt(), ctx, { hideViews: false }),
      "admin.audit_viewed",
    );
    if (!audit.ok) throw new Error(audit.error.code);
    expect(audit.value.rows.some((r) => r.action === "admin.tenants_listed")).toBe(true);
    const hidden = await listPlatformAudit.call(rt(), ctx, {});
    if (!hidden.ok) throw new Error(hidden.error.code);
    expect(hidden.value.rows.some((r) => r.action.endsWith("_viewed"))).toBe(false);
    outputs.push(audit.value);

    const text = JSON.stringify(outputs);
    for (const secret of SECRETS) expect(text, secret).not.toContain(secret);
  });

  it("unknown tenants are NOT_FOUND; bad input is VALIDATION", async () => {
    const missing = "0193a000-0000-7000-8000-00000000abcd";
    expect(await tenantDetail.call(rt(), ctx, { operatorId: missing })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(await tenantDetail.call(rt(), ctx, { operatorId: "x" })).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" },
    });
    expect(
      await extendSubscription.call(rt(), ctx, {
        operatorId: missing,
        lastDay: "2026-12-31",
        reason: "Paid by cheque",
      }),
    ).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("extend: trialing → active through the last day, audited for the tenant and the platform", async () => {
    const result = await expectAudited(
      () =>
        extendSubscription.call(rt(), ctx, {
          operatorId: b.operatorId,
          lastDay: "2026-12-31",
          reason: "Migrated operator, paid till year end",
        }),
      "admin.subscription_extended",
    );
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({
      changed: true,
      status: "active",
      currentPeriodEnd: new Date("2026-12-31T18:30:00Z"),
    });
    const tenantEvents = await t.current.db.withTenant(b.operatorId, async (tx) => {
      const { auditEvents } = await import("@cb/db");
      return tx
        .select({
          action: auditEvents.action,
          role: auditEvents.actorRole,
          after: auditEvents.after,
        })
        .from(auditEvents);
    });
    const changed = tenantEvents.find((e) => e.action === "subscription.state_changed");
    expect(changed?.role).toBe("platform_admin");
    expect(changed?.after).toMatchObject({ source: "admin_extend", status: "active" });
    for (const lastDay of ["2026-11-01", "2029-01-01", "2026-13-01"]) {
      const bad = await extendSubscription.call(rt(), ctx, {
        operatorId: b.operatorId,
        lastDay,
        reason: "Some reason",
      });
      expect(bad, lastDay).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    }
  });

  it("offline payment: a money record, extends from the right day, idempotent, audited", async () => {
    const c = await seedTenant(t.current, { subscription: "read_only" });
    const paymentId = uuidv7();
    const input = {
      operatorId: c.operatorId,
      paymentId,
      amountPaise: 47_200,
      method: "bank_transfer" as const,
      reference: "UTR 998877",
      receivedOn: "2026-11-01",
      months: 1,
    };
    const first = await expectAudited(
      () => recordOfflinePayment.call(rt(), ctx, input),
      "admin.offline_payment_recorded",
    );
    if (!first.ok) throw new Error(first.error.code);
    // Paid from the next IST midnight (3 Nov) for one month: through 2 Dec.
    expect(first.value).toMatchObject({
      status: "recorded",
      paidUntil: new Date("2026-12-02T18:30:00Z"),
    });
    const again = await recordOfflinePayment.call(rt(), ctx, input);
    expect(again).toMatchObject({ ok: true, value: { status: "already_recorded" } });
    const stored = await t.current.admin.query(
      "SELECT amount_paise, method, months, recorded_by FROM subscription_offline_payments WHERE operator_id = $1",
      [c.operatorId],
    );
    expect(stored.rows).toEqual([
      { amount_paise: "47200", method: "bank_transfer", months: 1, recorded_by: adminId },
    ]);
    const sub = await t.current.admin.query(
      "SELECT status, current_period_end FROM subscriptions WHERE operator_id = $1",
      [c.operatorId],
    );
    expect(sub.rows[0]).toMatchObject({ status: "active" });
    const tenantActions = await t.current.db.withTenant(c.operatorId, async (tx) => {
      const { auditEvents } = await import("@cb/db");
      return (await tx.select({ action: auditEvents.action }).from(auditEvents)).map(
        (e) => e.action,
      );
    });
    expect(tenantActions).toEqual(
      expect.arrayContaining([
        "subscription.state_changed",
        "subscription.offline_payment_recorded",
      ]),
    );

    // A trialing tenant pays from the end of the trial (00:00 IST 13 Nov) for two months.
    const d = await seedTenant(t.current, { subscription: "trialing" });
    await t.current.admin.query(
      "UPDATE subscriptions SET trial_ends_at = '2026-11-12T18:30:00Z' WHERE operator_id = $1",
      [d.operatorId],
    );
    const trial = await recordOfflinePayment.call(rt(), ctx, {
      ...input,
      operatorId: d.operatorId,
      paymentId: uuidv7(),
      months: 2,
    });
    expect(trial).toMatchObject({
      ok: true,
      value: { paidUntil: new Date("2027-01-12T18:30:00Z") },
    });

    for (const bad of [
      { amountPaise: 0 },
      { amountPaise: 12.5 },
      { months: 13 },
      { receivedOn: "2026-11-03" },
      { method: "card" },
    ]) {
      const result = await recordOfflinePayment.call(rt(), ctx, {
        ...input,
        paymentId: uuidv7(),
        ...bad,
      } as never);
      expect(result, JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" },
      });
    }
  });

  it("job retry: a failed job becomes a new queued job, once", async () => {
    const retried = await expectAudited(
      () => retryJob.call(rt(), ctx, { jobId: failedJobId }),
      "admin.job_retried",
    );
    if (!retried.ok) throw new Error(retried.error.code);
    const rows = await t.current.admin.query<{ id: string; status: string; payload: unknown }>(
      "SELECT id, status, payload FROM jobs WHERE id = ANY($1) ORDER BY id",
      [[failedJobId, retried.value.newJobId]],
    );
    expect(rows.rows.map((r) => r.status)).toEqual(["failed", "queued"]);
    expect(rows.rows[1]?.payload).toEqual(rows.rows[0]?.payload);
    expect(await retryJob.call(rt(), ctx, { jobId: failedJobId })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", details: { reason: "already_queued" } },
    });
    expect(await retryJob.call(rt(), ctx, { jobId: retried.value.newJobId })).toMatchObject({
      ok: false,
      error: { code: "CONFLICT", details: { reason: "not_failed" } },
    });
    expect(await retryJob.call(rt(), ctx, { jobId: uuidv7() })).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("create tenant: provisionTenant with the admin as actor, idempotent on the form id", async () => {
    const operatorId = uuidv7();
    const input = {
      operatorId,
      businessName: "Admin Made Cable",
      ownerName: "Mohan Lal",
      ownerEmail: `mohan.${operatorId.slice(-8)}@cable.test`,
      ownerMobile: `98${operatorId.replace(/\D/g, "").slice(-8)}`,
      language: "hi" as const,
    };
    const created = await expectAudited(
      () => createTenantByAdmin.call(rt(), ctx, input),
      "admin.tenant_created",
    );
    expect(created).toMatchObject({ ok: true, value: { status: "created", operatorId } });
    const again = await createTenantByAdmin.call(rt(), ctx, input);
    expect(again).toMatchObject({ ok: true, value: { status: "already_provisioned" } });
    const provisioned = await t.current.admin.query(
      "SELECT actor_id, actor_role FROM audit_events WHERE operator_id = $1 AND action = 'tenant.provisioned'",
      [operatorId],
    );
    expect(provisioned.rows).toEqual([{ actor_id: adminId, actor_role: "platform_admin" }]);
    const sub = await t.current.admin.query(
      "SELECT status FROM subscriptions WHERE operator_id = $1",
      [operatorId],
    );
    expect(sub.rows).toEqual([{ status: "trialing" }]);
  });
});
