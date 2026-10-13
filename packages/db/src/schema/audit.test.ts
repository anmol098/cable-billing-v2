/**
 * audit_events (FR-024): append-only for every role, tenant-scoped, platform events kept apart.
 */
import { eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import {
  createTenant,
  createUser,
  describeDb,
  type TestTenant,
  type TestUser,
  useTestDatabase,
} from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { auditEvents } from "./audit";

const RLS_VIOLATION = "42501";
const CHECK_VIOLATION = "23514";
const failsWith = (code: string) => (e: unknown) => sqlStateOf(e) === code;

describeDb("audit_events", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  let ownerA: TestUser;
  let ownerB: TestUser;
  let admin: TestUser;
  let eventA: string;

  const event = (operatorId: string | null, actor: TestUser | null) => ({
    id: uuidv7(),
    operatorId,
    actorId: actor?.userId ?? null,
    actorRole: actor?.role ?? null,
    action: "customer.update_phone",
    entityType: "customer",
    entityId: uuidv7(),
    before: { phone: "98765xxxxx" },
    after: { phone: "91234xxxxx" },
    ip: "203.0.113.7",
    userAgent: "test",
    requestId: "req-1",
  });

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    ownerA = await createUser(t.current, { operatorId: a.operatorId });
    ownerB = await createUser(t.current, { operatorId: b.operatorId });
    admin = await createUser(t.current, { operatorId: null });
    const row = event(a.operatorId, ownerA);
    eventA = row.id;
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(auditEvents).values(row));
    await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.insert(auditEvents).values(event(b.operatorId, ownerB)),
    );
  });

  it("a tenant sees only its own events and can't write another tenant's", async () => {
    const seen = await t.current.db.withTenant(a.operatorId, (tx) => tx.select().from(auditEvents));
    expect(seen.map((e) => e.id)).toEqual([eventA]);
    expect(seen[0]).toMatchObject({
      actorId: ownerA.userId,
      actorRole: "owner",
      ip: "203.0.113.7",
    });
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(auditEvents).values(event(b.operatorId, ownerA)),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(auditEvents).values(event(null, ownerA)),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
  });

  it("is append-only for every role, the owner included", async () => {
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.update(auditEvents).set({ action: "customer.other" }).where(eq(auditEvents.id, eventA)),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.delete(auditEvents).where(eq(auditEvents.id, eventA)),
      ),
    ).rejects.toSatisfy(isImmutableRowError);
    for (const statement of [
      "UPDATE audit_events SET before = NULL",
      "DELETE FROM audit_events",
      "TRUNCATE audit_events",
    ]) {
      await expect(t.current.admin.query(statement)).rejects.toSatisfy(isImmutableRowError);
    }
  });

  it("the platform role writes and reads only events without a tenant", async () => {
    const platformEvent = {
      ...event(null, admin),
      action: "operator.suspend",
      entityType: "operator",
    };
    await t.current.db.withPlatform((tx) => tx.insert(auditEvents).values(platformEvent));
    await t.current.db.withPlatform((tx) => tx.insert(auditEvents).values(event(null, null)));
    await expect(
      t.current.db.withPlatform((tx) => tx.insert(auditEvents).values(event(a.operatorId, admin))),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    const seen = await t.current.db.withPlatform((tx) => tx.select().from(auditEvents));
    expect(seen.length).toBe(2);
    expect(seen.every((e) => e.operatorId === null)).toBe(true);
    const tenantView = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select({ id: auditEvents.id }).from(auditEvents),
    );
    expect(tenantView.map((e) => e.id)).not.toContain(platformEvent.id);
  });

  it("checks actor consistency and the action / entity type format", async () => {
    const insert = (overrides: Record<string, unknown>) =>
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(auditEvents).values({ ...event(a.operatorId, ownerA), ...overrides }),
      );
    await expect(insert({ actorRole: null })).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    await expect(insert({ actorId: null })).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    for (const action of ["Customer.update", "customer..update", "customer update", ".x", ""]) {
      await expect(insert({ action })).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    }
    await expect(insert({ entityType: "Customer" })).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    await insert({ action: "payment.reverse", entityType: "payment" });
  });
});
