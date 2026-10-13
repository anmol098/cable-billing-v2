/**
 * `invariant_checks` (T-052): tenant-scoped (RLS), append-only for every role, one row per tenant
 * and run, and the status agrees with the violation count.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import {
  createTenant,
  describeDb,
  MIGRATIONS_DIR,
  type TestTenant,
  useTestDatabase,
} from "../testing";
import { appendOnlyTriggerSql, isImmutableRowError, sqlStateOf } from "../triggers";
import { invariantChecks } from "./invariants";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

describeDb("invariant_checks", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  const row = (
    operatorId: string,
    overrides: Partial<typeof invariantChecks.$inferInsert> = {},
  ) => ({
    id: uuidv7(),
    operatorId,
    runId: uuidv7(),
    checkedAt: new Date("2026-11-01T21:00:00Z"),
    status: "ok" as const,
    violationCount: 0,
    durationMs: 12,
    ...overrides,
  });

  it("is tenant-scoped: a tenant sees and writes only its own rows", async () => {
    const mine = row(a.operatorId);
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(invariantChecks).values(mine));
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(invariantChecks).where(eq(invariantChecks.id, mine.id)),
    );
    expect(seenByB).toEqual([]);
    const seenByPlatform = await t.current.db.withPlatform((tx) =>
      tx.select().from(invariantChecks).where(eq(invariantChecks.id, mine.id)),
    );
    expect(seenByPlatform).toEqual([]);
    const error = await t.current.db
      .withTenant(b.operatorId, (tx) => tx.insert(invariantChecks).values(row(a.operatorId)))
      .catch((e: unknown) => e);
    expect(sqlStateOf(error)).toBe(RLS_VIOLATION);
  });

  it("is append-only for every role, the owner included", async () => {
    const stored = row(a.operatorId, {
      status: "breach",
      violationCount: 2,
      counts: { BALANCE_MISMATCH: 2 },
    });
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(invariantChecks).values(stored));
    const update = await t.current.db
      .withTenant(a.operatorId, (tx) =>
        tx
          .update(invariantChecks)
          .set({ status: "ok", violationCount: 0 })
          .where(eq(invariantChecks.id, stored.id)),
      )
      .catch((e: unknown) => e);
    expect(isImmutableRowError(update)).toBe(true);
    const remove = await t.current.db
      .withTenant(a.operatorId, (tx) =>
        tx.delete(invariantChecks).where(eq(invariantChecks.id, stored.id)),
      )
      .catch((e: unknown) => e);
    expect(isImmutableRowError(remove)).toBe(true);
    for (const statement of [
      "UPDATE invariant_checks SET violation_count = 0, status = 'ok' WHERE id = $1",
      "DELETE FROM invariant_checks WHERE id = $1",
    ]) {
      const ownerError = await t.current.admin.query(statement, [stored.id]).catch((e) => e);
      expect(isImmutableRowError(ownerError), statement).toBe(true);
    }
    const truncate = await t.current.admin
      .query("TRUNCATE invariant_checks")
      .catch((e: unknown) => e);
    expect(isImmutableRowError(truncate)).toBe(true);
  });

  it("one row per tenant and run; status agrees with the count", async () => {
    const first = row(a.operatorId);
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(invariantChecks).values(first));
    const again = await t.current.db
      .withTenant(a.operatorId, (tx) =>
        tx.insert(invariantChecks).values(row(a.operatorId, { runId: first.runId })),
      )
      .catch((e: unknown) => e);
    expect(sqlStateOf(again)).toBe(UNIQUE_VIOLATION);
    // The same run may store every tenant.
    await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.insert(invariantChecks).values(row(b.operatorId, { runId: first.runId })),
    );
    for (const bad of [
      { status: "ok" as const, violationCount: 1 },
      { status: "breach" as const, violationCount: 0 },
      { violationCount: -1 },
      { durationMs: -1 },
      { counts: [] as unknown as Record<string, number> },
    ]) {
      const error = await t.current.db
        .withTenant(a.operatorId, (tx) => tx.insert(invariantChecks).values(row(a.operatorId, bad)))
        .catch((e: unknown) => e);
      expect(sqlStateOf(error), JSON.stringify(bad)).toBe(CHECK_VIOLATION);
    }
  });

  it("a migration uses appendOnlyTriggerSql's exact SQL", () => {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n");
    for (const statement of appendOnlyTriggerSql({ table: "invariant_checks" }).split(
      "\n--> statement-breakpoint\n",
    )) {
      expect(migrations).toContain(statement);
    }
  });
});
