/**
 * Integration tests for tenant isolation (RLS) and the transaction wrappers, on a real Postgres.
 * Acceptance criteria of T-020: no tenant → zero rows; tenant A can't see/update/delete B's rows
 * by id; rollback; no tenant context leaks across pooled transactions.
 */
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { beforeAll, expect, it } from "vitest";
import { createDb } from "./client";
import { uuidv7 } from "./ids";
import * as schema from "./schema";
import { type Database, runInTenant, TransactionFinishedError, type Tx } from "./tenant";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "./testing";
import { applyDemoSchema, demoNotes } from "./testing/demo-schema";
import { sqlStateOf } from "./triggers";

const INSUFFICIENT_PRIVILEGE = "42501"; // also "new row violates row-level security policy"

describeDb("withTenant / withPlatform (RLS)", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  let noteA: string;
  let noteB: string;

  beforeAll(async () => {
    await applyDemoSchema(t.current.admin);
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    noteA = uuidv7();
    noteB = uuidv7();
    // Seed through the owner connection (bypasses RLS), one row per tenant.
    await t.current.admin.query(
      "INSERT INTO demo_notes (id, operator_id, body) VALUES ($1, $2, 'a'), ($3, $4, 'b')",
      [noteA, a.operatorId, noteB, b.operatorId],
    );
  });

  const notes = (tx: Tx) => tx.select().from(demoNotes);

  it("sees only the current tenant's rows", async () => {
    const rowsA = await t.current.db.withTenant(a.operatorId, notes);
    expect(rowsA.map((r) => r.id)).toEqual([noteA]);
    const rowsB = await t.current.db.withTenant(b.operatorId, notes);
    expect(rowsB.map((r) => r.id)).toEqual([noteB]);
  });

  it("runs as app_rw with the tenant set, transaction-locally", async () => {
    const state = await t.current.db.withTenant(a.operatorId, async (tx) => {
      const r = await tx.execute<{ role: string; operator: string }>(
        sql`select current_user as role, app.current_operator()::text as operator`,
      );
      return r.rows[0];
    });
    expect(state).toMatchObject({ role: "app_rw", operator: a.operatorId });
  });

  it("returns nothing when tenant A selects tenant B's row by id", async () => {
    const rows = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.select().from(demoNotes).where(eq(demoNotes.id, noteB)),
    );
    expect(rows).toEqual([]);
  });

  it("can't update or delete another tenant's row by id (0 rows affected, row unchanged)", async () => {
    const updated = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.update(demoNotes).set({ body: "hacked" }).where(eq(demoNotes.id, noteB)).returning(),
    );
    const deleted = await t.current.db.withTenant(a.operatorId, (tx) =>
      tx.delete(demoNotes).where(eq(demoNotes.id, noteB)).returning(),
    );
    expect(updated).toEqual([]);
    expect(deleted).toEqual([]);
    const still = await t.current.admin.query("SELECT body FROM demo_notes WHERE id = $1", [noteB]);
    expect(still.rows).toEqual([{ body: "b" }]);
  });

  it("can't insert a row for another tenant, nor move its own row to another tenant", async () => {
    const insert = t.current.db.withTenant(a.operatorId, (tx) =>
      tx.insert(demoNotes).values({ operatorId: b.operatorId, body: "planted" }),
    );
    await expect(insert).rejects.toSatisfy((e) => sqlStateOf(e) === INSUFFICIENT_PRIVILEGE);

    const move = t.current.db.withTenant(a.operatorId, (tx) =>
      tx.update(demoNotes).set({ operatorId: b.operatorId }).where(eq(demoNotes.id, noteA)),
    );
    await expect(move).rejects.toSatisfy((e) => sqlStateOf(e) === INSUFFICIENT_PRIVILEGE);

    const planted = await t.current.admin.query("SELECT 1 FROM demo_notes WHERE body = 'planted'");
    expect(planted.rowCount).toBe(0);
  });

  it("returns zero rows (not an error) when no tenant is set: app_rw without the GUC", async () => {
    const client = await t.current.admin.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE app_rw");
      const r = await client.query("SELECT * FROM demo_notes");
      expect(r.rows).toEqual([]);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  it("returns zero rows for a non-owner login role connecting directly (production shape B)", async () => {
    const login = await t.current.createLoginRole();
    const client = new pg.Client({ connectionString: login.url });
    await client.connect();
    try {
      // Never called set_config: the GUC doesn't even exist in this session.
      expect((await client.query("SELECT * FROM demo_notes")).rows).toEqual([]);
      // An empty GUC (what remains after a transaction-local set_config) is still "no tenant".
      await client.query("SELECT set_config('app.operator_id', '', false)");
      expect((await client.query("SELECT * FROM demo_notes")).rows).toEqual([]);
      // The same role works through createDb, with the same isolation.
      const db = createDb({ connectionString: login.url, driver: "pg", max: 1 });
      try {
        const rows = await db.withTenant(a.operatorId, notes);
        expect(rows.map((r) => r.id)).toEqual([noteA]);
      } finally {
        await db.end();
      }
    } finally {
      await client.end();
    }
  });

  it("withPlatform runs as app_platform with no tenant and sees no tenant rows", async () => {
    const result = await t.current.db.withPlatform(async (tx) => {
      const who = await tx.execute<{ role: string; operator: string | null }>(
        sql`select current_user as role, app.current_operator()::text as operator`,
      );
      return { who: who.rows[0], rows: await notes(tx) };
    });
    expect(result.who).toEqual({ role: "app_platform", operator: null });
    expect(result.rows).toEqual([]);

    const insert = t.current.db.withPlatform((tx) =>
      tx.insert(demoNotes).values({ operatorId: a.operatorId, body: "platform" }),
    );
    await expect(insert).rejects.toSatisfy((e) => sqlStateOf(e) === INSUFFICIENT_PRIVILEGE);
  });

  it("does not leak the tenant or the role to the next use of a pooled connection", async () => {
    // A pool of one connection, shared by the wrapper and raw checks, so every step below runs on
    // the same backend.
    const pool = new pg.Pool({ connectionString: t.current.url, max: 1 });
    const db = drizzle({ client: pool, schema }) as unknown as Database;
    const sessionState = async () => {
      const r = await pool.query<{
        pid: number;
        role: string;
        setting: string;
        operator: string | null;
      }>(
        `select pg_backend_pid() as pid, current_user as role,
                coalesce(current_setting('app.operator_id', true), '') as setting,
                app.current_operator()::text as operator`,
      );
      return r.rows[0];
    };
    try {
      const before = await sessionState();
      expect(before).toMatchObject({ setting: "", operator: null });
      expect(["app_rw", "app_platform"]).not.toContain(before?.role);

      const inside = await runInTenant(db, a.operatorId, async (tx) => {
        const r = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
        return { pid: r.rows[0]?.pid, rows: await notes(tx) };
      });
      expect(inside.pid).toBe(before?.pid);
      expect(inside.rows.map((r) => r.id)).toEqual([noteA]);

      // After COMMIT: back to the session role, no tenant.
      expect(await sessionState()).toEqual({ ...before, setting: "", operator: null });

      // After ROLLBACK too.
      await expect(
        runInTenant(db, b.operatorId, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await sessionState()).toEqual({ ...before, setting: "", operator: null });

      // And after a failed statement inside the transaction (aborted transaction state).
      await expect(
        runInTenant(db, b.operatorId, (tx) => tx.execute(sql`select 1/0`)),
      ).rejects.toSatisfy((e) => sqlStateOf(e) === "22012");
      expect(await sessionState()).toEqual({ ...before, setting: "", operator: null });
    } finally {
      await pool.end();
    }
  });

  it("rolls back every write when the callback throws", async () => {
    const id = uuidv7();
    await expect(
      t.current.db.withTenant(a.operatorId, async (tx) => {
        await tx.insert(demoNotes).values({ id, operatorId: a.operatorId, body: "rolled back" });
        expect(await tx.select().from(demoNotes).where(eq(demoNotes.id, id))).toHaveLength(1);
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    const r = await t.current.admin.query("SELECT 1 FROM demo_notes WHERE id = $1", [id]);
    expect(r.rowCount).toBe(0);
  });

  it("commits when the callback resolves, and nested transactions roll back to their savepoint", async () => {
    const kept = uuidv7();
    const undone = uuidv7();
    await t.current.db.withTenant(a.operatorId, async (tx) => {
      await tx.insert(demoNotes).values({ id: kept, operatorId: a.operatorId, body: "kept" });
      await tx
        .transaction(async (inner) => {
          await inner.insert(demoNotes).values({ id: undone, operatorId: a.operatorId, body: "x" });
          throw new Error("inner");
        })
        .catch(() => {});
    });
    const r = await t.current.admin.query<{ id: string }>(
      "SELECT id FROM demo_notes WHERE id = ANY ($1)",
      [[kept, undone]],
    );
    expect(r.rows.map((row) => row.id)).toEqual([kept]);
  });

  it("refuses to use tx after the callback finished", async () => {
    let escaped: Tx | undefined;
    await t.current.db.withTenant(a.operatorId, async (tx) => {
      escaped = tx;
    });
    expect(() => escaped?.select()).toThrow(TransactionFinishedError);
  });

  it("rejects an operatorId that is not a UUID, before touching the database", async () => {
    for (const bad of ["", "abc", `${a.operatorId}'; select 1; --`]) {
      await expect(t.current.db.withTenant(bad, notes)).rejects.toThrow(TypeError);
    }
  });

  it("passes isolation level and access mode through", async () => {
    const level = await t.current.db.withTenant(
      a.operatorId,
      async (tx) =>
        (
          await tx.execute<{ level: string }>(
            sql`select current_setting('transaction_isolation') as level`,
          )
        ).rows[0]?.level,
      { isolationLevel: "serializable" },
    );
    expect(level).toBe("serializable");
    const readOnly = t.current.db.withTenant(
      a.operatorId,
      (tx) => tx.insert(demoNotes).values({ operatorId: a.operatorId, body: "ro" }),
      { accessMode: "read only" },
    );
    await expect(readOnly).rejects.toSatisfy((e) => sqlStateOf(e) === "25006");
  });
});
