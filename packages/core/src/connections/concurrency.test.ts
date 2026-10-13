/**
 * Concurrency on one VC (T-034; RULE-06, BR-03): real parallel transactions on a dedicated pool
 * larger than the number of callers. No sleeps: the VC asset row lock (and the EXCLUDE
 * constraint behind it) decides.
 */
import { assignmentEvents, createDb, type DbClient, vcAssets, vcAssignments } from "@cb/db";
import { describeDb, useTestDatabase } from "@cb/db/testing";
import { validateAssignmentTimeline } from "@cb/domain";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  addConnection,
  disconnectConnection,
  reactivateConnection,
  suspendConnection,
} from "./services";
import { toTimeline } from "./store";
import { ist, newCustomer, setupTenant } from "./test-support";

const PARALLEL = 6;
const OCT_13 = ist("2026-10-13");

describeDb("connections: concurrency on one VC", () => {
  const t = useTestDatabase();
  let db: DbClient;

  beforeAll(() => {
    db = createDb({
      connectionString: t.current.url,
      driver: "pg",
      max: PARALLEL * 3 + 4,
      onIdleError: () => {},
    });
  });
  afterAll(async () => {
    await db?.end();
  });

  it("the same new VC added to six customers at once: exactly one gets it", async () => {
    const s = await setupTenant(t.current, db);
    const customerIds: string[] = [];
    for (let i = 0; i < PARALLEL; i += 1) customerIds.push(await newCustomer(s, OCT_13));

    const results = await Promise.all(
      customerIds.map((customerId, i) =>
        addConnection.call(s.rt(OCT_13), i % 2 === 0 ? s.owner : s.staff, {
          customerId,
          vcNumber: i % 2 === 0 ? "RACE 0001" : "race-0001",
          rentalPaise: 30_000,
          startDate: "2026-10-13",
        }),
      ),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    for (const r of results) {
      if (r.ok) continue;
      expect(r.error.code).toBe("CONFLICT");
      expect(r.error.details?.reason).toBe("vc_in_use");
    }
    const assets = await s.tx((tx) => tx.select().from(vcAssets));
    expect(assets).toHaveLength(1);
    const assignments = await s.tx((tx) => tx.select().from(vcAssignments));
    expect(assignments).toHaveLength(1);
  }, 60_000);

  it("removing a VC while it is being added elsewhere never overlaps", async () => {
    const s = await setupTenant(t.current, db);
    const owner = await newCustomer(s, OCT_13);
    const added = await addConnection.call(s.rt(OCT_13), s.owner, {
      customerId: owner,
      vcNumber: "MOVE-1",
      rentalPaise: 30_000,
      startDate: "2026-09-01",
    });
    if (!added.ok) throw new Error("setup failed");
    const others: string[] = [];
    for (let i = 0; i < PARALLEL - 1; i += 1) others.push(await newCustomer(s, OCT_13));

    const results = await Promise.all([
      disconnectConnection.call(s.rt(OCT_13), s.staff, {
        assignmentId: added.value.connection.assignmentId,
        effectiveDate: "2026-10-13",
        reason: "moved_away",
      }),
      ...others.map((customerId) =>
        addConnection.call(s.rt(OCT_13), s.staff, {
          customerId,
          vcNumber: "MOVE-1",
          rentalPaise: 30_000,
          startDate: "2026-10-14",
        }),
      ),
    ]);
    expect(results[0]?.ok).toBe(true);
    // The disconnection may commit before or after some adds; at most one add wins.
    expect(results.slice(1).filter((r) => r.ok).length).toBeLessThanOrEqual(1);
    const rows = await s.tx((tx) =>
      tx.select().from(vcAssignments).orderBy(asc(vcAssignments.startDate)),
    );
    for (let i = 1; i < rows.length; i += 1) {
      const previous = rows[i - 1];
      const current = rows[i];
      expect(previous?.endDate).not.toBeNull();
      expect((previous?.endDate ?? "") < (current?.startDate ?? "")).toBe(true);
    }
  }, 60_000);

  it("stop, start again and remove racing on one connection leave a valid history", async () => {
    const s = await setupTenant(t.current, db);
    const customerId = await newCustomer(s, OCT_13);
    const added = await addConnection.call(s.rt(OCT_13), s.owner, {
      customerId,
      vcNumber: "FLIP-1",
      rentalPaise: 30_000,
      startDate: "2026-10-01",
    });
    if (!added.ok) throw new Error("setup failed");
    const assignmentId = added.value.connection.assignmentId;
    const at = { assignmentId, effectiveDate: "2026-10-13" };

    const results = await Promise.all([
      suspendConnection.call(s.rt(OCT_13), s.owner, at),
      suspendConnection.call(s.rt(OCT_13), s.staff, at),
      reactivateConnection.call(s.rt(OCT_13), s.owner, at),
      reactivateConnection.call(s.rt(OCT_13), s.staff, at),
      disconnectConnection.call(s.rt(OCT_13), s.owner, { ...at, reason: "moved_away" }),
      suspendConnection.call(s.rt(OCT_13), s.staff, at),
    ]);
    for (const r of results) {
      if (!r.ok) expect(r.error.details?.reason).toBe("invalid_transition");
    }
    const [row] = await s.tx((tx) =>
      tx.select().from(vcAssignments).where(eq(vcAssignments.id, assignmentId)),
    );
    const events = await s.tx((tx) =>
      tx
        .select()
        .from(assignmentEvents)
        .where(eq(assignmentEvents.assignmentId, assignmentId))
        .orderBy(asc(assignmentEvents.at), asc(assignmentEvents.id)),
    );
    if (!row) throw new Error("row missing");
    // One event per successful change, and the stored status is the last event's.
    expect(events).toHaveLength(1 + results.filter((r) => r.ok).length);
    const lastType = events.at(-1)?.type;
    const expected =
      lastType === "disconnected"
        ? "disconnected"
        : lastType === "suspended"
          ? "suspended"
          : "active";
    expect(row.status).toBe(expected);
    expect(validateAssignmentTimeline(toTimeline(row, events)).ok).toBe(true);
  }, 60_000);
});
