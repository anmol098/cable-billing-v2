import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "../testing";
import { applyDemoSchema, demoPayments } from "../testing/demo-schema";
import {
  appendOnlyTriggerSql,
  IMMUTABLE_ROW_SQLSTATE,
  isImmutableRowError,
  sqlStateOf,
} from "./index";

describe("appendOnlyTriggerSql", () => {
  it("emits a row trigger with the allowed columns and a truncate trigger", () => {
    expect(appendOnlyTriggerSql({ table: "payments", allowedColumns: ["review_status"] })).toBe(
      [
        'CREATE TRIGGER "payments_append_only"',
        '  BEFORE UPDATE OR DELETE ON "public"."payments"',
        "  FOR EACH ROW",
        "  EXECUTE FUNCTION app.forbid_update_delete('review_status');",
        "--> statement-breakpoint",
        'CREATE TRIGGER "payments_no_truncate"',
        '  BEFORE TRUNCATE ON "public"."payments"',
        "  FOR EACH STATEMENT",
        "  EXECUTE FUNCTION app.forbid_update_delete();",
      ].join("\n"),
    );
  });

  it("supports a WHEN condition and no allowed columns", () => {
    const out = appendOnlyTriggerSql({ table: "invoices", when: "OLD.status <> 'draft'" });
    expect(out).toContain("FOR EACH ROW\n  WHEN (OLD.status <> 'draft')\n");
    expect(out).toContain("app.forbid_update_delete();");
  });

  it("rejects anything that is not a plain lower-case identifier", () => {
    expect(() => appendOnlyTriggerSql({ table: 'x"; drop table y; --' })).toThrow(TypeError);
    expect(() => appendOnlyTriggerSql({ table: "t", allowedColumns: ["a'b"] })).toThrow(TypeError);
    expect(() => appendOnlyTriggerSql({ table: "Payments" })).toThrow(TypeError);
  });
});

describe("sqlStateOf / isImmutableRowError", () => {
  it("finds the SQLSTATE through wrapped errors", () => {
    const driverError = Object.assign(new Error("db"), { code: IMMUTABLE_ROW_SQLSTATE });
    const wrapped = new Error("Failed query", { cause: driverError });
    expect(sqlStateOf(wrapped)).toBe(IMMUTABLE_ROW_SQLSTATE);
    expect(isImmutableRowError(wrapped)).toBe(true);
    expect(isImmutableRowError(new Error("other"))).toBe(false);
    expect(sqlStateOf(Object.assign(new Error("node"), { code: "ECONNREFUSED" }))).toBeUndefined();
  });
});

describeDb("app.forbid_update_delete() (append-only trigger)", () => {
  const t = useTestDatabase();
  let tenant: TestTenant;
  let paymentId: string;

  beforeAll(async () => {
    await applyDemoSchema(t.current.admin);
    tenant = await createTenant(t.current);
  });

  beforeAll(async () => {
    paymentId = uuidv7();
    await t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx
        .insert(demoPayments)
        .values({ id: paymentId, operatorId: tenant.operatorId, amountPaise: 50_000 }),
    );
  });

  const row = async () =>
    (
      await t.current.admin.query(
        "SELECT amount_paise::text AS amount, review_status, review_reason FROM demo_payments WHERE id = $1",
        [paymentId],
      )
    ).rows[0];

  it("blocks UPDATE of a non-allowed column, as the app role", async () => {
    const update = t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx.update(demoPayments).set({ amountPaise: 1 }).where(eq(demoPayments.id, paymentId)),
    );
    await expect(update).rejects.toSatisfy(isImmutableRowError);
    expect(await row()).toMatchObject({ amount: "50000" });
  });

  it("blocks an UPDATE that mixes allowed and non-allowed columns", async () => {
    const update = t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx
        .update(demoPayments)
        .set({ reviewStatus: "needs_review", amountPaise: 2 })
        .where(eq(demoPayments.id, paymentId)),
    );
    await expect(update).rejects.toSatisfy(isImmutableRowError);
    expect(await row()).toMatchObject({ amount: "50000", review_status: "none" });
  });

  it("allows UPDATE of the allowed columns only", async () => {
    await t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx
        .update(demoPayments)
        .set({ reviewStatus: "needs_review", reviewReason: "duplicate?" })
        .where(eq(demoPayments.id, paymentId)),
    );
    expect(await row()).toEqual({
      amount: "50000",
      review_status: "needs_review",
      review_reason: "duplicate?",
    });
  });

  it("allows a no-op UPDATE that sets non-allowed columns to their current value", async () => {
    await t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx.update(demoPayments).set({ amountPaise: 50_000 }).where(eq(demoPayments.id, paymentId)),
    );
    expect(await row()).toMatchObject({ amount: "50000" });
  });

  it("blocks DELETE, as the app role and as the owner", async () => {
    const del = t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx.delete(demoPayments).where(eq(demoPayments.id, paymentId)),
    );
    await expect(del).rejects.toSatisfy(isImmutableRowError);
    await expect(
      t.current.admin.query("DELETE FROM demo_payments WHERE id = $1", [paymentId]),
    ).rejects.toSatisfy((e) => sqlStateOf(e) === IMMUTABLE_ROW_SQLSTATE);
    expect(await row()).toBeDefined();
  });

  it("blocks UPDATE by the owner too (triggers apply to every role)", async () => {
    await expect(
      t.current.admin.query("UPDATE demo_payments SET amount_paise = 0 WHERE id = $1", [paymentId]),
    ).rejects.toSatisfy((e) => sqlStateOf(e) === IMMUTABLE_ROW_SQLSTATE);
  });

  it("blocks TRUNCATE", async () => {
    await expect(t.current.admin.query("TRUNCATE demo_payments")).rejects.toSatisfy(
      (e) => sqlStateOf(e) === IMMUTABLE_ROW_SQLSTATE,
    );
    expect(await row()).toBeDefined();
  });

  it("names the columns in the error, never the values", async () => {
    const error = await t.current.admin
      .query("UPDATE demo_payments SET amount_paise = 123456789 WHERE id = $1", [paymentId])
      .catch((e: Error) => e);
    expect(String(error)).toContain("amount_paise");
    expect(String(error)).not.toContain("123456789");
    expect(String(error)).not.toContain("50000");
  });

  it("fails loudly on an allowed-column name that doesn't exist (typo)", async () => {
    await t.current.admin.query(`
      CREATE TABLE demo_typo (id uuid PRIMARY KEY, amount_paise bigint NOT NULL);
      CREATE TRIGGER demo_typo_append_only BEFORE UPDATE OR DELETE ON demo_typo
        FOR EACH ROW EXECUTE FUNCTION app.forbid_update_delete('amount_piase');
      INSERT INTO demo_typo VALUES ('${uuidv7()}', 1);
    `);
    await expect(t.current.admin.query("UPDATE demo_typo SET amount_paise = 1")).rejects.toSatisfy(
      (e) => sqlStateOf(e) === "42703",
    );
    await t.current.admin.query("DROP TABLE demo_typo");
  });

  it("allows INSERT (append) as usual", async () => {
    await t.current.db.withTenant(tenant.operatorId, (tx) =>
      tx.insert(demoPayments).values({ operatorId: tenant.operatorId, amountPaise: 100 }),
    );
    const count = await t.current.db.withTenant(tenant.operatorId, (tx) => tx.$count(demoPayments));
    expect(count).toBe(2);
  });
});
