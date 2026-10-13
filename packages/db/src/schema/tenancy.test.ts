/**
 * Tenancy tables: FR-002 (identical names are separate tenants), operators RLS and immutability,
 * settings validation, areas.
 */
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, createUser, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { users } from "./auth";
import {
  areas,
  DEFAULT_OPERATOR_SETTINGS,
  operatorSettingsSchema,
  operators,
  parseOperatorSettings,
} from "./tenancy";

const RLS_VIOLATION = "42501";
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

const failsWith = (code: string) => (e: unknown) => sqlStateOf(e) === code;

describe("operator settings", () => {
  it("fills defaults and validates", () => {
    expect(parseOperatorSettings({})).toEqual({
      mid_month_start_policy: "start_next_month",
      invoice_prefix: "INV",
      receipt_footer: null,
      office_phone: null,
      default_language: "hi",
    });
    expect(parseOperatorSettings(null)).toEqual(DEFAULT_OPERATOR_SETTINGS);
    expect(
      parseOperatorSettings({
        mid_month_start_policy: "charge_full_month",
        office_phone: "+919876543210",
        unknown_key: 1,
      }),
    ).toMatchObject({ mid_month_start_policy: "charge_full_month", office_phone: "+919876543210" });
    expect(parseOperatorSettings({ unknown_key: 1 })).not.toHaveProperty("unknown_key");
    for (const bad of [
      { mid_month_start_policy: "prorate" },
      { invoice_prefix: "inv" },
      { invoice_prefix: "TOO-LONG-PREFIX" },
      { office_phone: "98765 43210" },
      { default_language: "ta" },
      { receipt_footer: "x".repeat(501) },
    ]) {
      expect(operatorSettingsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describeDb("operators and areas", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  it("FR-002: two operators with identical names are separate tenants with their own users and areas", async () => {
    const name = "ANMOL CABLE NETWORK";
    const one = await createTenant(t.current, { name });
    const two = await createTenant(t.current, { name });
    expect(one.operatorId).not.toBe(two.operatorId);
    const ownerOne = await createUser(t.current, { operatorId: one.operatorId });
    const ownerTwo = await createUser(t.current, { operatorId: two.operatorId });
    for (const [tenant, owner] of [
      [one, ownerOne],
      [two, ownerTwo],
    ] as const) {
      await t.current.db.withTenant(tenant.operatorId, (tx) =>
        tx
          .insert(areas)
          .values({ id: uuidv7(), operatorId: tenant.operatorId, name: "Main Bazaar" }),
      );
      const seen = await t.current.db.withTenant(tenant.operatorId, async (tx) => ({
        operators: await tx.select().from(operators),
        users: await tx.select({ id: users.id }).from(users),
        areas: await tx.select({ operatorId: areas.operatorId }).from(areas),
      }));
      expect(seen.operators.map((o) => [o.id, o.name])).toEqual([[tenant.operatorId, name]]);
      expect(seen.users).toEqual([{ id: owner.userId }]);
      expect(seen.areas).toEqual([{ operatorId: tenant.operatorId }]);
    }
    const sameName = await t.current.admin.query(
      "SELECT count(*)::int AS n FROM operators WHERE name = $1",
      [name],
    );
    expect(sameName.rows[0]).toEqual({ n: 2 });
  });

  it("new operators get valid default settings and status", async () => {
    const [row] = await t.current.db.withTenant(a.operatorId, (tx) => tx.select().from(operators));
    expect(row).toMatchObject({ status: "active", settings: DEFAULT_OPERATOR_SETTINGS });
    expect(parseOperatorSettings(row?.settings)).toEqual(DEFAULT_OPERATOR_SETTINGS);
  });

  it("a tenant sees and updates only its own operator row, and can't delete it", async () => {
    const seen = await t.current.db.withTenant(a.operatorId, (tx) => tx.select().from(operators));
    expect(seen.map((o) => o.id)).toEqual([a.operatorId]);
    const updatedOther = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx
        .update(operators)
        .set({ name: "hacked" })
        .where(eq(operators.id, b.operatorId))
        .returning(),
    );
    expect(updatedOther).toEqual([]);
    const updatedOwn = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx
        .update(operators)
        .set({ phone: "9876543210" })
        .where(eq(operators.id, a.operatorId))
        .returning({ phone: operators.phone }),
    );
    expect(updatedOwn).toEqual([{ phone: "9876543210" }]);
    const deleted = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.delete(operators).where(eq(operators.id, a.operatorId)).returning(),
    );
    expect(deleted).toEqual([]); // no DELETE policy for app_rw
  });

  it("provisioning: inside withTenant(newId) a tenant can create exactly its own operator row", async () => {
    const newId = uuidv7();
    await t.current.db.withTenant(newId, (tx) =>
      tx.insert(operators).values({ id: newId, name: "New Cable" }),
    );
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(operators).values({ id: uuidv7(), name: "Sneaky Cable" }),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
  });

  it("the platform role lists every operator but can't create, change or delete one", async () => {
    const all = await t.current.db.withPlatform((tx) =>
      tx.select({ id: operators.id }).from(operators),
    );
    expect(all.map((o) => o.id)).toEqual(expect.arrayContaining([a.operatorId, b.operatorId]));
    await expect(
      t.current.db.withPlatform((tx) => tx.insert(operators).values({ id: uuidv7(), name: "X" })),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    const updated = await t.current.db.withPlatform((tx) =>
      tx.update(operators).set({ name: "renamed" }).returning(),
    );
    expect(updated).toEqual([]);
  });

  it("the tenant id is immutable and operators are never deleted, even by the owner role", async () => {
    const fails = async (statement: string, params: unknown[]) => {
      const error = await t.current.admin.query(statement, params).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isImmutableRowError(error)).toBe(true);
    };
    const lonely = await createTenant(t.current);
    await fails("UPDATE operators SET id = $1 WHERE id = $2", [uuidv7(), lonely.operatorId]);
    await fails("DELETE FROM operators WHERE id = $1", [lonely.operatorId]);
    await fails("TRUNCATE operators CASCADE", []);
    // Ordinary profile edits still work.
    await t.current.admin.query("UPDATE operators SET name = 'Renamed' WHERE id = $1", [
      lonely.operatorId,
    ]);
  });

  it("rejects blank names and invalid settings", async () => {
    const insert = (name: string, settings: unknown) =>
      t.current.admin.query("INSERT INTO operators (id, name, settings) VALUES ($1, $2, $3)", [
        uuidv7(),
        name,
        JSON.stringify(settings),
      ]);
    await expect(insert("  ", DEFAULT_OPERATOR_SETTINGS)).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
    await expect(
      insert("Cable", { ...DEFAULT_OPERATOR_SETTINGS, mid_month_start_policy: "prorate" }),
    ).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
    await expect(insert("Cable", ["not", "an", "object"])).rejects.toSatisfy(
      failsWith(CHECK_VIOLATION),
    );
  });

  it("area names are unique per tenant (case-insensitive) but may repeat across tenants", async () => {
    const add = (tenant: TestTenant, name: string) =>
      t.current.db.withTenant(tenant.operatorId, (tx) =>
        tx.insert(areas).values({ id: uuidv7(), operatorId: tenant.operatorId, name }),
      );
    await add(a, "Station Road");
    await add(b, "Station Road");
    await expect(add(a, "station road")).rejects.toSatisfy(failsWith(UNIQUE_VIOLATION));
    await expect(add(a, " ")).rejects.toSatisfy(failsWith(CHECK_VIOLATION));
  });

  it("areas are tenant-isolated and need an existing operator", async () => {
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.insert(areas).values({ id: uuidv7(), operatorId: b.operatorId, name: "Elsewhere" }),
      ),
    ).rejects.toSatisfy(failsWith(RLS_VIOLATION));
    const ghost = uuidv7();
    await expect(
      t.current.db.withTenant(ghost, (tx) =>
        tx.insert(areas).values({ id: uuidv7(), operatorId: ghost, name: "Nowhere" }),
      ),
    ).rejects.toSatisfy(failsWith(FK_VIOLATION));
    const seen = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select({ operatorId: areas.operatorId }).from(areas),
    );
    expect(new Set(seen.map((r) => r.operatorId))).toEqual(new Set([a.operatorId]));
    const viaPlatform = await t.current.db.withPlatform((tx) =>
      tx.select().from(areas).where(sql`true`),
    );
    expect(viaPlatform).toEqual([]);
  });
});
