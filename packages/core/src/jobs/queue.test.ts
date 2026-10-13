/**
 * Queue operations against Postgres: enqueue (scope, payload, tenant from the transaction, RLS),
 * dedupe (incl. concurrent enqueues), claim concurrency, lease guard.
 */
import { jobs, sqlStateOf } from "@cb/db";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "@cb/db/testing";
import { eq, inArray } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { z } from "zod";
import { defineJob } from "./definition";
import { claimJobs, completeJob, enqueueJob, requeueJob } from "./queue";

const RLS_VIOLATION = "42501";

const tenantJob = defineJob({
  type: "tests.tenant_job",
  scope: "tenant",
  payload: z.object({ period: z.string() }),
  maxAttempts: 3,
  run: async () => undefined,
});
const platformJob = defineJob({
  type: "tests.platform_job",
  scope: "platform",
  payload: z.object({}),
  run: async () => undefined,
});

describeDb("job queue", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  const db = () => t.current.db;
  const row = async (id: string) => {
    const [r] = await db().withPlatform((tx) => tx.select().from(jobs).where(eq(jobs.id, id)));
    if (!r) throw new Error("job not found");
    return r;
  };

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  it("a tenant transaction enqueues for its own tenant by default; payload parsed and stored", async () => {
    const result = await db().withTenant(a.operatorId, (tx) =>
      enqueueJob(tx, tenantJob, { period: "2026-10-01", extra: "dropped" } as never),
    );
    expect(result.created).toBe(true);
    expect(await row(result.jobId)).toMatchObject({
      operatorId: a.operatorId,
      type: "tests.tenant_job",
      payload: { period: "2026-10-01" },
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
    });
  });

  it("refuses wrong scopes, bad payloads and another tenant's id", async () => {
    await expect(
      db().withPlatform((tx) => enqueueJob(tx, tenantJob, { period: "2026-10-01" })),
    ).rejects.toThrow(/needs an operatorId/);
    await expect(
      db().withPlatform((tx) => enqueueJob(tx, platformJob, {}, { operatorId: a.operatorId })),
    ).rejects.toThrow(/has no operatorId/);
    await expect(
      db().withTenant(a.operatorId, (tx) => enqueueJob(tx, tenantJob, { period: 1 } as never)),
    ).rejects.toThrow();
    await expect(db().withPlatform((tx) => enqueueJob(tx, "Bad Type", {}))).rejects.toThrow(
      TypeError,
    );
    // A tenant can't enqueue a platform job or a job for another tenant (RLS).
    await expect(
      db().withTenant(a.operatorId, (tx) => enqueueJob(tx, platformJob, {})),
    ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === RLS_VIOLATION);
    await expect(
      db().withTenant(a.operatorId, (tx) =>
        enqueueJob(tx, tenantJob, { period: "2026-10-01" }, { operatorId: b.operatorId }),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === RLS_VIOLATION);
  });

  it("dedupe: a live job with the same key is returned instead of a new one; per tenant", async () => {
    const opts = { dedupeKey: "tests.tenant_job:2026-11-01" };
    const first = await db().withTenant(a.operatorId, (tx) =>
      enqueueJob(tx, tenantJob, { period: "2026-11-01" }, opts),
    );
    const second = await db().withPlatform((tx) =>
      enqueueJob(tx, tenantJob, { period: "2026-11-01" }, { ...opts, operatorId: a.operatorId }),
    );
    expect(first.created).toBe(true);
    expect(second).toEqual({ jobId: first.jobId, created: false });
    const forB = await db().withTenant(b.operatorId, (tx) =>
      enqueueJob(tx, tenantJob, { period: "2026-11-01" }, opts),
    );
    expect(forB.created).toBe(true);
    // Platform jobs dedupe among themselves.
    const p1 = await db().withPlatform((tx) => enqueueJob(tx, platformJob, {}, opts));
    const p2 = await db().withPlatform((tx) => enqueueJob(tx, platformJob, {}, opts));
    expect(p1.created).toBe(true);
    expect(p2).toEqual({ jobId: p1.jobId, created: false });
    // Once the job finished, the same key enqueues a new job.
    await db().withPlatform((tx) =>
      tx
        .update(jobs)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(jobs.id, first.jobId)),
    );
    const third = await db().withTenant(a.operatorId, (tx) =>
      enqueueJob(tx, tenantJob, { period: "2026-11-01" }, opts),
    );
    expect(third.created).toBe(true);
    expect(third.jobId).not.toBe(first.jobId);
  });

  it("dedupe holds under 8 concurrent enqueues", async () => {
    const opts = { dedupeKey: "tests.tenant_job:concurrent", operatorId: a.operatorId };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        db().withPlatform((tx) => enqueueJob(tx, tenantJob, { period: "2026-12-01" }, opts)),
      ),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
  }, 30_000);

  it("concurrent claimers never get the same job; every job is claimed exactly once", async () => {
    const type = "tests.claim_race";
    const ids = await db().withPlatform(async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < 24; i += 1) {
        out.push((await enqueueJob(tx, type, { i }, { operatorId: a.operatorId })).jobId);
      }
      return out;
    });
    const now = new Date(Date.now() + 1_000);
    const claim = (worker: string) =>
      claimJobs(db(), { workerId: worker, types: [type], now, leaseMs: 60_000, limit: 3 });
    const rounds = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(`w${i}`)));
    const seen = rounds.flat().map((j) => j.id);
    expect(new Set(seen).size).toBe(seen.length);
    // Claim whatever the race left over; the union must be every job, each once.
    for (;;) {
      const more = await claim("sweeper");
      if (more.length === 0) break;
      seen.push(...more.map((j) => j.id));
    }
    expect(seen.sort()).toEqual([...ids].sort());
    const rows = await db().withPlatform((tx) =>
      tx.select().from(jobs).where(inArray(jobs.id, ids)),
    );
    expect(rows.every((r) => r.status === "running" && r.attempts === 1)).toBe(true);
  }, 30_000);

  it("claims only due jobs of the given types; completion is guarded by the lease", async () => {
    const type = "tests.guard";
    const start = new Date(Date.now() + 1_000);
    const { jobId } = await db().withPlatform((tx) =>
      enqueueJob(tx, type, {}, { runAfter: new Date(start.getTime() + 10_000) }),
    );
    const claim = (worker: string, now: Date) =>
      claimJobs(db(), { workerId: worker, types: [type], now, leaseMs: 60_000 });
    expect(await claim("w1", start)).toEqual([]); // not due
    expect(
      await claimJobs(db(), {
        workerId: "w1",
        types: ["tests.other"],
        now: new Date(start.getTime() + 20_000),
        leaseMs: 60_000,
      }),
    ).toEqual([]);
    const [mine] = await claim("w1", new Date(start.getTime() + 20_000));
    expect(mine?.id).toBe(jobId);
    if (!mine) return;
    // Lease expires; w2 resumes the job. w1's late outcome must not overwrite w2's run.
    const [theirs] = await claim("w2", new Date(start.getTime() + 90_000));
    expect(theirs).toMatchObject({ id: jobId, attempts: 2, lockedBy: "w2" });
    expect(await completeJob(db(), mine, new Date(start.getTime() + 91_000))).toBe(false);
    expect(
      await requeueJob(db(), mine, {
        now: new Date(start.getTime() + 91_000),
        runAfter: new Date(start.getTime() + 91_000),
        lastError: "late",
      }),
    ).toBe(false);
    expect(await row(jobId)).toMatchObject({ status: "running", lockedBy: "w2", lastError: null });
    if (!theirs) return;
    expect(await completeJob(db(), theirs, new Date(start.getTime() + 92_000))).toBe(true);
    expect(await row(jobId)).toMatchObject({ status: "succeeded", lockedUntil: null });
  });
});
