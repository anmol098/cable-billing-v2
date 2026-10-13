/**
 * Handover history (T-062, PLAN §8.7): every submission keeps its server-computed snapshot
 * (discrepancy = handed − expected, a reason when it isn't 0), a submission id is used once per
 * tenant, each submission gets at most one office decision, "returned" needs a note, and nothing is
 * ever changed or deleted. Tenant-scoped like every tenant table.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, createUser, describeDb, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { collectionSessions } from "./collections";
import { handoverEvents } from "./handovers";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

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
  operatorId: string;
  ownerId: string;
  linemanId: string;
  sessionId: string;
}

describeDb("handover_events", () => {
  const t = useTestDatabase();
  let a: Seed;
  let b: Seed;

  async function seed(): Promise<Seed> {
    const tenant = await createTenant(t.current);
    const owner = await createUser(t.current, { operatorId: tenant.operatorId });
    const lineman = await createUser(t.current, {
      operatorId: tenant.operatorId,
      role: "lineman",
    });
    const sessionId = uuidv7();
    await t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx.insert(collectionSessions).values({
        id: sessionId,
        operatorId: tenant.operatorId,
        collectorId: lineman.userId,
        businessDate: "2026-10-13",
        cashExpectedPaise: 50_000,
      }),
    );
    return {
      operatorId: tenant.operatorId,
      ownerId: owner.userId,
      linemanId: lineman.userId,
      sessionId,
    };
  }

  const submitted = (s: Seed, expected: number, handed: number) => ({
    id: uuidv7(),
    operatorId: s.operatorId,
    sessionId: s.sessionId,
    type: "submitted" as const,
    submissionId: uuidv7(),
    actorId: s.linemanId,
    cashExpectedPaise: expected,
    cashHandedOverPaise: handed,
    discrepancyPaise: handed - expected,
    unsyncedPaymentCount: 0,
    unsyncedCashPaise: 0,
    at: new Date(),
  });

  const decision = (
    s: Seed,
    submissionId: string,
    type: "accepted" | "returned",
    note: string | null = null,
  ) => ({
    id: uuidv7(),
    operatorId: s.operatorId,
    sessionId: s.sessionId,
    type,
    submissionId,
    actorId: s.ownerId,
    note,
    at: new Date(),
  });

  const insert = (s: Seed, values: typeof handoverEvents.$inferInsert) =>
    t.current.db.withTenant(s.operatorId, (tx) => tx.insert(handoverEvents).values(values));

  beforeAll(async () => {
    a = await seed();
    b = await seed();
  });

  it("a submission stores the computed discrepancy, with a reason when it isn't 0", async () => {
    await insert(a, submitted(a, 50_000, 50_000));
    await insert(a, { ...submitted(a, 50_000, 45_000), discrepancyReason: "short", note: "Ram" });
    await expect(insert(a, submitted(a, 50_000, 45_000))).rejects.toSatisfy(
      violates(CHECK_VIOLATION, "handover_events_discrepancy_needs_reason"),
    );
    await expect(
      insert(a, { ...submitted(a, 50_000, 45_000), discrepancyPaise: 0 }),
    ).rejects.toSatisfy(violates(CHECK_VIOLATION, "handover_events_discrepancy_computed"));
    await expect(
      insert(a, { ...submitted(a, 50_000, -1), discrepancyReason: "short" }),
    ).rejects.toSatisfy(violates(CHECK_VIOLATION, "handover_events_amounts_not_negative"));
    await expect(
      insert(a, { ...submitted(a, 50_000, 50_000), unsyncedPaymentCount: null }),
    ).rejects.toSatisfy(violates(CHECK_VIOLATION, "handover_events_snapshot_iff_submitted"));
    await expect(insert(a, { ...submitted(a, 50_000, 50_000), note: "  " })).rejects.toSatisfy(
      violates(CHECK_VIOLATION, "handover_events_note_not_blank"),
    );
  });

  it("a submission id is used once per tenant; one decision per submission", async () => {
    const first = submitted(a, 50_000, 50_000);
    await insert(a, first);
    await expect(
      insert(a, { ...submitted(a, 50_000, 50_000), submissionId: first.submissionId }),
    ).rejects.toSatisfy(violates(UNIQUE_VIOLATION, "handover_events_submission_unique"));
    // Another tenant may use the same id (keys are per tenant).
    await insert(b, { ...submitted(b, 50_000, 50_000), submissionId: first.submissionId });

    await expect(insert(a, decision(a, first.submissionId, "returned"))).rejects.toSatisfy(
      violates(CHECK_VIOLATION, "handover_events_returned_needs_note"),
    );
    await expect(
      insert(a, { ...decision(a, first.submissionId, "accepted"), cashExpectedPaise: 1 }),
    ).rejects.toSatisfy(violates(CHECK_VIOLATION, "handover_events_snapshot_iff_submitted"));
    await insert(a, decision(a, first.submissionId, "accepted"));
    await expect(
      insert(a, decision(a, first.submissionId, "returned", "Count again")),
    ).rejects.toSatisfy(violates(UNIQUE_VIOLATION, "handover_events_one_decision"));
    await expect(insert(a, decision(a, first.submissionId, "accepted"))).rejects.toSatisfy(
      violates(UNIQUE_VIOLATION, "handover_events_one_decision"),
    );
  });

  it("is append-only for every role, owner included", async () => {
    const row = submitted(a, 50_000, 50_000);
    await insert(a, row);
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.update(handoverEvents).set({ note: "changed" }).where(eq(handoverEvents.id, row.id)),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.delete(handoverEvents).where(eq(handoverEvents.id, row.id)),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(
      t.current.admin.query("UPDATE handover_events SET note = 'x' WHERE id = $1", [row.id]),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(t.current.admin.query("TRUNCATE handover_events")).rejects.toSatisfy(
      isImmutableRowError,
    );
    const { rows } = await t.current.admin.query<{ def: string }>(
      `SELECT pg_get_triggerdef(tg.oid) AS def FROM pg_trigger tg
        WHERE tg.tgname = 'handover_events_append_only'`,
    );
    // No column may change after insert.
    expect(rows[0]?.def).toMatch(/app\.forbid_update_delete\(\)$/);
  });

  it("is tenant-scoped; the session and the actor must be the tenant's", async () => {
    const row = submitted(a, 50_000, 50_000);
    await insert(a, row);
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(handoverEvents).where(eq(handoverEvents.id, row.id)),
    );
    expect(seenByB).toEqual([]);
    const countB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM handover_events WHERE operator_id <> ${b.operatorId}`,
      ),
    );
    expect(countB.rows[0]).toEqual({ n: 0 });
    await expect(insert(b, { ...submitted(b, 0, 0), sessionId: a.sessionId })).rejects.toSatisfy(
      violates(FK_VIOLATION, "handover_events_session_fk"),
    );
    await expect(insert(b, { ...submitted(b, 0, 0), actorId: a.linemanId })).rejects.toSatisfy(
      violates(FK_VIOLATION, "handover_events_actor_fk"),
    );
    await expect(
      t.current.db.withTenant(b.operatorId, (tx) =>
        tx.insert(handoverEvents).values(submitted(a, 0, 0)),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlStateOf(e) === RLS_VIOLATION);
  });
});
