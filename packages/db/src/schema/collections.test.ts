/**
 * Collection sessions (T-023, PLAN §8.7, FR-022): one per lineman per IST day, the discrepancy is
 * computed (handed − expected) and needs a reason when non-zero, a returned handover needs a note,
 * an accepted handover is final. Isolation cases too.
 */
import { eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, createUser, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { collectionSessions } from "./collections";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

const failsWith = (code: string) => (e: unknown) => sqlStateOf(e) === code;
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

interface Seed {
  tenant: TestTenant;
  operatorId: string;
  ownerId: string;
  linemanId: string;
}

/** A handover of `handed` against the session's expected cash `expected`. */
const handover = (expected: number, handed: number) => ({
  status: "submitted" as const,
  handoverSubmissionId: uuidv7(),
  handoverCashExpectedPaise: expected,
  cashHandedOverPaise: handed,
  discrepancyPaise: handed - expected,
  unsyncedPaymentCount: 0,
  unsyncedCashPaise: 0,
  submittedAt: new Date(),
});

describeDb("collection_sessions", () => {
  const t = useTestDatabase();
  let a: Seed;
  let b: Seed;
  let day = 0;

  async function seed(): Promise<Seed> {
    const tenant = await createTenant(t.current);
    const owner = await createUser(t.current, { operatorId: tenant.operatorId });
    const lineman = await createUser(t.current, {
      operatorId: tenant.operatorId,
      role: "lineman",
    });
    return {
      tenant,
      operatorId: tenant.operatorId,
      ownerId: owner.userId,
      linemanId: lineman.userId,
    };
  }

  const nextDay = () => {
    day += 1;
    return `2026-10-${String(day).padStart(2, "0")}`;
  };

  const insertSession = (s: Seed, values: Partial<typeof collectionSessions.$inferInsert> = {}) =>
    t.current.db
      .withTenant(s.operatorId, (tx) =>
        tx
          .insert(collectionSessions)
          .values({
            id: uuidv7(),
            operatorId: s.operatorId,
            collectorId: s.linemanId,
            businessDate: nextDay(),
            ...values,
          })
          .returning(),
      )
      .then(([row]) => {
        if (!row) throw new Error("insert returned nothing");
        return row;
      });

  const update = (s: Seed, id: string, set: PgUpdateSetSource<typeof collectionSessions>) =>
    t.current.db.withTenant(s.operatorId, (tx) =>
      tx.update(collectionSessions).set(set).where(eq(collectionSessions.id, id)),
    );

  beforeAll(async () => {
    a = await seed();
    b = await seed();
  });

  it("one session per lineman per day, created open with zero totals", async () => {
    const date = nextDay();
    const row = await insertSession(a, { businessDate: date });
    expect(row).toMatchObject({
      status: "open",
      cashExpectedPaise: 0,
      upiTotalPaise: 0,
      paymentCount: 0,
      cashHandedOverPaise: null,
    });
    await expect(insertSession(a, { businessDate: date })).rejects.toSatisfy(
      violates(UNIQUE_VIOLATION, "collection_sessions_collector_day_unique"),
    );
    // The idempotent "first payment of the day" upsert.
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx
        .insert(collectionSessions)
        .values({
          id: uuidv7(),
          operatorId: a.operatorId,
          collectorId: a.linemanId,
          businessDate: date,
        })
        .onConflictDoNothing(),
    );
    // Posting adds to the running totals; cash and UPI are separate (UPI is not handed over).
    await update(a, row.id, {
      cashExpectedPaise: sql`${collectionSessions.cashExpectedPaise} + 50000`,
      paymentCount: sql`${collectionSessions.paymentCount} + 1`,
    });
    await update(a, row.id, {
      upiTotalPaise: sql`${collectionSessions.upiTotalPaise} + 20000`,
      paymentCount: sql`${collectionSessions.paymentCount} + 1`,
    });
    await expect(update(a, row.id, { cashExpectedPaise: -1 })).rejects.toSatisfy(
      violates(CHECK_VIOLATION, "collection_sessions_totals_not_negative"),
    );
  });

  it("the handover snapshot: discrepancy = handed − expected, a reason when it isn't 0", async () => {
    const row = await insertSession(a, { cashExpectedPaise: 50_000, paymentCount: 2 });
    await expect(update(a, row.id, { status: "submitted" })).rejects.toSatisfy(
      violates(CHECK_VIOLATION, "collection_sessions_handover_iff_submitted"),
    );
    await expect(
      update(a, row.id, { ...handover(50_000, 45_000), discrepancyPaise: 0 }),
    ).rejects.toSatisfy(violates(CHECK_VIOLATION, "collection_sessions_discrepancy_computed"));
    await expect(update(a, row.id, handover(50_000, 45_000))).rejects.toSatisfy(
      violates(CHECK_VIOLATION, "collection_sessions_discrepancy_needs_reason"),
    );
    await expect(
      update(a, row.id, { ...handover(50_000, -1), discrepancyReason: "short" }),
    ).rejects.toSatisfy(violates(CHECK_VIOLATION, "collection_sessions_handover_amounts"));
    await update(a, row.id, { ...handover(50_000, 45_000), discrepancyReason: "short" });
    // An exact handover needs no reason.
    const exact = await insertSession(a, { cashExpectedPaise: 30_000 });
    await update(a, exact.id, handover(30_000, 30_000));
  });

  it("returned needs the office's note; resubmit; accepted is final except the running totals", async () => {
    const row = await insertSession(a, { cashExpectedPaise: 50_000 });
    await update(a, row.id, handover(50_000, 50_000));
    await expect(
      update(a, row.id, { status: "returned", reviewedBy: a.ownerId, reviewedAt: new Date() }),
    ).rejects.toSatisfy(violates(CHECK_VIOLATION, "collection_sessions_review"));
    await expect(update(a, row.id, { status: "accepted" })).rejects.toSatisfy(
      violates(CHECK_VIOLATION, "collection_sessions_review"),
    );
    await update(a, row.id, {
      status: "returned",
      reviewedBy: a.ownerId,
      reviewedAt: new Date(),
      reviewNote: "Count again",
    });
    // The lineman submits again (the office's previous decision is cleared; audit keeps it).
    await update(a, row.id, {
      ...handover(50_000, 50_000),
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
    });
    await update(a, row.id, { status: "accepted", reviewedBy: a.ownerId, reviewedAt: new Date() });
    // Final: the handover and the decision never change …
    for (const set of [
      { status: "returned" as const, reviewNote: "x" },
      { cashHandedOverPaise: 1, discrepancyPaise: -49_999, discrepancyReason: "short" as const },
      { reviewNote: "late note" },
    ]) {
      await expect(update(a, row.id, set), JSON.stringify(set)).rejects.toSatisfy(
        isImmutableRowError,
      );
    }
    // … but a late-synced or reversed payment still moves the running totals.
    await update(a, row.id, { cashExpectedPaise: 60_000, paymentCount: 3, updatedAt: new Date() });
  });

  it("is never deleted and keeps its lineman and day", async () => {
    const row = await insertSession(a);
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.delete(collectionSessions).where(eq(collectionSessions.id, row.id)),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(update(a, row.id, { businessDate: "2027-01-01" })).rejects.toSatisfy(
      isImmutableRowError,
    );
    await expect(update(a, row.id, { collectorId: a.ownerId })).rejects.toSatisfy(
      isImmutableRowError,
    );
    await expect(t.current.admin.query("TRUNCATE collection_sessions")).rejects.toSatisfy(
      isImmutableRowError,
    );
  });

  it("is tenant-scoped; the collector must be the tenant's user", async () => {
    const row = await insertSession(a);
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(collectionSessions).where(eq(collectionSessions.id, row.id)),
    );
    expect(seenByB).toEqual([]);
    await expect(insertSession(b, { collectorId: a.linemanId })).rejects.toSatisfy(
      violates(FK_VIOLATION, "collection_sessions_collector_fk"),
    );
    await expect(
      t.current.db.withTenant(b.operatorId, (tx) =>
        tx.insert(collectionSessions).values({
          id: uuidv7(),
          operatorId: a.operatorId,
          collectorId: a.linemanId,
          businessDate: "2027-02-01",
        }),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
  });
});
