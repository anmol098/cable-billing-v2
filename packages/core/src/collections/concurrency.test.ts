/**
 * Concurrency of the handover (T-062): calls run truly in parallel (a dedicated pool larger than
 * the number of callers, one connection and transaction each). The session row lock and the
 * history's unique keys decide; no sleeps or timing windows.
 */
import { createDb, type DbClient, handoverEvents, uuidv7 } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { businessDate } from "@cb/domain";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { contextFor, type SeededTenant, seedTenant, testRuntime } from "../testing/fixtures";
import { getOwnCollectionDay } from "./day";
import { acceptHandover, returnHandover, submitHandover } from "./handover";
import { newCustomer, postField } from "./test-support";

const NOW = new Date("2026-10-13T12:30:00.000Z");
const TODAY = businessDate("2026-10-13");
const PARALLEL = 8;

describeDb("collections: concurrency", () => {
  const t = useTestDatabase();
  let db: DbClient;

  beforeAll(() => {
    db = createDb({
      connectionString: t.current.url,
      driver: "pg",
      max: PARALLEL + 4,
      onIdleError: () => {},
    });
  });
  afterAll(async () => {
    await db?.end();
  });

  interface Setup {
    tenant: SeededTenant;
    rt: ServiceRuntime;
    owner: TenantContext;
    staff: TenantContext;
    lineman: TenantContext;
  }

  async function setup(): Promise<Setup> {
    const tenant = await seedTenant(t.current);
    const rt = testRuntime(db, { now: () => NOW });
    return {
      tenant,
      rt,
      owner: await contextFor(rt, tenant, "owner"),
      staff: await contextFor(rt, tenant, "staff"),
      lineman: await contextFor(rt, tenant, "lineman"),
    };
  }

  const handover = (extra: object = {}) => ({
    businessDate: TODAY,
    submissionId: uuidv7(),
    cashHandedOverPaise: 0,
    unsyncedPaymentCount: 0,
    unsyncedCashPaise: 0,
    ...extra,
  });

  /**
   * Holds the session row lock on an admin connection, starts `calls`, waits until `waiters`
   * backends are blocked on a lock (each caller at its own `FOR UPDATE`, or at its UPDATE if that
   * lock were missing), then releases it: every caller has started its transaction by then, so
   * the race is real, not a matter of timing.
   */
  async function raceOnLockedRow<T>(sessionId: string, waiters: number, calls: () => Promise<T>) {
    const holder = await t.current.admin.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM collection_sessions WHERE id = $1 FOR UPDATE", [sessionId]);
      const pending = calls();
      const deadline = Date.now() + 20_000;
      for (;;) {
        const { rows } = await t.current.admin.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        if ((rows[0]?.n ?? 0) >= waiters) break;
        if (Date.now() > deadline) throw new Error("callers never blocked on the row");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await holder.query("COMMIT");
      return await pending;
    } finally {
      holder.release();
    }
  }

  const events = (s: Setup) =>
    db.withTenant(s.tenant.operatorId, (tx) => tx.select().from(handoverEvents));

  async function submitted(s: Setup) {
    const input = handover();
    const r = await submitHandover.call(s.rt, s.lineman, input);
    if (!r.ok || !r.value.day.sessionId) throw new Error("submit failed");
    return { sessionId: r.value.day.sessionId, submissionId: input.submissionId };
  }

  it("double accept (owner and staff, many times at once): accepted exactly once", async () => {
    const s = await setup();
    const ids = await submitted(s);
    const results = await raceOnLockedRow(ids.sessionId, PARALLEL, () =>
      Promise.all(
        Array.from({ length: PARALLEL }, (_, i) =>
          acceptHandover.call(s.rt, i % 2 === 0 ? s.owner : s.staff, ids),
        ),
      ),
    );
    const oks = results.filter((r) => r.ok);
    expect(oks).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) {
      expect(!r.ok && r.error).toMatchObject({
        code: "CONFLICT",
        details: { reason: "already_accepted" },
      });
    }
    const all = await events(s);
    expect(all.filter((e) => e.type === "accepted")).toHaveLength(1);
  }, 60_000);

  it("accept and return at once: one decision wins, the other is refused", async () => {
    const s = await setup();
    const ids = await submitted(s);
    const [accepted, returned] = await raceOnLockedRow(ids.sessionId, 2, () =>
      Promise.all([
        acceptHandover.call(s.rt, s.owner, ids),
        returnHandover.call(s.rt, s.staff, { ...ids, note: "Count again" }),
      ]),
    );
    expect([accepted.ok, returned.ok].filter(Boolean)).toHaveLength(1);
    const decisions = (await events(s)).filter((e) => e.type !== "submitted");
    expect(decisions).toHaveLength(1);
    const day = await getOwnCollectionDay.call(s.rt, s.lineman, { businessDate: TODAY });
    expect(day.ok && day.value.status).toBe(accepted.ok ? "accepted" : "returned");
  }, 60_000);

  it("the same submission sent many times at once: one submission, the rest duplicates", async () => {
    const s = await setup();
    const customerId = await newCustomer(db, s.tenant);
    await postField(s.rt, s.lineman, customerId, 10_000, "cash", NOW);
    const day = await getOwnCollectionDay.call(s.rt, s.lineman, { businessDate: TODAY });
    const sessionId = (day.ok && day.value.sessionId) || "";
    const input = handover({ cashHandedOverPaise: 10_000 });
    const results = await raceOnLockedRow(sessionId, PARALLEL, () =>
      Promise.all(
        Array.from({ length: PARALLEL }, () => submitHandover.call(s.rt, s.lineman, input)),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    const outcomes = results.map((r) => (r.ok ? r.value.outcome : r.error.code));
    expect(outcomes.filter((o) => o === "submitted")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "duplicate")).toHaveLength(PARALLEL - 1);
    expect(await events(s)).toHaveLength(1);
  }, 60_000);

  it("a handover racing payments snapshots a consistent expected cash", async () => {
    const s = await setup();
    const customerId = await newCustomer(db, s.tenant);
    const posts = Array.from({ length: PARALLEL - 2 }, (_, i) =>
      postField(s.rt, s.lineman, customerId, 10_000, "cash", new Date(NOW.getTime() - i * 1000)),
    );
    const submit = submitHandover.call(
      s.rt,
      s.lineman,
      handover({ cashHandedOverPaise: 0, discrepancyReason: "short" }),
    );
    const [result] = await Promise.all([submit, ...posts]);
    if (!result.ok) throw new Error(result.error.code);
    const snapshot = result.value.day.handover?.cashExpectedPaise ?? -1;
    // Whatever had committed before the lock: a whole number of the ₹100 payments.
    expect(snapshot % 10_000).toBe(0);
    expect(snapshot).toBeLessThanOrEqual((PARALLEL - 2) * 10_000);
    expect((result.value.day.handover?.discrepancyPaise ?? 1) + snapshot).toBe(0);
    const day = await getOwnCollectionDay.call(s.rt, s.lineman, { businessDate: TODAY });
    expect(day.ok && day.value.cashExpectedPaise).toBe((PARALLEL - 2) * 10_000);
    expect(day.ok && day.value.handover?.cashExpectedPaise).toBe(snapshot);
  }, 60_000);
});
