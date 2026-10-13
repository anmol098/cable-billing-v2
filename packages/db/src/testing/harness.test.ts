/**
 * The harness itself, the migrations, and the catalog security audit of the migrated schema.
 *
 * The audit test below runs against the real migrated database, so every table later tasks add
 * is checked: RLS on, tenant policy present, app roles own nothing. Allow-list a global table only
 * with a reason, in ALLOW_WITHOUT_RLS.
 */
import { randomBytes } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { createDb } from "../client";
import { applyDemoSchema } from "./demo-schema";
import { describeUrl, quoteIdent, withCredentials, withDatabase } from "./env";
import {
  auditDatabaseSecurity,
  createTenant,
  describeDb,
  migrateDatabase,
  migrationsHash,
  testDatabaseUrl,
  useTestDatabase,
} from "./index";

/** Global tables (no operator_id) that may skip RLS, with the reason. Later tasks append here. */
const ALLOW_WITHOUT_RLS: Record<string, string> = {};

/** Materialized views / SECURITY DEFINER functions that are allowed, with the reason. */
const ALLOW_DEFINER_OBJECTS: Record<string, string> = {};

describe("harness helpers", () => {
  it("hashes the migrations folder deterministically", () => {
    expect(migrationsHash()).toMatch(/^[0-9a-f]{16}$/);
    expect(migrationsHash()).toBe(migrationsHash());
  });

  it("rewrites URLs without leaking credentials into messages", () => {
    const url = "postgres://postgres:secret@localhost:5432/cable_billing";
    expect(withDatabase(url, "cb_test_1_a")).toBe(
      "postgres://postgres:secret@localhost:5432/cb_test_1_a",
    );
    expect(withCredentials(url, "u", "p@ss")).toBe(
      "postgres://u:p%40ss@localhost:5432/cable_billing",
    );
    expect(describeUrl(url)).toBe("localhost:5432/cable_billing");
    expect(() => quoteIdent('x"; drop')).toThrow(TypeError);
  });

  it("refuses remote hosts unless explicitly allowed", () => {
    const saved = {
      url: process.env.DATABASE_URL,
      allow: process.env.CB_TEST_DATABASE_ALLOW_REMOTE,
    };
    try {
      process.env.DATABASE_URL = "postgres://u:p@ep-cool-name.ap-southeast-1.aws.neon.tech/neondb";
      delete process.env.CB_TEST_DATABASE_ALLOW_REMOTE;
      expect(() => testDatabaseUrl()).toThrow(/Refusing to create test databases on remote host/);
    } finally {
      if (saved.url === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = saved.url;
      if (saved.allow !== undefined) process.env.CB_TEST_DATABASE_ALLOW_REMOTE = saved.allow;
    }
  });
});

describeDb("migrated database", () => {
  const t = useTestDatabase();

  it("passes the security audit (roles, ownership, RLS on every table, tenant policies)", async () => {
    const problems = await auditDatabaseSecurity(t.current.admin, {
      allowWithoutRls: ALLOW_WITHOUT_RLS,
      allowDefinerObjects: ALLOW_DEFINER_OBJECTS,
    });
    expect(problems).toEqual([]);
  });

  it("has the foundation objects", async () => {
    const r = await t.current.admin.query(`
      SELECT (SELECT count(*) FROM pg_extension WHERE extname = 'btree_gist')::int AS btree_gist,
             to_regprocedure('app.current_operator()') IS NOT NULL AS current_operator,
             to_regprocedure('app.forbid_update_delete()') IS NOT NULL AS forbid_update_delete,
             has_schema_privilege('app_rw', 'public', 'CREATE') AS rw_can_create,
             has_schema_privilege('app_platform', 'public', 'CREATE') AS platform_can_create,
             has_schema_privilege('app_rw', 'drizzle', 'USAGE') AS rw_sees_migrations`);
    expect(r.rows[0]).toEqual({
      btree_gist: 1,
      current_operator: true,
      forbid_update_delete: true,
      rw_can_create: false,
      platform_can_create: false,
      rw_sees_migrations: false,
    });
  });

  it("app.current_operator() is NULL when unset or empty and the uuid when set", async () => {
    const client = await t.current.admin.connect();
    try {
      const read = async () =>
        (await client.query<{ op: string | null }>("SELECT app.current_operator()::text AS op"))
          .rows[0]?.op;
      expect(await read()).toBeNull();
      const tenant = await createTenant(t.current);
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.operator_id', $1, true)", [tenant.operatorId]);
      expect(await read()).toBe(tenant.operatorId);
      await client.query("COMMIT");
      // After a transaction-local setting ends, Postgres leaves '' behind, not NULL.
      expect(
        (await client.query("SELECT current_setting('app.operator_id', true) AS s")).rows[0]?.s,
      ).toBe("");
      expect(await read()).toBeNull();
    } finally {
      client.release();
    }
  });

  it("flags tables that break the rules (the audit has teeth)", async () => {
    await applyDemoSchema(t.current.admin);
    await t.current.admin.query(`
      CREATE TABLE bad_no_rls (id uuid PRIMARY KEY, operator_id uuid NOT NULL);
      CREATE TABLE bad_public_policy (id uuid PRIMARY KEY, operator_id uuid NOT NULL);
      ALTER TABLE bad_public_policy ENABLE ROW LEVEL SECURITY;
      CREATE POLICY open ON bad_public_policy USING (true);
      CREATE TABLE global_without_rls (id uuid PRIMARY KEY);
      CREATE VIEW bad_view AS SELECT * FROM demo_notes;
      CREATE FUNCTION public.bad_definer() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      CREATE TABLE owned_by_app (id uuid PRIMARY KEY);
      ALTER TABLE owned_by_app OWNER TO app_rw;
    `);
    try {
      const problems = await auditDatabaseSecurity(t.current.admin, {
        allowWithoutRls: { global_without_rls: "test: a global table", owned_by_app: "test" },
      });
      expect(problems).toEqual(
        expect.arrayContaining([
          "table bad_no_rls has row-level security disabled (enable it or allow-list it)",
          expect.stringContaining("tenant table bad_no_rls has no ALL policy"),
          expect.stringContaining("tenant table bad_public_policy has no ALL policy"),
          "tenant table bad_public_policy: policy open applies to PUBLIC",
          "view bad_view must be created WITH (security_invoker = true)",
          expect.stringContaining("function public.bad_definer is SECURITY DEFINER"),
          "relation public.owned_by_app is owned by app_rw (owners bypass RLS)",
        ]),
      );
      expect(problems.join("\n")).not.toContain(
        "global_without_rls has row-level security disabled",
      );
      expect(problems.join("\n")).not.toContain("demo_notes");
      expect(problems.join("\n")).not.toContain("demo_payments");
    } finally {
      await t.current.admin.query(`
        DROP TABLE bad_no_rls, bad_public_policy, global_without_rls, owned_by_app;
        DROP VIEW bad_view;
        DROP FUNCTION public.bad_definer();
      `);
    }
  });

  it("migrations apply to an empty database when the roles already exist (Neon branch / re-run)", async () => {
    const name = `cb_test_${Math.floor(Date.now() / 1000)}_${randomBytes(4).toString("hex")}`;
    const adminUrl = testDatabaseUrl();
    const control = new pg.Client({ connectionString: adminUrl });
    await control.connect();
    try {
      await control.query(`CREATE DATABASE ${quoteIdent(name)}`);
      const url = withDatabase(adminUrl, name);
      await migrateDatabase(url);
      await migrateDatabase(url); // idempotent: nothing pending the second time
      const db = createDb({ connectionString: url, driver: "pg", max: 1 });
      try {
        const role = await db.withPlatform(
          async (tx) => (await tx.execute<{ r: string }>("select current_user as r")).rows[0]?.r,
        );
        expect(role).toBe("app_platform");
      } finally {
        await db.end();
      }
    } finally {
      await control.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
      await control.end();
    }
  });
});
