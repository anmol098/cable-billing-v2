/**
 * `sync_metrics.record_payment_batch` and the admin console's PRD §16 sync figures (T-086a),
 * against a real database with an injected clock:
 * - the counts per answer kind, deduplicated by payment id: a replayed batch (lost answer) adds
 *   duplicates but no new accepted or rejected id; a rejected id is counted once per tenant (also
 *   under concurrent replays); an id accepted after a refusal is counted once; `ID_REUSED` of a
 *   saved payment is not a new id; items without an id are counted apart;
 * - accepted / duplicate ids must be payments of the tenant (NOT_FOUND, nothing written);
 * - `platformMetrics` reports the rate and the duplicate count from the counters only (the platform
 *   role can't read the rows' ids or the rejection keys), inside the 30-day IST window.
 */
import { createDb, type Tx, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { platformMetrics } from "../admin/metrics";
import { adminContextFor, seedPlatformAdmin } from "../admin/test-support";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { postPayment } from "../payments/post-payment";
import { insertCustomer } from "../payments/test-support";
import {
  contextFor,
  type SeededTenant,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
} from "../testing/fixtures";
import {
  type PaymentSyncItemInput,
  recordPaymentSyncBatch,
  SYNC_METRICS_LOCK_TIMEOUT_MS,
  SYNC_METRICS_STATEMENT_TIMEOUT_MS,
} from "./record";

const NOW = new Date("2026-10-13T06:00:00.000Z"); // 11:30 IST, 13 Oct 2026
const NIL = "00000000-0000-0000-0000-000000000000";
let refSequence = 0;

describeDb("payment sync metrics (T-086a)", () => {
  const t = useTestDatabase();
  let rtNow: ServiceRuntime;

  beforeAll(() => {
    rtNow = testRuntime(t.current.db, { now: () => NOW });
  });

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    lineman: TenantContext;
    customerId: string;
  }

  async function setup(now = NOW): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(t.current.db, { now: () => now });
    const lineman = await contextFor(rt, tenant, "lineman");
    const customerId = await t.current.db.withTenant(tenant.operatorId, (tx: Tx) =>
      insertCustomer(tx, tenant.operatorId),
    );
    return { tenant, rt, lineman, customerId };
  }

  /** Posts a real payment through T-046; returns its id. */
  async function post(s: Setup, id = uuidv7()): Promise<string> {
    refSequence += 1;
    const r = await postPayment.call(s.rt, s.lineman, {
      id,
      customerId: s.customerId,
      amountPaise: 20_000,
      method: "cash",
      recordedAt: new Date(s.rt.now().getTime() - 60_000).toISOString(),
      provisionalRef: `P-K7Q-${String(refSequence).padStart(4, "0")}`,
    });
    if (!r.ok) throw new Error(`post: ${r.error.code}`);
    return id;
  }

  async function record(s: Setup, items: PaymentSyncItemInput[]) {
    const r = await recordPaymentSyncBatch.call(s.rt, s.lineman, { items });
    if (!r.ok) throw new Error(`record: ${r.error.code}`);
    return r.value.counts;
  }

  /** The tenant's summed counters, read as the owner (the platform can't see the rejections). */
  async function totals(operatorId: string) {
    const { rows } = await t.current.admin.query<Record<string, number>>(
      `SELECT count(*)::int AS batches, coalesce(sum(items),0)::int AS items,
              coalesce(sum(posted + posted_needs_review),0)::int AS accepted,
              coalesce(sum(duplicate),0)::int AS duplicate,
              coalesce(sum(rejected_new_ids),0)::int AS rejected_new_ids,
              coalesce(sum(accepted_after_rejection),0)::int AS accepted_after_rejection,
              (SELECT count(*)::int FROM payment_sync_rejections r WHERE r.operator_id = $1) AS keys
         FROM payment_sync_batches WHERE operator_id = $1`,
      [operatorId],
    );
    return rows[0];
  }

  it("a batch, its replay and later batches move the counters once per payment id", async () => {
    const s = await setup();
    const p1 = await post(s);
    const p2 = await post(s);
    const bad = uuidv7(); // refused: never saved
    const later = uuidv7(); // a temporary failure, then posted
    const first: PaymentSyncItemInput[] = [
      { outcome: "posted", id: p1 },
      { outcome: "posted_needs_review", id: p2 },
      { outcome: "rejected", id: bad, code: "CUSTOMER_NOT_FOUND" },
      { outcome: "retry_later", id: later, code: "INTERNAL" },
      { outcome: "rejected", id: NIL, code: "VALIDATION" },
    ];
    expect(await record(s, first)).toEqual({
      items: 5,
      posted: 1,
      postedNeedsReview: 1,
      duplicate: 0,
      rejected: { VALIDATION: 0, CUSTOMER_NOT_FOUND: 1, ID_REUSED_WITH_DIFFERENT_DATA: 0 },
      rejectedWithoutId: 1,
      rejectedNewIds: 1,
      acceptedAfterRejection: 0,
      acceptedAfterRejectionByDay: {},
      retryLater: { CONFLICT: 0, INTERNAL: 1, RATE_LIMITED: 0 },
    });

    // The phone lost the answer and sends the same batch: the saved ones are duplicates, the
    // refused id is refused again (not a new id), the temporary failure posts now.
    await post(s, later);
    const replay = await record(s, [
      { outcome: "duplicate", id: p1 },
      { outcome: "duplicate", id: p2 },
      { outcome: "rejected", id: bad, code: "CUSTOMER_NOT_FOUND" },
      { outcome: "posted", id: later },
      { outcome: "rejected", id: null, code: "VALIDATION" },
    ]);
    expect(replay).toMatchObject({
      duplicate: 2,
      posted: 1,
      rejectedNewIds: 0,
      rejected: { CUSTOMER_NOT_FOUND: 1 },
      rejectedWithoutId: 1,
    });

    // The same id with other data: refused, but it is a saved payment, so not a new id.
    const reused = await record(s, [
      { outcome: "rejected", id: p1, code: "ID_REUSED_WITH_DIFFERENT_DATA" },
    ]);
    expect(reused).toMatchObject({
      rejectedNewIds: 0,
      rejected: { ID_REUSED_WITH_DIFFERENT_DATA: 1 },
    });

    // Refused once, accepted later (counted once in the rate).
    const flip = uuidv7();
    await record(s, [{ outcome: "rejected", id: flip, code: "VALIDATION" }]);
    await post(s, flip);
    const flipped = await record(s, [{ outcome: "posted", id: flip }]);
    expect(flipped).toMatchObject({
      posted: 1,
      acceptedAfterRejection: 1,
      acceptedAfterRejectionByDay: { "2026-10-13": 1 },
    });

    // Distinct ids with a final answer: p1, p2, later, flip (accepted) + bad (rejected) = 5.
    const sum = await totals(s.tenant.operatorId);
    expect(sum).toEqual({
      batches: 5,
      items: 13,
      accepted: 4,
      duplicate: 2,
      rejected_new_ids: 2, // bad, flip
      accepted_after_rejection: 1, // flip
      keys: 2,
    });
    expect(
      (sum?.accepted ?? 0) + (sum?.rejected_new_ids ?? 0) - (sum?.accepted_after_rejection ?? 0),
    ).toBe(5);
  }, 60_000);

  it("the same id twice in one batch, and concurrent replays, count a refusal once", async () => {
    const s = await setup();
    const id = uuidv7();
    const twice = await record(s, [
      { outcome: "rejected", id, code: "VALIDATION" },
      { outcome: "rejected", id: id.toUpperCase(), code: "VALIDATION" },
    ]);
    expect(twice).toMatchObject({ rejectedNewIds: 1, rejected: { VALIDATION: 2 } });

    const PARALLEL = 6;
    const pool = createDb({
      connectionString: t.current.url,
      driver: "pg",
      max: PARALLEL + 2,
      onIdleError: () => {},
    });
    try {
      const rt = testRuntime(pool, { now: () => NOW });
      const racing = uuidv7();
      const results = await Promise.all(
        Array.from({ length: PARALLEL }, () =>
          recordPaymentSyncBatch.call(rt, s.lineman, {
            items: [{ outcome: "rejected", id: racing, code: "CUSTOMER_NOT_FOUND" }],
          }),
        ),
      );
      const newIds = results.map((r) => (r.ok ? r.value.counts.rejectedNewIds : -1));
      expect(newIds.filter((n) => n === 1)).toHaveLength(1);
      expect(newIds.filter((n) => n === 0)).toHaveLength(PARALLEL - 1);
    } finally {
      await pool.end();
    }
    expect(await totals(s.tenant.operatorId)).toMatchObject({
      batches: 1 + PARALLEL,
      rejected_new_ids: 2,
      keys: 2,
    });
  }, 60_000);

  it("accepted or duplicate ids must be the tenant's payments; rejected ids are per tenant", async () => {
    const a = await setup();
    const b = await setup();
    const bPayment = await post(b);
    for (const outcome of ["posted", "duplicate"] as const) {
      const r = await recordPaymentSyncBatch.call(a.rt, a.lineman, {
        items: [{ outcome, id: bPayment }],
      });
      expect(!r.ok && r.error.code, outcome).toBe("NOT_FOUND");
      const unknown = await recordPaymentSyncBatch.call(a.rt, a.lineman, {
        items: [{ outcome, id: uuidv7() }],
      });
      expect(!unknown.ok && unknown.error.code, outcome).toBe("NOT_FOUND");
    }
    expect(await totals(a.tenant.operatorId)).toMatchObject({ batches: 0, keys: 0 });

    // The same refused id in two tenants is a first refusal in each.
    const id = uuidv7();
    for (const s of [a, b]) {
      const counts = await record(s, [{ outcome: "rejected", id, code: "VALIDATION" }]);
      expect(counts.rejectedNewIds).toBe(1);
    }
  }, 60_000);

  it("works in a read-only tenant (D-13) and refuses malformed input", async () => {
    const s = await setup();
    await setSubscriptionStatus(t.current, s.tenant.operatorId, "read_only");
    const p = await post(s);
    expect((await record(s, [{ outcome: "posted", id: p }])).posted).toBe(1);
    for (const items of [
      [],
      Array.from({ length: 51 }, () => ({ outcome: "retry_later", id: null, code: "INTERNAL" })),
      [{ outcome: "posted", id: null }],
      [{ outcome: "rejected", id: uuidv7(), code: "INTERNAL" }],
      [{ outcome: "retry_later", id: null, code: "VALIDATION" }],
      [{ outcome: "sent", id: uuidv7() }],
    ]) {
      // biome-ignore lint/suspicious/noExplicitAny: malformed on purpose.
      const r = await recordPaymentSyncBatch.call(s.rt, s.lineman, { items: items as any });
      expect(!r.ok && r.error.code, JSON.stringify(items).slice(0, 80)).toBe("VALIDATION");
    }
    expect(await totals(s.tenant.operatorId)).toMatchObject({ batches: 1 });
  }, 60_000);

  it("platformMetrics shows the rate and the duplicates of the last 30 IST days, counts only", async () => {
    const adminId = await seedPlatformAdmin(t.current);
    const ctx = await adminContextFor(rtNow, adminId);
    const read = async () => {
      const r = await platformMetrics.call(rtNow, ctx, {});
      if (!r.ok) throw new Error(r.error.code);
      return r.value;
    };
    const before = (await read()).paymentSync;

    const s = await setup();
    const p1 = await post(s);
    const p2 = await post(s);
    const p3 = await post(s);
    const refused = uuidv7();
    await record(s, [
      { outcome: "posted", id: p1 },
      { outcome: "posted", id: p2 },
      { outcome: "posted_needs_review", id: p3 },
      { outcome: "rejected", id: refused, code: "VALIDATION" },
      { outcome: "retry_later", id: uuidv7(), code: "CONFLICT" },
    ]);
    // Two replays of the whole batch (lost answers).
    for (let i = 0; i < 2; i += 1) {
      await record(s, [
        { outcome: "duplicate", id: p1 },
        { outcome: "duplicate", id: p2 },
        { outcome: "duplicate", id: p3 },
        { outcome: "rejected", id: refused, code: "VALIDATION" },
      ]);
    }
    // 31 IST days ago: outside the window.
    const old = await setup(new Date(NOW.getTime() - 31 * 86_400_000));
    const oldPayment = await post(old);
    await record(old, [{ outcome: "posted", id: oldPayment }]);

    const after = (await read()).paymentSync;
    const delta = (
      k: "batches" | "items" | "attempts" | "accepted" | "rejected" | "duplicatesPrevented",
    ) => after[k] - before[k];
    expect({
      batches: delta("batches"),
      items: delta("items"),
      attempts: delta("attempts"),
      accepted: delta("accepted"),
      rejected: delta("rejected"),
      duplicatesPrevented: delta("duplicatesPrevented"),
    }).toEqual({
      batches: 3,
      items: 13,
      attempts: 4,
      accepted: 3,
      rejected: 1,
      duplicatesPrevented: 6,
    });
    expect(after.acceptedNeedsReview - before.acceptedNeedsReview).toBe(1);
    expect(after.rejectedAnswersByCode.VALIDATION - before.rejectedAnswersByCode.VALIDATION).toBe(
      3,
    );
    expect(after.retryLaterByCode.CONFLICT - before.retryLaterByCode.CONFLICT).toBe(1);
    expect(after.successRate).not.toBeNull();
    expect((await read()).notMeasured).toEqual(["migration_exceptions"]);

    // The output is counts only: no payment id appears in it.
    const text = JSON.stringify(await read());
    for (const id of [p1, p2, p3, refused, s.customerId, s.tenant.operatorId]) {
      expect(text).not.toContain(id);
    }
  }, 60_000);

  describe("the 30-day window (review fixes)", () => {
    const DAY = 86_400_000;

    async function metricsNow() {
      const adminId = await seedPlatformAdmin(t.current);
      const ctx = await adminContextFor(rtNow, adminId);
      return async () => {
        const r = await platformMetrics.call(rtNow, ctx, {});
        if (!r.ok) throw new Error(r.error.code);
        return r.value.paymentSync;
      };
    }

    /** The same tenant and lineman, with the clock at `now`. */
    async function at(s: Setup, now: Date): Promise<Setup> {
      const rt = testRuntime(t.current.db, { now: () => now });
      return { ...s, rt, lineman: await contextFor(rt, s.tenant, "lineman") };
    }

    it("a refusal older than the window, accepted today, is one attempt and one accepted id", async () => {
      const read = await metricsNow();
      const before = await read();
      const old = await setup(new Date(NOW.getTime() - 40 * DAY));
      const id = uuidv7();
      await record(old, [{ outcome: "rejected", id, code: "VALIDATION" }]);
      const today = await at(old, NOW);
      await post(today, id);
      const counts = await record(today, [{ outcome: "posted", id }]);
      expect(counts.acceptedAfterRejectionByDay).toEqual({ "2026-09-03": 1 });
      const after = await read();
      expect(after.accepted - before.accepted).toBe(1);
      expect(after.rejected - before.rejected).toBe(0);
      expect(after.attempts - before.attempts).toBe(1);
      expect(after.attempts).toBeGreaterThanOrEqual(after.accepted);
      expect(after.successRate).not.toBeNull();
      expect(after.successRate ?? 0).toBeLessThanOrEqual(100);
    }, 60_000);

    it("day 30 is inside the window and day 31 is not", async () => {
      const read = await metricsNow();
      const before = await read();
      // On each day a batch refuses one id; the id is accepted today.
      for (const days of [30, 31]) {
        const then = await setup(new Date(NOW.getTime() - days * DAY));
        const id = uuidv7();
        await record(then, [{ outcome: "rejected", id, code: "CUSTOMER_NOT_FOUND" }]);
        const today = await at(then, NOW);
        await post(today, id);
        await record(today, [{ outcome: "posted", id }]);
      }
      const after = await read();
      // Day 30's refusal batch counts (a new rejected id, then subtracted on acceptance); day
      // 31's doesn't. Each id is one attempt and one accepted id either way.
      expect(after.batches - before.batches).toBe(3);
      expect(after.rejected - before.rejected).toBe(1);
      expect(after.accepted - before.accepted).toBe(2);
      expect(after.attempts - before.attempts).toBe(2);
    }, 60_000);
  });

  it("concurrent batches refusing the same ids in opposite order don't deadlock", async () => {
    const s = await setup();
    const pool = createDb({
      connectionString: t.current.url,
      driver: "pg",
      max: 6,
      onIdleError: () => {},
    });
    const holder = await t.current.admin.connect();
    try {
      const rt = testRuntime(pool, { now: () => NOW });
      for (let round = 0; round < 5; round += 1) {
        const ids = Array.from({ length: 50 }, () => uuidv7());
        const items = (list: string[]) =>
          list.map((id) => ({ outcome: "rejected" as const, id, code: "VALIDATION" as const }));
        // Both calls block at their INSERT (SHARE conflicts with ROW EXCLUSIVE), then insert the
        // same 50 keys at the same moment, one in each order.
        await holder.query("BEGIN");
        await holder.query("LOCK TABLE payment_sync_rejections IN SHARE MODE");
        const pending = Promise.all([
          recordPaymentSyncBatch.call(rt, s.lineman, { items: items(ids) }),
          recordPaymentSyncBatch.call(rt, s.lineman, { items: items([...ids].reverse()) }),
        ]);
        const deadline = Date.now() + 2_000;
        for (;;) {
          const { rows: waiting } = await t.current.admin.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          if ((waiting[0]?.n ?? 0) >= 2) break;
          if (Date.now() > deadline) break; // lock_timeout is 3 s: never hold them longer
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await holder.query("COMMIT");
        const results = await pending;
        expect(results.map((r) => (r.ok ? "ok" : r.error.code))).toEqual(["ok", "ok"]);
        const newIds = results.map((r) => (r.ok ? r.value.counts.rejectedNewIds : -1));
        expect((newIds[0] ?? 0) + (newIds[1] ?? 0)).toBe(50);
      }
    } finally {
      holder.release();
      await pool.end();
    }
  }, 60_000);

  it("ids are strict like T-061's itemIdOf; the nil id counts as 'without id'", async () => {
    const s = await setup();
    // What T-061 answers for a missing or non-RFC id: the nil UUID, counted apart, no key stored.
    const counts = await record(s, [
      { outcome: "rejected", id: NIL, code: "VALIDATION" },
      { outcome: "retry_later", id: NIL, code: "RATE_LIMITED" },
      { outcome: "rejected", id: null, code: "VALIDATION" },
    ]);
    expect(counts).toMatchObject({
      items: 3,
      rejectedWithoutId: 2,
      rejectedNewIds: 0,
      rejected: { VALIDATION: 0 },
      retryLater: { RATE_LIMITED: 1 },
    });
    expect(await totals(s.tenant.operatorId)).toMatchObject({ batches: 1, keys: 0 });
    // A non-RFC id never reaches the recorder from T-061 (it answers the nil id); passed
    // directly, it is refused like the contract refuses it.
    for (const id of ["12345678-1234-0234-0234-123456789abc", "12345678-1234"]) {
      const r = await recordPaymentSyncBatch.call(s.rt, s.lineman, {
        items: [{ outcome: "rejected", id, code: "VALIDATION" }],
      });
      expect(!r.ok && r.error.code, id).toBe("VALIDATION");
    }
  }, 60_000);

  it("its transaction has a short lock timeout: a held table ends the call quickly", async () => {
    const s = await setup();
    const holder = await t.current.admin.connect();
    try {
      // Hold the batches table so the insert must wait on a lock: lock_timeout ends the wait.
      await holder.query("BEGIN");
      await holder.query("LOCK TABLE payment_sync_batches IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      const r = await recordPaymentSyncBatch.call(s.rt, s.lineman, {
        items: [{ outcome: "retry_later", id: null, code: "INTERNAL" }],
      });
      const waited = Date.now() - started;
      expect(r.ok).toBe(false);
      expect(waited).toBeGreaterThanOrEqual(SYNC_METRICS_LOCK_TIMEOUT_MS - 200);
      expect(waited).toBeLessThan(SYNC_METRICS_STATEMENT_TIMEOUT_MS + 10_000);
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
  }, 60_000);
});
