/**
 * The nightly `invariants.check` job through the real worker (T-052, PLAN §14): enqueue dedupe,
 * one stored result per tenant and run, a clean night succeeds quietly, a breach fails the job
 * and raises the T-043 job-failure alert (platform admins only, ids and counts only), the run
 * yields and resumes across worker invocations, and a tenant whose check errors makes the run
 * incomplete (alerted) instead of silently passing.
 */
import { createUser, describeDb, useTestDatabase } from "@cb/db/testing";
import { expect, it } from "vitest";
import {
  createJobFailureNotifier,
  createRecordingEmailTransport,
  type JobFailureEvent,
} from "../jobs/alerts";
import type { JobFailure } from "../jobs/failure";
import { createJobRegistry } from "../jobs/registry";
import { runJobWorker } from "../jobs/worker";
import { captureLogs } from "../testing/fixtures";
import {
  createInvariantsCheckJob,
  enqueueInvariantsCheck,
  INVARIANTS_CHECK_DEDUPE_KEY,
  invariantsCheckJob,
} from "./job";
import { type HealthyBooks, seedHealthyBooks } from "./test-support";

const NOW = new Date("2026-11-10T21:00:00.000Z");

describeDb("invariants.check job", () => {
  const t = useTestDatabase();
  const q = (text: string, params: unknown[] = []) => t.current.admin.query(text, params);
  const tenants: HealthyBooks[] = [];

  interface StoredCheck {
    operator_id: string;
    run_id: string;
    status: string;
    violation_count: number;
    counts: Record<string, number>;
    samples: Array<Record<string, unknown>>;
    checked_at: Date;
  }
  const checksOf = async (runId: string) =>
    (
      await q(
        `SELECT operator_id, run_id, status, violation_count, counts, samples, checked_at
           FROM invariant_checks WHERE run_id = $1 ORDER BY operator_id`,
        [runId],
      )
    ).rows as StoredCheck[];

  async function work(
    options: {
      clock?: () => Date;
      job?: ReturnType<typeof createInvariantsCheckJob>;
      onFailure?: (f: JobFailure) => Promise<unknown> | unknown;
    } = {},
  ) {
    const logs = captureLogs();
    const report = await runJobWorker({
      db: t.current.db,
      registry: createJobRegistry([options.job ?? invariantsCheckJob]),
      logger: logs.logger,
      clock: options.clock ?? (() => NOW),
      ...(options.onFailure ? { onFailure: options.onFailure } : {}),
    });
    return { report, records: logs.records };
  }

  it("enqueue is deduped; a clean night stores ok for every tenant and succeeds", async () => {
    tenants.push(await seedHealthyBooks(t.current, NOW), await seedHealthyBooks(t.current, NOW));
    const first = await enqueueInvariantsCheck(t.current.db);
    const second = await enqueueInvariantsCheck(t.current.db);
    expect(first.created).toBe(true);
    expect(second).toEqual({ jobId: first.jobId, created: false });
    const failures: JobFailure[] = [];
    const { report, records } = await work({ onFailure: (f) => failures.push(f) });
    expect(report).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(failures).toEqual([]);
    const stored = await checksOf(first.jobId);
    expect(stored.map((s) => s.operator_id).sort()).toEqual(
      tenants.map((b) => b.operatorId).sort(),
    );
    for (const s of stored) {
      expect(s).toMatchObject({ status: "ok", violation_count: 0, counts: {}, samples: [] });
      expect(s.checked_at.toISOString()).toBe(NOW.toISOString());
    }
    expect(records.find((r) => r.event === "invariants.finished")).toMatchObject({
      level: "info",
      outcome: "ok",
      tenants_checked: 2,
      breached_tenants: 0,
      run_id: first.jobId,
    });
    expect(records.some((r) => r.event === "invariants.breach")).toBe(false);
    const { rows } = await q("SELECT status, dedupe_key FROM jobs WHERE id = $1", [first.jobId]);
    expect(rows[0]).toEqual({ status: "succeeded", dedupe_key: INVARIANTS_CHECK_DEDUPE_KEY });
  }, 120_000);

  it("a breach is stored, logged without PII, fails the job and alerts the platform admins only", async () => {
    const [a, b] = tenants as [HealthyBooks, HealthyBooks];
    // People who could be emailed: a platform admin, and both tenants' owners.
    const admin = await createUser(t.current, { operatorId: null, login: "invariants_admin" });
    await q("UPDATE users SET email = 'admin@example.test' WHERE id = $1", [admin.userId]);
    await q("UPDATE users SET email = 'owner.a@example.test' WHERE id = $1", [
      a.tenant.users.owner,
    ]);
    await q("UPDATE users SET email = 'owner.b@example.test' WHERE id = $1", [
      b.tenant.users.owner,
    ]);
    await q(
      "UPDATE customer_balances SET balance_paise = balance_paise + 900 WHERE customer_id = $1",
      [a.partly.customerId],
    );
    const ledgerBefore = await q(
      "SELECT sum(amount_paise)::text AS total, count(*)::int AS n FROM ledger_entries",
    );

    const { jobId } = await enqueueInvariantsCheck(t.current.db);
    const transport = createRecordingEmailTransport();
    const captured: JobFailureEvent[] = [];
    const alertLogs = captureLogs();
    const notify = createJobFailureNotifier({
      db: t.current.db,
      transport,
      logger: alertLogs.logger,
      render: (args) => ({
        subject: `${args.audience}:${args.failure.type}`,
        text: args.failure.lastError,
      }),
      capture: (event) => captured.push(event),
    });
    const { report, records } = await work({ onFailure: notify });
    expect(report).toMatchObject({ claimed: 1, succeeded: 0, failed: 1 });

    // Stored: A breached (ids and amounts), B ok.
    const stored = await checksOf(jobId);
    const ofA = stored.find((s) => s.operator_id === a.operatorId);
    const ofB = stored.find((s) => s.operator_id === b.operatorId);
    expect(ofA).toMatchObject({
      status: "breach",
      violation_count: 1,
      counts: { BALANCE_MISMATCH: 1 },
      samples: [
        {
          code: "BALANCE_MISMATCH",
          entityType: "customer",
          entityId: a.partly.customerId,
          customerId: a.partly.customerId,
          details: { ledgerPaise: 30_000, storedPaise: 30_900 },
        },
      ],
    });
    expect(ofB).toMatchObject({ status: "ok", violation_count: 0 });

    // Logged: the tenant id and counts, at error level; never the other tenant.
    const breaches = records.filter((r) => r.event === "invariants.breach");
    expect(breaches).toEqual([
      expect.objectContaining({
        level: "error",
        operator_id: a.operatorId,
        run_id: jobId,
        violation_count: 1,
        counts: { BALANCE_MISMATCH: 1 },
      }),
    ]);
    expect(records.find((r) => r.event === "invariants.finished")).toMatchObject({
      level: "error",
      outcome: "breach",
      tenants_checked: 2,
      breached_tenants: 1,
      violation_count: 1,
    });

    // The job failed permanently with the breach code → the T-043 alert went to the admin only.
    const { rows } = await q("SELECT status, last_error, attempts FROM jobs WHERE id = $1", [
      jobId,
    ]);
    expect(rows[0]).toEqual({
      status: "failed",
      last_error: "permanent: invariant_breach",
      attempts: 1,
    });
    expect(transport.sent.map((m) => m.to)).toEqual(["admin@example.test"]);
    expect(transport.sent[0]?.subject).toBe("platform_admin:invariants.check");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.tags).toMatchObject({ job_type: "invariants.check" });

    // Read-only on the books.
    expect(
      (await q("SELECT sum(amount_paise)::text AS total, count(*)::int AS n FROM ledger_entries"))
        .rows,
    ).toEqual(ledgerBefore.rows);
    const { rows: balance } = await q(
      "SELECT balance_paise::int AS b FROM customer_balances WHERE customer_id = $1",
      [a.partly.customerId],
    );
    expect(balance[0]).toEqual({ b: 30_900 });
  }, 120_000);

  it("yields when the worker's time is nearly up and resumes from its cursor", async () => {
    tenants.push(await seedHealthyBooks(t.current, NOW));
    const { jobId } = await enqueueInvariantsCheck(t.current.db);
    // A clock that moves 25 s on every read: one tenant fits in each 240 s invocation.
    let ms = NOW.getTime();
    const clock = () => {
      ms += 25_000;
      return new Date(ms);
    };
    let continued = 0;
    const failures: JobFailure[] = [];
    const logged: Array<Record<string, unknown>> = [];
    for (let invocation = 0; invocation < 20; invocation += 1) {
      const { report, records } = await work({ clock, onFailure: (f) => failures.push(f) });
      logged.push(...records);
      continued += report.continued;
      if (report.claimed === 0) break;
    }
    // Three tenants, one per invocation: two pauses, then the last slice finishes.
    expect(continued).toBe(2);
    expect(logged.filter((r) => r.event === "invariants.paused")).toHaveLength(2);
    const stored = await checksOf(jobId);
    // Every tenant checked exactly once in this run (UNIQUE per run), A still breached.
    expect(stored.map((s) => s.operator_id).sort()).toEqual(
      tenants.map((b) => b.operatorId).sort(),
    );
    expect(stored.filter((s) => s.status === "breach").map((s) => s.operator_id)).toEqual([
      tenants[0]?.operatorId,
    ]);
    // The totals were carried across the pauses (payload) into the final summary.
    expect(logged.find((r) => r.event === "invariants.finished")).toMatchObject({
      outcome: "breach",
      tenants_checked: 3,
      breached_tenants: 1,
      failed_tenants: 0,
      violation_count: 1,
    });
    const { rows } = await q("SELECT status, last_error, payload FROM jobs WHERE id = $1", [jobId]);
    expect(rows[0]).toMatchObject({
      status: "failed",
      last_error: "permanent: invariant_breach",
      // The last saved payload: the cursor and totals after two of the three tenants.
      payload: { cursor: tenants[1]?.operatorId, tenantsChecked: 2 },
    });
    expect(failures).toHaveLength(1);
  }, 120_000);

  it("a tenant whose check errors makes the run incomplete, and that is alerted too", async () => {
    // Broken settings make every tenant's check throw before it reads anything.
    const broken = createInvariantsCheckJob({ sampleLimit: -1 });
    const { jobId } = await enqueueInvariantsCheck(t.current.db);
    const failures: JobFailure[] = [];
    const { report, records } = await work({ job: broken, onFailure: (f) => failures.push(f) });
    expect(report).toMatchObject({ claimed: 1, failed: 1 });
    expect(failures).toEqual([
      expect.objectContaining({
        jobId,
        type: "invariants.check",
        operatorId: null,
        reason: "permanent",
        lastError: "permanent: invariant_check_incomplete",
        notifyOwner: false,
      }),
    ]);
    const failed = records.filter((r) => r.event === "invariants.tenant_check_failed");
    expect(failed.map((r) => r.operator_id).sort()).toEqual(
      tenants.map((b) => b.operatorId).sort(),
    );
    expect(await checksOf(jobId)).toEqual([]);
  }, 120_000);
});
