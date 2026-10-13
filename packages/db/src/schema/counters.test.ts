/**
 * T-021 acceptance: `app.next_counter` is gap-free and safe under 50 concurrent calls; counters
 * are per tenant and per name, RLS-scoped, and can't be deleted or wound back.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, type DbClient } from "../client";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { isImmutableRowError, sqlStateOf } from "../triggers";
import { counters, nextCounter } from "./counters";

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describeDb("counters / app.next_counter", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  // A wider pool than the harness's 4 connections, so many transactions really wait on the row lock.
  let wide: DbClient;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    wide = createDb({ connectionString: t.current.url, driver: "pg", max: 20 });
  });

  afterAll(async () => {
    await wide?.end();
  });

  const counterValue = async (operatorId: string, name: string) =>
    (
      await t.current.admin.query<{ next_value: string }>(
        "SELECT next_value FROM counters WHERE operator_id = $1 AND name = $2",
        [operatorId, name],
      )
    ).rows[0]?.next_value;

  it("starts at 1 and counts up per tenant and per counter name", async () => {
    const take = (tenant: TestTenant, name: "invoice" | "receipt") =>
      t.current.db.withTenant(tenant.operatorId, (tx) => nextCounter(tx, tenant.operatorId, name));
    expect(await take(a, "invoice")).toBe(1);
    expect(await take(a, "invoice")).toBe(2);
    expect(await take(a, "receipt")).toBe(1);
    expect(await take(b, "invoice")).toBe(1);
    expect(await take(a, "invoice")).toBe(3);
    expect(await counterValue(a.operatorId, "invoice")).toBe("4");
  });

  it("hands out exactly 1..50 to 50 concurrent transactions (no gaps, no duplicates)", async () => {
    const tenant = await createTenant(t.current);
    const values = await Promise.all(
      range(1, 50).map(() =>
        wide.withTenant(tenant.operatorId, async (tx) => {
          const value = await nextCounter(tx, tenant.operatorId, "customer_code");
          // Hold the row lock a moment so the other transactions queue behind it.
          await tx.execute(sql`select pg_sleep(0.005)`);
          return value;
        }),
      ),
    );
    expect([...values].sort((x, y) => x - y)).toEqual(range(1, 50));
    expect(await counterValue(tenant.operatorId, "customer_code")).toBe("51");
  });

  it("gives a rolled-back number to the next caller, so committed numbers stay gap-free", async () => {
    const tenant = await createTenant(t.current);
    const outcomes = await Promise.allSettled(
      range(1, 50).map((i) =>
        wide.withTenant(tenant.operatorId, async (tx) => {
          const value = await nextCounter(tx, tenant.operatorId, "receipt");
          await tx.execute(sql`select pg_sleep(0.002)`);
          if (i % 5 === 0) throw new Error("rollback after taking a number");
          return value;
        }),
      ),
    );
    const committed = outcomes
      .filter((o): o is PromiseFulfilledResult<number> => o.status === "fulfilled")
      .map((o) => o.value)
      .sort((x, y) => x - y);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(10);
    expect(committed).toEqual(range(1, 40));
    expect(await counterValue(tenant.operatorId, "receipt")).toBe("41");
  });

  it("can't read or advance another tenant's counter (RLS)", async () => {
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) => nextCounter(tx, b.operatorId, "invoice")),
    ).rejects.toSatisfy((e) => sqlStateOf(e) === "42501");
    const seen = await t.current.db.withTenant(a.operatorId, (tx) => tx.select().from(counters));
    expect(new Set(seen.map((c) => c.operatorId))).toEqual(new Set([a.operatorId]));
    expect(await counterValue(b.operatorId, "invoice")).toBe("2");
  });

  it("is not callable by the platform role", async () => {
    await expect(
      t.current.db.withPlatform((tx) => nextCounter(tx, a.operatorId, "invoice")),
    ).rejects.toSatisfy((e) => sqlStateOf(e) === "42501");
  });

  it("can't be deleted, truncated or wound back, even by the owner", async () => {
    const admin = t.current.admin;
    const fails = async (statement: string) => {
      const error = await admin.query(statement, []).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isImmutableRowError(error)).toBe(true);
    };
    await fails(`DELETE FROM counters WHERE operator_id = '${a.operatorId}'`);
    await fails("TRUNCATE counters");
    await fails(
      `UPDATE counters SET next_value = 1 WHERE operator_id = '${a.operatorId}' AND name = 'invoice'`,
    );
    await fails(
      `UPDATE counters SET operator_id = '${b.operatorId}' WHERE operator_id = '${a.operatorId}' AND name = 'receipt'`,
    );
    // Moving a counter forward (e.g. continuing legacy numbering) is allowed.
    await admin.query(
      "UPDATE counters SET next_value = 1000 WHERE operator_id = $1 AND name = 'receipt'",
      [a.operatorId],
    );
    expect(
      await t.current.db.withTenant(a.operatorId, (tx) => nextCounter(tx, a.operatorId, "receipt")),
    ).toBe(1000);
  });

  it("rejects unknown counter names", async () => {
    await expect(
      t.current.db.withTenant(a.operatorId, (tx) =>
        tx.execute(sql`select app.next_counter(${a.operatorId}::uuid, 'invoices')`),
      ),
    ).rejects.toSatisfy((e) => sqlStateOf(e) === "22P02");
  });
});
