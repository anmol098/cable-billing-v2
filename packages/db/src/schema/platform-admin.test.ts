/**
 * T-086 platform admin tables and platform read access:
 * - `support_access_grants`: tenant-scoped, readable by the platform, time box ≤ 2 h (CHECK),
 *   reason required, append-only except ending early, and ending is final (no reopening, no
 *   moving the end).
 * - `subscription_offline_payments`: tenant-scoped, readable by the platform, fully append-only.
 * - `PLATFORM_READ_COLUMNS`: the catalog grants `app_platform` exactly those columns (no
 *   table-wide SELECT), so `SELECT *` and every name, phone, amount and note column is refused.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import {
  createTenant,
  createUser,
  describeDb,
  MIGRATIONS_DIR,
  type TestTenant,
  type TestUser,
  useTestDatabase,
} from "../testing";
import { appendOnlyTriggerSql, isImmutableRowError, sqlStateOf } from "../triggers";
import { customers } from "./customers";
import {
  PLATFORM_READ_COLUMNS,
  platformReadGrantsSql,
  SUPPORT_GRANT_END_FINAL_SQL,
  subscriptionOfflinePayments,
  supportAccessGrants,
} from "./platform-admin";

const RLS_VIOLATION = "42501";
const CHECK_VIOLATION = "23514";

describe("platformReadGrantsSql", () => {
  it("revokes the table-wide SELECT and grants only the listed columns", () => {
    const text = platformReadGrantsSql();
    for (const [table, columns] of Object.entries(PLATFORM_READ_COLUMNS)) {
      expect(text).toContain(`REVOKE SELECT ON TABLE "public"."${table}" FROM app_platform;`);
      expect(text).toContain(
        `GRANT SELECT (${columns.map((c) => `"${c}"`).join(", ")}) ON TABLE "public"."${table}"`,
      );
    }
  });
});

describeDb("platform admin tables (T-086)", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  let admin: TestUser;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    admin = await createUser(t.current, { operatorId: null });
  });

  const grant = (
    operatorId: string,
    overrides: Partial<typeof supportAccessGrants.$inferInsert> = {},
  ) => {
    const grantedAt = new Date("2026-11-01T10:00:00Z");
    return {
      id: uuidv7(),
      operatorId,
      adminUserId: admin.userId,
      reason: "Owner called: bills look wrong",
      grantedAt,
      expiresAt: new Date(grantedAt.getTime() + 120 * 60_000),
      ...overrides,
    };
  };

  const payment = (
    operatorId: string,
    overrides: Partial<typeof subscriptionOfflinePayments.$inferInsert> = {},
  ) => ({
    id: uuidv7(),
    operatorId,
    amountPaise: 47_200,
    method: "bank_transfer" as const,
    reference: "UTR123",
    receivedOn: "2026-11-01",
    months: 1,
    paidUntil: new Date("2026-12-01T18:30:00Z"),
    recordedBy: admin.userId,
    recordedAt: new Date("2026-11-01T10:00:00Z"),
    ...overrides,
  });

  it("grants: tenant-scoped for app_rw, read-only for the platform", async () => {
    const mine = grant(a.operatorId);
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(supportAccessGrants).values(mine),
    );
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(supportAccessGrants).where(eq(supportAccessGrants.id, mine.id)),
    );
    expect(seenByB).toEqual([]);
    const seenByPlatform = await t.current.db.withPlatform((tx) =>
      tx.select().from(supportAccessGrants).where(eq(supportAccessGrants.id, mine.id)),
    );
    expect(seenByPlatform.map((r) => r.id)).toEqual([mine.id]);
    // The platform role writes nothing: inserts fail RLS, updates match no row.
    const platformInsert = await t.current.db
      .withPlatform((tx) => tx.insert(supportAccessGrants).values(grant(a.operatorId)))
      .catch((e: unknown) => e);
    expect(sqlStateOf(platformInsert)).toBe(RLS_VIOLATION);
    const platformUpdate = await t.current.db.withPlatform((tx) =>
      tx
        .update(supportAccessGrants)
        .set({ endedAt: new Date("2026-11-01T10:30:00Z"), endedBy: admin.userId })
        .where(eq(supportAccessGrants.id, mine.id))
        .returning(),
    );
    expect(platformUpdate).toEqual([]);
    const otherTenant = await t.current.db
      .withTenant(b.operatorId, (tx) => tx.insert(supportAccessGrants).values(grant(a.operatorId)))
      .catch((e: unknown) => e);
    expect(sqlStateOf(otherTenant)).toBe(RLS_VIOLATION);
  });

  it("grants: at most 2 hours, a real reason, ended fields together", async () => {
    const at = new Date("2026-11-01T10:00:00Z");
    for (const bad of [
      { expiresAt: new Date(at.getTime() + 120 * 60_000 + 1000) },
      { expiresAt: at },
      { reason: "   short  " },
      { reason: "x".repeat(501) },
      { endedAt: new Date(at.getTime() + 60_000) },
      { endedBy: admin.userId },
      { endedAt: new Date(at.getTime() - 60_000), endedBy: admin.userId },
    ]) {
      const error = await t.current.db
        .withTenant(a.operatorId, (tx) =>
          tx.insert(supportAccessGrants).values(grant(a.operatorId, bad)),
        )
        .catch((e: unknown) => e);
      expect(sqlStateOf(error), JSON.stringify(bad)).toBe(CHECK_VIOLATION);
    }
  });

  it("grants: only ending early may change; never deleted", async () => {
    const g = grant(a.operatorId);
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(supportAccessGrants).values(g));
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx
        .update(supportAccessGrants)
        .set({ endedAt: new Date("2026-11-01T10:20:00Z"), endedBy: admin.userId })
        .where(eq(supportAccessGrants.id, g.id)),
    );
    for (const change of [
      { expiresAt: new Date("2026-11-01T11:00:00Z") },
      { reason: "a different reason here" },
      { adminUserId: uuidv7() },
    ]) {
      const error = await t.current.db
        .withTenant(a.operatorId, (tx) =>
          tx.update(supportAccessGrants).set(change).where(eq(supportAccessGrants.id, g.id)),
        )
        .catch((e: unknown) => e);
      expect(isImmutableRowError(error), JSON.stringify(change)).toBe(true);
    }
    const remove = await t.current.admin
      .query("DELETE FROM support_access_grants WHERE id = $1", [g.id])
      .catch((e: unknown) => e);
    expect(isImmutableRowError(remove)).toBe(true);
    const truncate = await t.current.admin
      .query("TRUNCATE support_access_grants")
      .catch((e: unknown) => e);
    expect(isImmutableRowError(truncate)).toBe(true);
  });

  it("grants: ending is final (no reopening, no moving the end or who ended it)", async () => {
    const g = grant(a.operatorId);
    const update = (set: Partial<typeof supportAccessGrants.$inferInsert>) =>
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx
          .update(supportAccessGrants)
          .set(set)
          .where(eq(supportAccessGrants.id, g.id))
          .returning({ id: supportAccessGrants.id }),
      );
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(supportAccessGrants).values(g));
    const endedAt = new Date("2026-11-01T10:20:00Z");
    const other = await createUser(t.current, { operatorId: null });
    expect(await update({ endedAt, endedBy: admin.userId })).toEqual([{ id: g.id }]);
    for (const change of [
      // Un-ending: back to NULL (reopens the grant).
      { endedAt: null, endedBy: null },
      // Re-ending: a different end time, a different admin, or both.
      { endedAt: new Date("2026-11-01T10:40:00Z") },
      { endedAt: new Date("2026-11-01T10:10:00Z"), endedBy: admin.userId },
      { endedBy: other.userId },
      { endedAt: new Date("2026-11-01T10:40:00Z"), endedBy: other.userId },
    ]) {
      const error = await update(change).catch((e: unknown) => e);
      expect(isImmutableRowError(error), JSON.stringify(change)).toBe(true);
    }
    // The superuser connection (no RLS) is refused too: the trigger, not a policy, holds.
    const asAdmin = await t.current.admin
      .query("UPDATE support_access_grants SET ended_at = NULL, ended_by = NULL WHERE id = $1", [
        g.id,
      ])
      .catch((e: unknown) => e);
    expect(isImmutableRowError(asAdmin)).toBe(true);
    // Writing the same values again changes nothing and passes; the row is as it was ended.
    expect(await update({ endedAt, endedBy: admin.userId })).toEqual([{ id: g.id }]);
    const [row] = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select().from(supportAccessGrants).where(eq(supportAccessGrants.id, g.id)),
    );
    expect(row).toMatchObject({ endedAt, endedBy: admin.userId, expiresAt: g.expiresAt });
  });

  it("offline payments: tenant-scoped, platform reads, fully append-only, checked", async () => {
    const p = payment(a.operatorId);
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(subscriptionOfflinePayments).values(p),
    );
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(subscriptionOfflinePayments),
    );
    expect(seenByB).toEqual([]);
    const seenByPlatform = await t.current.db.withPlatform((tx) =>
      tx
        .select({ id: subscriptionOfflinePayments.id })
        .from(subscriptionOfflinePayments)
        .where(eq(subscriptionOfflinePayments.id, p.id)),
    );
    expect(seenByPlatform).toEqual([{ id: p.id }]);
    const platformInsert = await t.current.db
      .withPlatform((tx) => tx.insert(subscriptionOfflinePayments).values(payment(a.operatorId)))
      .catch((e: unknown) => e);
    expect(sqlStateOf(platformInsert)).toBe(RLS_VIOLATION);
    for (const statement of [
      "UPDATE subscription_offline_payments SET note = 'x' WHERE id = $1",
      "DELETE FROM subscription_offline_payments WHERE id = $1",
    ]) {
      const error = await t.current.admin.query(statement, [p.id]).catch((e: unknown) => e);
      expect(isImmutableRowError(error), statement).toBe(true);
    }
    for (const bad of [
      { amountPaise: 0 },
      { months: 0 },
      { months: 13 },
      { method: "card" as never },
      { reference: "r".repeat(101) },
      { note: "n".repeat(501) },
    ]) {
      const error = await t.current.db
        .withTenant(a.operatorId, (tx) =>
          tx.insert(subscriptionOfflinePayments).values(payment(a.operatorId, bad)),
        )
        .catch((e: unknown) => e);
      expect(sqlStateOf(error), JSON.stringify(bad)).toBe(CHECK_VIOLATION);
    }
  });

  it("app_platform may SELECT exactly PLATFORM_READ_COLUMNS of those tenant tables", async () => {
    for (const [table, allowed] of Object.entries(PLATFORM_READ_COLUMNS)) {
      const tableWide = await t.current.admin.query<{ ok: boolean }>(
        "SELECT has_table_privilege('app_platform', $1, 'SELECT') AS ok",
        [`public.${table}`],
      );
      expect(tableWide.rows[0]?.ok, `${table}: table-wide SELECT`).toBe(false);
      const columns = await t.current.admin.query<{ column: string; ok: boolean }>(
        `SELECT a.attname AS column, has_column_privilege('app_platform', a.attrelid, a.attname, 'SELECT') AS ok
           FROM pg_attribute a
          WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
        [`public.${table}`],
      );
      const readable = columns.rows.filter((c) => c.ok).map((c) => c.column);
      expect(readable.sort(), table).toEqual([...allowed].sort());
      // app_rw keeps every column (tenant code is unaffected).
      const rw = await t.current.admin.query<{ ok: boolean }>(
        "SELECT has_table_privilege('app_rw', $1, 'SELECT') AS ok",
        [`public.${table}`],
      );
      expect(rw.rows[0]?.ok, `${table}: app_rw`).toBe(true);
    }
  });

  it("the platform counts customers by status but can't read names or SELECT *", async () => {
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(customers).values({
        id: uuidv7(),
        operatorId: a.operatorId,
        customerCode: "C1",
        name: "Ramesh",
        phone: "9876543210",
      }),
    );
    const counts = await t.current.db.withPlatform((tx) =>
      tx
        .select({ operatorId: customers.operatorId, n: sql<number>`count(*)::int` })
        .from(customers)
        .where(eq(customers.operatorId, a.operatorId))
        .groupBy(customers.operatorId),
    );
    expect(counts).toEqual([{ operatorId: a.operatorId, n: 1 }]);
    for (const query of [
      () => t.current.db.withPlatform((tx) => tx.select().from(customers)),
      () => t.current.db.withPlatform((tx) => tx.select({ name: customers.name }).from(customers)),
      () =>
        t.current.db.withPlatform((tx) => tx.select({ phone: customers.phone }).from(customers)),
    ]) {
      const error = await query().catch((e: unknown) => e);
      expect(sqlStateOf(error)).toBe(RLS_VIOLATION); // 42501 insufficient_privilege
    }
  });

  it("migrations use the exact append-only and grant SQL", () => {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n");
    const statements = [
      appendOnlyTriggerSql({
        table: "support_access_grants",
        allowedColumns: ["ended_at", "ended_by"],
      }),
      SUPPORT_GRANT_END_FINAL_SQL,
      appendOnlyTriggerSql({ table: "subscription_offline_payments" }),
      platformReadGrantsSql(),
    ].flatMap((s) => s.split("\n--> statement-breakpoint\n"));
    for (const statement of statements) expect(migrations).toContain(statement);
  });
});
