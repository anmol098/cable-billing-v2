/**
 * The worker loop against Postgres, with a controllable clock (no real sleeps): concurrent
 * workers, time budget, cooperative resume, lease-expiry resume, retry with backoff, max attempts →
 * failed + alert, permanent failures, job contexts (tenant binding, system audit, fan-out).
 */
import { areas, auditEvents, type DbClient, jobs, uuidv7 } from "@cb/db";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "@cb/db/testing";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { captureLogs } from "../testing/fixtures";
import { type AnyJobDefinition, continueLater, defineJob, PermanentJobError } from "./definition";
import type { JobFailure } from "./failure";
import { claimJobs, enqueueJob, LEASE_EXPIRED_ERROR } from "./queue";
import { createJobRegistry } from "./registry";
import { type JobWorkerOptions, runJobWorker } from "./worker";

/** A clock that only moves when told to. Starts just after real time (DB defaults use now()). */
function fakeClock() {
  let t = Date.now() + 1_000;
  return {
    clock: () => new Date(t),
    advance(ms: number) {
      t += ms;
    },
    get ms() {
      return t;
    },
  };
}

const empty = z.object({});

describeDb("job worker", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  const db = (): DbClient => t.current.db;
  const jobRow = async (id: string) => {
    const [r] = await db().withPlatform((tx) => tx.select().from(jobs).where(eq(jobs.id, id)));
    if (!r) throw new Error("job not found");
    return r;
  };
  /** Enqueue on the platform path (a type string skips payload validation, for bad-input tests). */
  const enqueueFor = (
    operatorId: string | null,
    job: AnyJobDefinition | string,
    payload: Record<string, unknown> = {},
  ) => db().withPlatform((tx) => enqueueJob(tx, job, payload, { operatorId }));

  /** runJobWorker with a strict captured logger (a PII log fails the test). */
  const work = (options: Omit<JobWorkerOptions, "db">) => {
    const logs = captureLogs();
    return runJobWorker({ db: db(), logger: logs.logger, ...options }).then((report) => ({
      report,
      records: logs.records,
    }));
  };

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  it("two concurrent workers never process the same job", async () => {
    const processed = new Map<string, number>();
    const job = defineJob({
      type: "tests.concurrent",
      scope: "tenant",
      payload: z.object({ n: z.number() }),
      async run(ctx) {
        processed.set(ctx.job.id, (processed.get(ctx.job.id) ?? 0) + 1);
        // Interleave with the other workers (real I/O, not a timing assumption).
        await ctx.withTenant((tx) => tx.execute(sql`select pg_sleep(0.01)`));
      },
    });
    const ids: string[] = [];
    for (let n = 0; n < 30; n += 1) {
      ids.push((await enqueueFor(n % 2 ? a.operatorId : b.operatorId, job.type, { n })).jobId);
    }
    const registry = createJobRegistry([job]);
    const results = await Promise.all(
      ["w1", "w2", "w3"].map((workerId) => work({ registry, workerId })),
    );
    expect([...processed.values()].every((count) => count === 1)).toBe(true);
    expect([...processed.keys()].sort()).toEqual([...ids].sort());
    expect(results.reduce((sum, r) => sum + r.report.succeeded, 0)).toBe(30);
    expect(results.every((r) => r.report.leaseLost === 0)).toBe(true);
    for (const id of ids) expect((await jobRow(id)).status).toBe("succeeded");
  }, 60_000);

  it("stops claiming when the time budget is nearly used up; the next invocation continues", async () => {
    const c = fakeClock();
    const done: number[] = [];
    const job = defineJob({
      type: "tests.budget",
      scope: "platform",
      payload: z.object({ n: z.number() }),
      async run({ payload }) {
        c.advance(100_000); // each job takes 100 s
        done.push(payload.n);
      },
    });
    for (let n = 0; n < 5; n += 1) await enqueueFor(null, job.type, { n });
    const registry = createJobRegistry([job]);
    const options = { registry, clock: c.clock, budgetMs: 240_000, yieldReserveMs: 30_000 };
    const first = await work(options);
    // 0 s, 100 s and 200 s left ≥ 30 s → three claims; at 300 s the budget is gone.
    expect(first.report).toMatchObject({ claimed: 3, succeeded: 3, stoppedBy: "budget" });
    const second = await work(options);
    expect(second.report).toMatchObject({ claimed: 2, succeeded: 2, stoppedBy: "queue_empty" });
    expect(done).toEqual([0, 1, 2, 3, 4]);
  });

  it("a handler that yields at the budget is resumed by the next invocation (no attempt used)", async () => {
    const c = fakeClock();
    const items: number[] = [];
    const job = defineJob({
      type: "tests.resumable",
      scope: "tenant",
      payload: z.object({ cursor: z.number().int().min(0) }),
      async run({ payload, shouldYield }) {
        for (let i = payload.cursor; i < 10; i += 1) {
          if (shouldYield()) return continueLater({ payload: { cursor: i } });
          c.advance(50_000); // one item takes 50 s
          items.push(i);
        }
        return undefined;
      },
    });
    const { jobId } = await enqueueFor(a.operatorId, job.type, { cursor: 0 });
    const registry = createJobRegistry([job]);
    const options = { registry, clock: c.clock, budgetMs: 240_000, yieldReserveMs: 30_000 };

    const first = await work(options);
    expect(first.report).toMatchObject({ claimed: 1, continued: 1, stoppedBy: "budget" });
    expect(items).toEqual([0, 1, 2, 3, 4]);
    expect(await jobRow(jobId)).toMatchObject({
      status: "queued",
      attempts: 0,
      payload: { cursor: 5 },
      lockedUntil: null,
    });

    const second = await work(options);
    expect(second.report).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(items).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await jobRow(jobId)).toMatchObject({ status: "succeeded", attempts: 1 });
  });

  it("a job whose run exceeded the function's time (lease held) is resumed after the lease expires", async () => {
    const c = fakeClock();
    const attemptsSeen: number[] = [];
    const job = defineJob({
      type: "tests.killed",
      scope: "tenant",
      payload: empty,
      async run({ job: info }) {
        attemptsSeen.push(info.attempt);
      },
    });
    const { jobId } = await enqueueFor(a.operatorId, job.type);
    // A previous invocation claimed it and was killed mid-run (no outcome recorded).
    const [orphan] = await claimJobs(db(), {
      workerId: "killed-worker",
      types: [job.type],
      now: c.clock(),
      leaseMs: 300_000,
    });
    expect(orphan?.id).toBe(jobId);
    const registry = createJobRegistry([job]);
    c.advance(120_000); // the next cron tick: the lease still holds
    expect((await work({ registry, clock: c.clock })).report.claimed).toBe(0);
    c.advance(240_000); // lease (300 s) has passed
    const { report } = await work({ registry, clock: c.clock });
    expect(report).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(attemptsSeen).toEqual([2]);
    expect(await jobRow(jobId)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("retries with exponential backoff + jitter, then fails at max attempts and alerts once", async () => {
    const c = fakeClock();
    const failures: JobFailure[] = [];
    const job = defineJob({
      type: "tests.flaky",
      scope: "tenant",
      payload: empty,
      maxAttempts: 3,
      async run() {
        throw new Error("upstream said no for 9876543210");
      },
    });
    const { jobId } = await db().withTenant(a.operatorId, (tx) => enqueueJob(tx, job, {}));
    const registry = createJobRegistry([job]);
    const options = {
      registry,
      clock: c.clock,
      backoff: { baseMs: 1_000, maxMs: 60_000, random: () => 0.5 },
      onFailure: (f: JobFailure) => {
        failures.push(f);
      },
    };

    // Attempt 1 fails → retry in 1000/2 + 0.5 × 500 = 750 ms.
    const first = await work(options);
    expect(first.report).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
    let row = await jobRow(jobId);
    expect(row).toMatchObject({ status: "queued", attempts: 1 });
    expect(row.runAfter.getTime()).toBe(c.ms + 750);
    expect(row.lastError).toMatch(/^Error: upstream said no for/);
    expect(row.lastError).not.toContain("9876543210");
    expect(first.records.find((r) => r.event === "job.retry_scheduled")).toMatchObject({
      retry_in_ms: 750,
      job_id: jobId,
      operator_id: a.operatorId,
    });

    c.advance(749);
    expect((await work(options)).report.claimed).toBe(0); // not due yet
    c.advance(1);
    // Attempt 2 fails → 2000/2 + 0.5 × 1000 = 1500 ms.
    expect((await work(options)).report.retried).toBe(1);
    row = await jobRow(jobId);
    expect(row.attempts).toBe(2);
    expect(row.runAfter.getTime()).toBe(c.ms + 1_500);

    c.advance(1_500);
    const last = await work(options);
    expect(last.report).toMatchObject({ claimed: 1, retried: 0, failed: 1 });
    row = await jobRow(jobId);
    expect(row).toMatchObject({ status: "failed", attempts: 3, lockedUntil: null });
    expect(row.finishedAt?.getTime()).toBe(c.ms);
    expect(failures).toEqual([
      expect.objectContaining({
        jobId,
        type: job.type,
        operatorId: a.operatorId,
        attempts: 3,
        maxAttempts: 3,
        reason: "max_attempts",
        notifyOwner: true,
      }),
    ]);
    expect(last.records.some((r) => r.event === "job.failed" && r.level === "error")).toBe(true);

    c.advance(3_600_000);
    expect((await work(options)).report.claimed).toBe(0); // failed jobs stay failed
    expect(failures).toHaveLength(1);
  });

  it("a PermanentJobError or an invalid payload fails at once (no retries)", async () => {
    const c = fakeClock();
    const failures: JobFailure[] = [];
    const job = defineJob({
      type: "tests.permanent",
      scope: "tenant",
      payload: z.object({ ok: z.boolean() }),
      async run({ payload }) {
        if (!payload.ok) throw new PermanentJobError("customer_gone");
      },
    });
    const bad = await enqueueFor(a.operatorId, job.type, { ok: false });
    const malformed = await enqueueFor(a.operatorId, job.type, { ok: "yes" });
    const wrongScope = await enqueueFor(null, job.type, { ok: true });
    const registry = createJobRegistry([job]);
    const { report } = await work({
      registry,
      clock: c.clock,
      onFailure: (f) => {
        failures.push(f);
      },
    });
    expect(report).toMatchObject({ claimed: 3, failed: 3, retried: 0 });
    expect(await jobRow(bad.jobId)).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "permanent: customer_gone",
    });
    expect((await jobRow(malformed.jobId)).lastError).toBe("permanent: invalid_payload");
    expect((await jobRow(wrongScope.jobId)).lastError).toBe("permanent: scope_mismatch");
    expect(failures.map((f) => f.reason)).toEqual(["permanent", "permanent", "permanent"]);
  });

  it("a last attempt that ran out of time is failed by the next invocation and alerted", async () => {
    const c = fakeClock();
    const failures: JobFailure[] = [];
    const job = defineJob({
      type: "tests.slow_last_attempt",
      scope: "tenant",
      payload: empty,
      maxAttempts: 1,
      notifyOwner: false,
      run: async () => undefined,
    });
    const { jobId } = await enqueueFor(b.operatorId, job); // the definition sets max_attempts = 1
    await claimJobs(db(), {
      workerId: "dead",
      types: [job.type],
      now: c.clock(),
      leaseMs: 300_000,
    });
    c.advance(301_000);
    const { report } = await work({
      registry: createJobRegistry([job]),
      clock: c.clock,
      onFailure: (f) => {
        failures.push(f);
      },
    });
    expect(report).toMatchObject({ claimed: 0, failed: 1 });
    expect(await jobRow(jobId)).toMatchObject({
      status: "failed",
      lastError: LEASE_EXPIRED_ERROR,
      lockedUntil: null,
    });
    expect(failures).toEqual([
      expect.objectContaining({
        jobId,
        reason: "lease_expired",
        operatorId: b.operatorId,
        notifyOwner: false,
      }),
    ]);
  });

  it("an alert hook that throws is logged and never breaks the worker", async () => {
    const job = defineJob({
      type: "tests.hook_throws",
      scope: "platform",
      payload: empty,
      maxAttempts: 1,
      async run() {
        throw new Error("nope");
      },
    });
    await enqueueFor(null, job);
    const { report, records } = await work({
      registry: createJobRegistry([job]),
      onFailure: () => {
        throw new Error("smtp down");
      },
    });
    expect(report.failed).toBe(1);
    expect(records.some((r) => r.event === "job.alert_hook_failed")).toBe(true);
  });

  it("only registered types are claimed; other jobs stay queued", async () => {
    const { jobId } = await enqueueFor(null, "tests.nobody_handles_this");
    const job = defineJob({
      type: "tests.someone",
      scope: "platform",
      payload: empty,
      run: async () => undefined,
    });
    await work({ registry: createJobRegistry([job]) });
    expect((await jobRow(jobId)).status).toBe("queued");
  });

  describe("job contexts", () => {
    it("a tenant job's transactions are bound to its own tenant; audit as the system", async () => {
      const seen: Array<{ operator: string | null; ownJobs: number; otherJobs: number }> = [];
      let areaId = "";
      const job = defineJob({
        type: "tests.tenant_ctx",
        scope: "tenant",
        payload: z.object({ name: z.string() }),
        async run(ctx) {
          expect(ctx.scope).toBe("tenant");
          if (ctx.scope !== "tenant") return;
          await ctx.withTenant(async (tx) => {
            const r = await tx.execute<{ operator: string | null }>(
              sql`select app.current_operator()::text as operator`,
            );
            const own = await tx
              .select({ id: jobs.id })
              .from(jobs)
              .where(eq(jobs.operatorId, a.operatorId));
            const other = await tx
              .select({ id: jobs.id })
              .from(jobs)
              .where(eq(jobs.operatorId, b.operatorId));
            seen.push({
              operator: r.rows[0]?.operator ?? null,
              ownJobs: own.length,
              otherJobs: other.length,
            });
            areaId = uuidv7();
            await tx
              .insert(areas)
              .values({ id: areaId, operatorId: ctx.operatorId, name: ctx.payload.name });
            await ctx.audit(tx, {
              action: "areas.created_by_job",
              entityType: "area",
              entityId: areaId,
              after: { name: ctx.payload.name },
            });
          });
        },
      });
      await enqueueFor(a.operatorId, job.type, { name: "North" });
      await enqueueFor(b.operatorId, "tests.unrelated");
      const { report } = await work({ registry: createJobRegistry([job]) });
      expect(report.succeeded).toBe(1);
      expect(seen).toEqual([{ operator: a.operatorId, ownJobs: expect.any(Number), otherJobs: 0 }]);
      expect(seen[0]?.ownJobs).toBeGreaterThan(0);
      const [event] = await db().withTenant(a.operatorId, (tx) =>
        tx.select().from(auditEvents).where(eq(auditEvents.entityId, areaId)),
      );
      expect(event).toMatchObject({
        operatorId: a.operatorId,
        actorId: null,
        actorRole: null,
        action: "areas.created_by_job",
      });
      expect(event?.requestId).toEqual(expect.any(String));
    });

    it("a platform job fans out tenant jobs that the same invocation then runs", async () => {
      const ran: string[] = [];
      const perTenant = defineJob({
        type: "tests.fan_out_child",
        scope: "tenant",
        payload: z.object({ period: z.string() }),
        async run(ctx) {
          if (ctx.scope === "tenant") ran.push(ctx.operatorId);
        },
      });
      const scheduler = defineJob({
        type: "tests.fan_out",
        scope: "platform",
        payload: z.object({ period: z.string() }),
        async run(ctx) {
          if (ctx.scope !== "platform") return;
          await ctx.db.withPlatform(async (tx) => {
            for (const operatorId of [a.operatorId, b.operatorId]) {
              await enqueueJob(
                tx,
                perTenant,
                { period: ctx.payload.period },
                {
                  operatorId,
                  dedupeKey: `tests.fan_out_child:${ctx.payload.period}`,
                },
              );
            }
          });
          await ctx.db.withPlatform((tx) =>
            ctx.audit(tx, {
              operatorId: null,
              action: "tests.fanned_out",
              entityType: "job",
              entityId: ctx.job.id,
            }),
          );
        },
      });
      await enqueueFor(null, scheduler.type, { period: "2026-10-01" });
      const { report } = await work({ registry: createJobRegistry([scheduler, perTenant]) });
      expect(report.succeeded).toBe(3);
      expect(ran.sort()).toEqual([a.operatorId, b.operatorId].sort());
    });
  });
});
