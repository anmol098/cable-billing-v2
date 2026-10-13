/**
 * The job queue table (T-023; T-043 builds the worker): the platform path may enqueue, claim and
 * update every job but delete none; tenants see only their own jobs; dedupe among live jobs;
 * claiming with `FOR UPDATE SKIP LOCKED` never hands one job to two workers; an expired lease is
 * claimable again.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import type { Tx } from "../tenant";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { sqlStateOf } from "../triggers";
import { jobs } from "./jobs";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

const constraintOf = (e: unknown): string | undefined => {
  let current: unknown = e;
  for (let i = 0; i < 5 && current && typeof current === "object"; i += 1) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === "string") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};
const violates = (code: string, constraint: string) => (e: unknown) =>
  sqlStateOf(e) === code && constraintOf(e) === constraint;

/** The claim statement documented in jobs.ts (what T-043's worker runs). */
async function claim(tx: Tx, worker: string, limit: number, type: string): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ${worker},
           locked_until = now() + interval '5 minutes', started_at = now(), updated_at = now()
     WHERE id IN (SELECT id FROM jobs
                   WHERE type = ${type}
                     AND ((status = 'queued' AND run_after <= now())
                       OR (status = 'running' AND locked_until < now() AND attempts < max_attempts))
                   ORDER BY run_after, id
                   LIMIT ${limit}
                   FOR UPDATE SKIP LOCKED)
    RETURNING id`);
  return result.rows.map((r) => r.id);
}

describeDb("jobs", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;

  const enqueue = (values: Partial<typeof jobs.$inferInsert>) =>
    t.current.db.withPlatform((tx) =>
      tx
        .insert(jobs)
        .values({ id: uuidv7(), type: "billing.run_batch", ...values })
        .onConflictDoNothing()
        .returning(),
    );

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  it("the platform path enqueues; defaults; tenants see only their own jobs", async () => {
    const [job] = await enqueue({ operatorId: a.operatorId, payload: { period: "2026-10-01" } });
    expect(job).toMatchObject({ status: "queued", attempts: 0, maxAttempts: 5, lockedUntil: null });
    const [platformJob] = await enqueue({ type: "billing.schedule" });
    const seenByA = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select({ id: jobs.id }).from(jobs),
    );
    expect(seenByA.map((r) => r.id)).toContain(job?.id);
    expect(seenByA.map((r) => r.id)).not.toContain(platformJob?.id);
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) => tx.select().from(jobs));
    expect(seenByB).toEqual([]);
    // A tenant may enqueue its own job (e.g. "Run now"), not another tenant's or a platform one.
    await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.insert(jobs).values({ id: uuidv7(), operatorId: b.operatorId, type: "billing.run" }),
    );
    for (const operatorId of [a.operatorId, null]) {
      await expect(
        t.current.db.withTenant(b.operatorId, (tx) =>
          tx.insert(jobs).values({ id: uuidv7(), operatorId, type: "billing.run" }),
        ),
      ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === RLS_VIOLATION);
    }
  });

  it("the platform path can't delete jobs", async () => {
    const [job] = await enqueue({ operatorId: a.operatorId });
    const deleted = await t.current.db.withPlatform((tx) =>
      tx
        .delete(jobs)
        .where(eq(jobs.id, job?.id ?? ""))
        .returning(),
    );
    expect(deleted).toEqual([]);
  });

  it("dedupe: one live job per tenant and key; finished jobs don't block; keys are per tenant", async () => {
    const key = "billing_run:2026-10-01";
    const [first] = await enqueue({ operatorId: a.operatorId, dedupeKey: key });
    expect(first).toBeDefined();
    expect(await enqueue({ operatorId: a.operatorId, dedupeKey: key })).toEqual([]);
    await expect(
      t.current.db.withPlatform((tx) =>
        tx.insert(jobs).values({
          id: uuidv7(),
          operatorId: a.operatorId,
          type: "billing.run_batch",
          dedupeKey: key,
        }),
      ),
    ).rejects.toSatisfy(violates(UNIQUE_VIOLATION, "jobs_dedupe_live_unique"));
    expect(await enqueue({ operatorId: b.operatorId, dedupeKey: key })).toHaveLength(1);
    expect(await enqueue({ dedupeKey: key })).toHaveLength(1);
    expect(await enqueue({ dedupeKey: key })).toEqual([]); // platform jobs dedupe too
    await t.current.db.withPlatform((tx) =>
      tx
        .update(jobs)
        .set({ status: "succeeded", finishedAt: new Date() })
        .where(eq(jobs.id, first?.id ?? "")),
    );
    expect(await enqueue({ operatorId: a.operatorId, dedupeKey: key })).toHaveLength(1);
  });

  it("checks type, payload, attempts, lease and finish columns", async () => {
    const cases: Array<[Partial<typeof jobs.$inferInsert>, string]> = [
      [{ type: "Billing Run" }, "jobs_type_format"],
      [{ type: "billing." }, "jobs_type_format"],
      [{ payload: sql`'[]'::jsonb` as unknown as Record<string, unknown> }, "jobs_payload_object"],
      [{ attempts: 6 }, "jobs_attempts_range"],
      [{ maxAttempts: 0, attempts: 0 }, "jobs_attempts_range"],
      [{ status: "running" }, "jobs_running_has_lease"],
      [{ status: "failed" }, "jobs_finished_iff_done"],
      [{ finishedAt: new Date() }, "jobs_finished_iff_done"],
      [{ dedupeKey: " " }, "jobs_dedupe_key_not_blank"],
    ];
    for (const [values, constraint] of cases) {
      await expect(
        t.current.db.withPlatform((tx) =>
          tx.insert(jobs).values({ id: uuidv7(), type: "billing.run_batch", ...values }),
        ),
        JSON.stringify(values),
      ).rejects.toSatisfy(violates(CHECK_VIOLATION, constraint));
    }
  });

  it("two concurrent workers never claim the same job (FOR UPDATE SKIP LOCKED)", async () => {
    const type = "test.claim_concurrency";
    const ids = Array.from({ length: 20 }, () => uuidv7());
    await t.current.db.withPlatform((tx) =>
      tx.insert(jobs).values(ids.map((id) => ({ id, type, operatorId: a.operatorId }))),
    );
    const worker = (name: string) =>
      t.current.db.withPlatform(async (tx) => {
        const claimed = await claim(tx, name, 6, type);
        await tx.execute(sql`select pg_sleep(0.1)`); // hold the row locks while others claim
        return claimed;
      });
    const results = await Promise.all(["w1", "w2", "w3", "w4"].map(worker));
    const all = results.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(20);
    expect(results.every((r) => r.length > 0)).toBe(true);
    const rows = await t.current.db.withPlatform((tx) =>
      tx.select().from(jobs).where(inArray(jobs.id, ids)),
    );
    expect(rows.every((r) => r.status === "running" && r.attempts === 1)).toBe(true);
  });

  it("a job whose lease expired is claimed again by the next invocation", async () => {
    const type = "test.lease";
    const [job] = await enqueue({ type });
    const first = await t.current.db.withPlatform((tx) => claim(tx, "w1", 1, type));
    expect(first).toEqual([job?.id]);
    // Still leased: nobody else gets it.
    expect(await t.current.db.withPlatform((tx) => claim(tx, "w2", 1, type))).toEqual([]);
    // The worker ran out of time; its lease passes.
    await t.current.db.withPlatform((tx) =>
      tx
        .update(jobs)
        .set({ lockedUntil: sql`now() - interval '1 second'` })
        .where(eq(jobs.id, job?.id ?? "")),
    );
    expect(await t.current.db.withPlatform((tx) => claim(tx, "w2", 1, type))).toEqual([job?.id]);
    const [row] = await t.current.db.withPlatform((tx) =>
      tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, job?.id ?? "")),
    );
    expect(row).toMatchObject({ attempts: 2, lockedBy: "w2", status: "running" });
    // Backoff: back to queued with a later run_after → not claimable until then.
    await t.current.db.withPlatform((tx) =>
      tx
        .update(jobs)
        .set({
          status: "queued",
          runAfter: sql`now() + interval '1 hour'`,
          lockedUntil: null,
          lastError: "timeout",
        })
        .where(eq(jobs.id, job?.id ?? "")),
    );
    expect(await t.current.db.withPlatform((tx) => claim(tx, "w3", 1, type))).toEqual([]);
  });
});
