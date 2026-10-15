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
import { PLATFORM_READ_COLUMNS, type PlatformReadTable } from "../schema/platform-admin";
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
import type { PlatformReadRule } from "./security-audit";

/** Global tables (no operator_id) that may skip RLS, with the reason. Later tasks append here. */
const ALLOW_WITHOUT_RLS: Record<string, string> = {};

/** Materialized views / SECURITY DEFINER functions that are allowed, with the reason. */
const ALLOW_DEFINER_OBJECTS: Record<string, string> = {};

/**
 * Why the platform path reads each column-limited tenant table of T-086. The columns themselves
 * come from `PLATFORM_READ_COLUMNS` (one source of truth, also used by the grant migration); a new
 * entry there fails typecheck here until it has a reason.
 */
const PLATFORM_READ_COLUMN_REASONS: Record<PlatformReadTable, string> = {
  customers: "T-086: customer count per tenant and status (tenants list); no names or phones",
  billing_runs: "T-086: job monitor and billing success rate (PRD §16); no money, no actor",
  billing_run_items: "T-086: billing exception rate by reason (PRD §16); no customer or invoice",
  invariant_checks: "T-086: nightly books-check status and counts per tenant; never the samples",
  receipt_actions: "T-086: receipt action usage, print / WhatsApp / SMS launches (PRD §16)",
  collection_sessions: "T-086: reconciliation discrepancy rate (PRD §16); the reason, no amounts",
  payment_sync_batches:
    "T-086a: payment sync success rate and duplicate prevention count (PRD §16); per-batch counts by IST day, no id, time, amount or payment id",
};

/**
 * Every table `app_platform` may read, reviewed (T-086c; `packages/db/README.md` has the same list
 * as a table). The security audit fails when the role can read a table, a column or rows that are
 * not here, and when an entry here is no longer readable. Adding an entry is a security review,
 * like adding the policy or the grant itself.
 */
const PLATFORM_READ: Record<string, PlatformReadRule> = {
  // Better Auth runs on the platform path: sign-in happens before any tenant is known.
  accounts: {
    columns: "all",
    rows: "all",
    reason: "T-021: Better Auth credentials (sign-in / sign-up / password reset)",
  },
  sessions: { columns: "all", rows: "all", reason: "T-021: Better Auth sessions" },
  two_factors: { columns: "all", rows: "all", reason: "T-021: Better Auth TOTP (platform admins)" },
  verifications: {
    columns: "all",
    rows: "all",
    reason: "T-021: Better Auth verification and reset tokens",
  },
  users: {
    columns: "all",
    rows: "all",
    reason: "T-021: Better Auth sign-in / sign-up / profile before the tenant is known",
  },
  operators: { columns: "all", rows: "all", reason: "T-021: list tenants (jobs, admin console)" },
  subscriptions: {
    columns: "all",
    rows: "all",
    reason: "T-021: subscription state cron, Razorpay webhooks, admin extend",
  },
  subscription_events: {
    columns: "all",
    rows: "all",
    reason: "T-021: Razorpay webhook events are recorded and processed before a tenant is known",
  },
  audit_events: {
    columns: "all",
    rows: "(operator_id IS NULL)",
    reason: "T-021: platform-level audit events only, never a tenant's",
  },
  jobs: {
    columns: "all",
    rows: "all",
    reason:
      "T-023: the job worker enqueues and claims every tenant's jobs, then works in withTenant",
  },
  mobile_refresh_tokens: {
    columns: "all",
    rows: "all",
    reason: "T-021: find a refresh token by hash before the tenant is known",
  },
  receipt_links: {
    columns: "all",
    rows: "all",
    reason: "T-023: the public receipt page finds a link by token hash before the tenant is known",
  },
  support_access_grants: {
    columns: "all",
    rows: "all",
    reason: "T-086: the admin console lists who has support access where (written by the tenant)",
  },
  subscription_offline_payments: {
    columns: "all",
    rows: "all",
    reason: "T-086: the admin console lists our own fee payments (written by the tenant)",
  },
  ...Object.fromEntries(
    Object.entries(PLATFORM_READ_COLUMNS).map(([table, columns]) => [
      table,
      { columns, rows: "all", reason: PLATFORM_READ_COLUMN_REASONS[table as PlatformReadTable] },
    ]),
  ),
};

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

  const audit = (platformRead: Record<string, PlatformReadRule> = PLATFORM_READ) =>
    auditDatabaseSecurity(t.current.admin, {
      allowWithoutRls: ALLOW_WITHOUT_RLS,
      allowDefinerObjects: ALLOW_DEFINER_OBJECTS,
      platformRead,
    });

  it("passes the security audit (roles, ownership, RLS, tenant policies, platform reads)", async () => {
    expect(await audit()).toEqual([]);
  });

  it("the platform read allow-list holds exactly the 21 reviewed tables", () => {
    expect(Object.keys(PLATFORM_READ).sort()).toEqual(
      [
        "accounts",
        "audit_events",
        "billing_run_items",
        "billing_runs",
        "collection_sessions",
        "customers",
        "invariant_checks",
        "jobs",
        "mobile_refresh_tokens",
        "operators",
        "payment_sync_batches",
        "receipt_actions",
        "receipt_links",
        "sessions",
        "subscription_events",
        "subscription_offline_payments",
        "subscriptions",
        "support_access_grants",
        "two_factors",
        "users",
        "verifications",
      ].sort(),
    );
    for (const [table, columns] of Object.entries(PLATFORM_READ_COLUMNS)) {
      expect(PLATFORM_READ[table]?.columns).toBe(columns);
    }
  });

  it("platform reads: a new tenant table with a USING (true) platform policy is reported until listed", async () => {
    await t.current.admin.query(`
      CREATE TABLE scratch_peek (id uuid PRIMARY KEY, operator_id uuid NOT NULL, note text);
      ALTER TABLE scratch_peek ENABLE ROW LEVEL SECURITY;
      CREATE POLICY scratch_peek_tenant ON scratch_peek TO app_rw
        USING (operator_id = app.current_operator()) WITH CHECK (operator_id = app.current_operator());
    `);
    try {
      // The default privileges gave app_platform table-wide SELECT, but no rows reach it yet.
      expect(await audit()).toEqual([]);

      await t.current.admin.query(
        "CREATE POLICY scratch_peek_platform_select ON scratch_peek FOR SELECT TO app_platform USING (true)",
      );
      expect(await audit()).toEqual([
        "table scratch_peek is readable by app_platform (policy scratch_peek_platform_select USING true) but is not on the platform read allow-list (add it with its columns, rows and reason after a review, or remove the access)",
      ]);

      // Listed whole: clear.
      const whole = { columns: "all", rows: "all", reason: "test" } as const;
      expect(await audit({ ...PLATFORM_READ, scratch_peek: whole })).toEqual([]);

      // Listed with columns: the table-wide SELECT and the extra columns are reported.
      const limited = { columns: ["operator_id"], rows: "all", reason: "test" };
      expect(await audit({ ...PLATFORM_READ, scratch_peek: limited })).toEqual([
        "table scratch_peek: app_platform has table-wide SELECT, which opens every column (revoke it and grant the allow-listed columns only)",
        "table scratch_peek: app_platform can read column(s) id, note not on the platform read allow-list (revoke them, or add them after a review)",
      ]);

      // Column grant exactly as listed: clear.
      await t.current.admin.query(`
        REVOKE SELECT ON scratch_peek FROM app_platform;
        GRANT SELECT (operator_id) ON scratch_peek TO app_platform;
      `);
      expect(await audit({ ...PLATFORM_READ, scratch_peek: limited })).toEqual([]);
      // Not listed is still reported, whatever the columns.
      expect(await audit()).toEqual([
        expect.stringContaining("table scratch_peek is readable by app_platform"),
      ]);

      // A listed column that isn't granted, and a blank reason.
      expect(
        await audit({
          ...PLATFORM_READ,
          scratch_peek: { columns: ["operator_id", "id"], rows: "all", reason: " " },
        }),
      ).toEqual([
        "table scratch_peek: the platform read allow-list entry has no reason",
        "table scratch_peek: allow-listed column(s) id are not readable by app_platform (grant them, or remove them from the list)",
      ]);
    } finally {
      await t.current.admin.query("DROP TABLE scratch_peek");
    }
  });

  it("platform reads: an extra column grant or a table-wide SELECT on a listed table is reported", async () => {
    try {
      await t.current.admin.query('GRANT SELECT ("name", phone) ON customers TO app_platform');
      expect(await audit()).toEqual([
        "table customers: app_platform can read column(s) name, phone not on the platform read allow-list (revoke them, or add them after a review)",
      ]);
      await t.current.admin.query('REVOKE SELECT ("name", phone) ON customers FROM app_platform');
      expect(await audit()).toEqual([]);

      await t.current.admin.query("GRANT SELECT ON billing_runs TO app_platform");
      expect(await audit()).toEqual([
        "table billing_runs: app_platform has table-wide SELECT, which opens every column (revoke it and grant the allow-listed columns only)",
        expect.stringMatching(
          /^table billing_runs: app_platform can read column\(s\) .*total_charges_paise.* not on the platform read allow-list/,
        ),
      ]);
    } finally {
      // Back to the migration's grants (a table-wide REVOKE also drops the column grants).
      await t.current.admin.query(`
        REVOKE SELECT ("name", phone) ON customers FROM app_platform;
        REVOKE SELECT ON billing_runs FROM app_platform;
        GRANT SELECT (${PLATFORM_READ_COLUMNS.billing_runs.map((c) => `"${c}"`).join(", ")})
          ON billing_runs TO app_platform;
      `);
    }
    expect(await audit()).toEqual([]);
  });

  it("platform reads: widened rows, PUBLIC policies, RLS off and stale entries are reported", async () => {
    // Roles are cluster-wide: a unique name, so parallel test databases don't collide.
    const group = `cb_scratch_platform_${randomBytes(4).toString("hex")}`;
    await t.current.admin.query(`
      CREATE TABLE scratch_open (id uuid PRIMARY KEY, operator_id uuid NOT NULL);
      ALTER TABLE scratch_open ENABLE ROW LEVEL SECURITY;
      CREATE POLICY scratch_open_any ON scratch_open USING (true);
      CREATE TABLE scratch_global (id uuid PRIMARY KEY);
      CREATE TABLE scratch_hidden (id uuid PRIMARY KEY, operator_id uuid NOT NULL);
      ALTER TABLE scratch_hidden ENABLE ROW LEVEL SECURITY;
      CREATE ROLE ${group} NOLOGIN;
      GRANT ${group} TO app_platform;
      CREATE POLICY scratch_hidden_group ON scratch_hidden FOR SELECT TO ${group} USING (true);
      CREATE POLICY audit_events_platform_select_wide ON audit_events FOR SELECT TO app_platform
        USING (true);
    `);
    try {
      const problems = await auditDatabaseSecurity(t.current.admin, {
        allowWithoutRls: { scratch_global: "test: a global table" },
        platformRead: {
          ...PLATFORM_READ,
          gone_table: { columns: "all", rows: "all", reason: "x" },
        },
      });
      expect(problems).toEqual(
        expect.arrayContaining([
          "table audit_events: policy audit_events_platform_select_wide lets app_platform read rows USING true, but the allow-list says USING (operator_id IS NULL)",
          "table scratch_open is readable by app_platform (policy scratch_open_any USING true) but is not on the platform read allow-list (add it with its columns, rows and reason after a review, or remove the access)",
          "table scratch_global is readable by app_platform (row-level security is off) but is not on the platform read allow-list (add it with its columns, rows and reason after a review, or remove the access)",
          expect.stringContaining(
            "table scratch_hidden is readable by app_platform (policy scratch_hidden_group USING true)",
          ),
          "table gone_table is on the platform read allow-list but app_platform cannot read it (remove the stale entry)",
        ]),
      );
      expect(problems.join("\n")).not.toContain("audit_events_platform_select USING");
    } finally {
      await t.current.admin.query(`
        DROP POLICY audit_events_platform_select_wide ON audit_events;
        DROP TABLE scratch_open, scratch_global, scratch_hidden;
        REVOKE ${group} FROM app_platform;
        DROP ROLE ${group};
      `);
    }
    expect(await audit()).toEqual([]);
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
