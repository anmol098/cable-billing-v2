/**
 * T-086a payment sync metric tables:
 * - `payment_sync_batches`: tenant-scoped; the counts add up to `items` (CHECK); the platform
 *   reads the count columns only (no id, no time, no `SELECT *`) and writes nothing; append-only.
 * - `payment_sync_rejections`: tenant-scoped, one row per rejected payment id per tenant, no
 *   platform access at all, append-only.
 * - Migration 0020 holds the exact trigger and grant SQL.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../ids";
import {
  createTenant,
  describeDb,
  MIGRATIONS_DIR,
  type TestTenant,
  useTestDatabase,
} from "../testing";
import { appendOnlyTriggerSql, isImmutableRowError, sqlStateOf } from "../triggers";
import { PLATFORM_READ_COLUMNS, platformReadGrantsSql } from "./platform-admin";
import { paymentSyncBatches, paymentSyncRejections } from "./sync-metrics";

const INSUFFICIENT_PRIVILEGE = "42501"; // also the RLS WITH CHECK violation
const CHECK_VIOLATION = "23514";

describe("payment sync platform columns", () => {
  it("are counts, the tenant and the day only", () => {
    expect(PLATFORM_READ_COLUMNS.payment_sync_batches).not.toContain("id");
    expect(PLATFORM_READ_COLUMNS.payment_sync_batches).not.toContain("received_at");
    expect(Object.keys(PLATFORM_READ_COLUMNS)).not.toContain("payment_sync_rejections");
    expect(platformReadGrantsSql(["payment_sync_batches"])).not.toContain('"customers"');
  });
});

describeDb("payment sync metric tables (T-086a)", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
  });

  const batch = (
    operatorId: string,
    overrides: Partial<typeof paymentSyncBatches.$inferInsert> = {},
  ) => ({
    id: uuidv7(),
    operatorId,
    businessDate: "2026-10-13",
    receivedAt: new Date("2026-10-13T06:00:00Z"),
    items: 4,
    posted: 2,
    duplicate: 1,
    rejectedValidation: 1,
    rejectedNewIds: 1,
    ...overrides,
  });

  it("batches: tenant-scoped; the platform counts them but reads nothing else", async () => {
    const mine = batch(a.operatorId);
    await t.current.db.withTenant(a.operatorId, (tx) => tx.insert(paymentSyncBatches).values(mine));
    const seenByB = await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.select().from(paymentSyncBatches),
    );
    expect(seenByB).toEqual([]);
    const counted = await t.current.db.withPlatform((tx) =>
      tx
        .select({
          posted: sql<number>`sum(${paymentSyncBatches.posted})::int`,
          duplicate: sql<number>`sum(${paymentSyncBatches.duplicate})::int`,
        })
        .from(paymentSyncBatches)
        .where(sql`${paymentSyncBatches.operatorId} = ${a.operatorId}`),
    );
    expect(counted).toEqual([{ posted: 2, duplicate: 1 }]);
    for (const query of [
      () => t.current.db.withPlatform((tx) => tx.select().from(paymentSyncBatches)),
      () =>
        t.current.db.withPlatform((tx) =>
          tx.select({ id: paymentSyncBatches.id }).from(paymentSyncBatches),
        ),
      () =>
        t.current.db.withPlatform((tx) =>
          tx.select({ at: paymentSyncBatches.receivedAt }).from(paymentSyncBatches),
        ),
      () =>
        t.current.db.withPlatform((tx) =>
          tx.insert(paymentSyncBatches).values(batch(a.operatorId)),
        ),
    ]) {
      const error = await query().catch((e: unknown) => e);
      expect(sqlStateOf(error)).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const otherTenant = await t.current.db
      .withTenant(b.operatorId, (tx) => tx.insert(paymentSyncBatches).values(batch(a.operatorId)))
      .catch((e: unknown) => e);
    expect(sqlStateOf(otherTenant)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it("batches: the counts add up to the items, and the dedupe counts stay inside them", async () => {
    for (const bad of [
      { items: 5 }, // 2 + 1 + 1 = 4
      { items: 0, posted: 0, duplicate: 0, rejectedValidation: 0, rejectedNewIds: 0 },
      { items: 51, posted: 49 },
      { posted: -1, items: 1 },
      { rejectedNewIds: 2 }, // only one rejected
      { acceptedAfterRejection: 3 }, // only two accepted
      // biome-ignore lint/suspicious/noExplicitAny: not an object on purpose.
      { acceptedAfterRejectionByDay: [] as any }, // must be a day → count object
    ]) {
      const error = await t.current.db
        .withTenant(a.operatorId, (tx) =>
          tx.insert(paymentSyncBatches).values(batch(a.operatorId, bad)),
        )
        .catch((e: unknown) => e);
      expect(sqlStateOf(error), JSON.stringify(bad)).toBe(CHECK_VIOLATION);
    }
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(paymentSyncBatches).values(
        batch(a.operatorId, {
          items: 50,
          posted: 10,
          postedNeedsReview: 5,
          duplicate: 10,
          rejectedValidation: 3,
          rejectedCustomerNotFound: 2,
          rejectedIdReused: 1,
          rejectedWithoutId: 1,
          rejectedNewIds: 4,
          acceptedAfterRejection: 2,
          retryLaterConflict: 6,
          retryLaterInternal: 7,
          retryLaterRateLimited: 5,
        }),
      ),
    );
  });

  it("rejections: tenant-scoped, one per payment id, no platform access, known codes", async () => {
    const id = uuidv7();
    const row = (operatorId: string, code = "VALIDATION" as const) => ({
      id,
      operatorId,
      code,
      firstRejectedAt: new Date("2026-10-13T06:00:00Z"),
    });
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(paymentSyncRejections).values(row(a.operatorId)),
    );
    // The same payment id in another tenant is another key.
    await t.current.db.withTenant(b.operatorId, (tx) =>
      tx.insert(paymentSyncRejections).values(row(b.operatorId)),
    );
    const again = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(paymentSyncRejections).values(row(a.operatorId)).onConflictDoNothing().returning(),
    );
    expect(again).toEqual([]);
    // No platform policy: default deny, so the platform role sees no rows.
    const seenByPlatform = await t.current.db.withPlatform((tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(paymentSyncRejections),
    );
    expect(seenByPlatform).toEqual([{ n: 0 }]);
    const badCode = await t.current.db
      .withTenant(a.operatorId, (tx) =>
        tx
          .insert(paymentSyncRejections)
          // biome-ignore lint/suspicious/noExplicitAny: an unknown code on purpose.
          .values({ ...row(a.operatorId), id: uuidv7(), code: "INTERNAL" as any }),
      )
      .catch((e: unknown) => e);
    expect(sqlStateOf(badCode)).toBe(CHECK_VIOLATION);
  });

  it("both tables are append-only for every role", async () => {
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(paymentSyncBatches).values(batch(a.operatorId)),
    );
    await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(paymentSyncRejections).values({
        id: uuidv7(),
        operatorId: a.operatorId,
        code: "VALIDATION",
        firstRejectedAt: new Date("2026-10-13T06:00:00Z"),
      }),
    );
    const change: Record<string, string> = {
      payment_sync_batches: "business_date = '2026-10-14'",
      payment_sync_rejections: "code = 'CUSTOMER_NOT_FOUND'",
    };
    for (const [table, set] of Object.entries(change)) {
      for (const statement of [
        `UPDATE ${table} SET ${set} WHERE operator_id = '${a.operatorId}'`,
        `DELETE FROM ${table} WHERE operator_id = '${a.operatorId}'`,
        `TRUNCATE ${table}`,
      ]) {
        const asOwner = await t.current.admin.query(statement).catch((e: unknown) => e);
        expect(isImmutableRowError(asOwner), `${table}: ${statement}`).toBe(true);
      }
    }
    const update = await t.current.db
      .withTenant(a.operatorId, (tx) => tx.update(paymentSyncBatches).set({ posted: 3, items: 5 }))
      .catch((e: unknown) => e);
    expect(isImmutableRowError(update)).toBe(true);
  });

  it("migration 0020 holds the exact trigger and grant SQL", () => {
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
      .join("\n");
    const statements = [
      appendOnlyTriggerSql({ table: "payment_sync_batches" }),
      appendOnlyTriggerSql({ table: "payment_sync_rejections" }),
      platformReadGrantsSql(["payment_sync_batches"]),
    ].flatMap((s) => s.split("\n--> statement-breakpoint\n"));
    for (const statement of statements) expect(migrations).toContain(statement);
  });
});
