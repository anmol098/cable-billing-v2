/**
 * T-020a: the production runtime role ("shape B") and its boot check, on a real Postgres.
 *
 * - `checkRuntimeRole` flags the owner/superuser connection and every unsafe attribute, ownership
 *   or missing membership, and passes a role created as `docs/runbooks/environments.md` says.
 * - With such a role, withTenant/withPlatform work and a raw query outside them can't read tenant
 *   rows.
 * - Migration 0000's default privileges cover tables a later migration creates (as the owner) after
 *   the runtime role was created: the role can use them with no extra GRANT.
 */
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb, type DbClient } from "./client";
import { uuidv7 } from "./ids";
import { APP_PLATFORM_ROLE, APP_RW_ROLE } from "./rls";
import { checkRuntimeRole, MAX_LISTED_OBJECTS, type RuntimeRoleReport } from "./runtime-role";
import { areas, operators } from "./schema";
import { createTenant, describeDb, type TestTenant, useTestDatabase } from "./testing";
import { sqlStateOf } from "./triggers";

const INSUFFICIENT_PRIVILEGE = "42501";

function codes(report: RuntimeRoleReport): string[] {
  return report.issues.map((issue) => issue.code).sort();
}

describeDb("checkRuntimeRole", () => {
  const t = useTestDatabase();
  const clients: DbClient[] = [];

  /** A createDb client for a login role URL, closed after the file. */
  function clientFor(url: string): DbClient {
    const db = createDb({ connectionString: url, driver: "pg", max: 1, onIdleError: () => {} });
    clients.push(db);
    return db;
  }

  /**
   * A role made exactly like the runbook's `CREATE ROLE cb_app LOGIN NOINHERIT … IN ROLE app_rw,
   * app_platform`: the harness role (INHERIT memberships), with both memberships switched to
   * INHERIT FALSE (PG 16+ keeps the inherit flag per membership).
   */
  async function noInheritRole() {
    const login = await t.current.createLoginRole();
    await t.current.admin.query(`ALTER ROLE ${login.role} NOINHERIT`);
    await t.current.admin.query(
      `GRANT ${APP_RW_ROLE}, ${APP_PLATFORM_ROLE} TO ${login.role} WITH INHERIT FALSE`,
    );
    return login;
  }

  afterAll(async () => {
    await Promise.allSettled(clients.map((db) => db.end()));
  });

  it("flags the owner/superuser connection (shape A: CI, local, previews)", async () => {
    const admin = await t.current.admin.query<{ user: string; superuser: boolean }>(
      "SELECT session_user AS user, (SELECT rolsuper FROM pg_roles WHERE rolname = session_user) AS superuser",
    );
    const report = await checkRuntimeRole(t.current.db);

    expect(report.ok).toBe(false);
    expect(report.sessionUser).toBe(admin.rows[0]?.user);
    expect(report.database).toBe(t.current.name);
    expect(codes(report)).toEqual(expect.arrayContaining(["owns_objects", "can_create_objects"]));
    if (admin.rows[0]?.superuser) {
      expect(codes(report)).toEqual(expect.arrayContaining(["superuser", "bypassrls"]));
    }
    const owns = report.issues.find((issue) => issue.code === "owns_objects");
    expect(owns?.severity).toBe("error");
    expect(owns?.objects).toHaveLength(MAX_LISTED_OBJECTS);
    expect(owns?.objects).toContainEqual({ kind: "database", schema: null, name: t.current.name });
    expect(owns?.objects).toContainEqual({ kind: "schema", schema: null, name: "app" });
    // The total counts every table, sequence and function in the app's schemas.
    const tables = await t.current.admin.query(
      "SELECT 1 FROM pg_tables WHERE schemaname = 'public'",
    );
    expect(owns?.count).toBeGreaterThan(tables.rowCount ?? 0);
    expect(owns?.message).toMatch(/and \d+ more$/);
  });

  it("passes a NOINHERIT member of app_rw and app_platform that owns nothing (the runbook role)", async () => {
    const login = await noInheritRole();
    const report = await checkRuntimeRole(clientFor(login.url));
    expect(report).toEqual({
      ok: true,
      sessionUser: login.role,
      database: t.current.name,
      issues: [],
    });
  });

  it("passes an INHERIT member too, with a warning per inherited app role", async () => {
    const login = await t.current.createLoginRole(); // CREATE ROLE … INHERIT IN ROLE app_rw, app_platform
    const report = await checkRuntimeRole(clientFor(login.url));
    expect(report.ok).toBe(true);
    expect(report.sessionUser).toBe(login.role);
    expect(report.issues.map((i) => [i.code, i.severity, i.role])).toEqual([
      ["inherits_app_roles", "warning", APP_RW_ROLE],
      ["inherits_app_roles", "warning", APP_PLATFORM_ROLE],
    ]);
  });

  it("flags BYPASSRLS, CREATEROLE, CREATEDB and REPLICATION", async () => {
    const login = await noInheritRole();
    await t.current.admin.query(
      `ALTER ROLE ${login.role} BYPASSRLS CREATEROLE CREATEDB REPLICATION`,
    );
    const report = await checkRuntimeRole(clientFor(login.url));
    expect(report.ok).toBe(false);
    expect(codes(report)).toEqual(["bypassrls", "createdb", "createrole", "replication"]);
    expect(report.issues.every((i) => i.severity === "error")).toBe(true);
    expect(report.issues[0]?.message).toContain(login.role);
  });

  it("flags a role that owns a table, or can become a role that does", async () => {
    await t.current.admin.query(
      "CREATE TABLE t020a_owned (id int PRIMARY KEY); ALTER TABLE t020a_owned ENABLE ROW LEVEL SECURITY",
    );
    const owner = await noInheritRole();
    await t.current.admin.query(`ALTER TABLE t020a_owned OWNER TO ${owner.role}`);
    const direct = await checkRuntimeRole(clientFor(owner.url));
    expect(direct.ok).toBe(false);
    expect(direct.issues).toEqual([
      expect.objectContaining({
        code: "owns_objects",
        count: 1,
        objects: [{ kind: "table", schema: "public", name: "t020a_owned" }],
      }),
    ]);

    // Membership counts even without INHERIT: the member can SET ROLE to the owner.
    const member = await noInheritRole();
    await t.current.admin.query(`GRANT ${owner.role} TO ${member.role} WITH INHERIT FALSE`);
    const viaMembership = await checkRuntimeRole(clientFor(member.url));
    expect(codes(viaMembership)).toEqual(["owns_objects"]);
    expect(viaMembership.issues[0]?.objects).toEqual([
      { kind: "table", schema: "public", name: "t020a_owned" },
    ]);
  });

  it("flags a role that may create objects in a schema", async () => {
    const login = await noInheritRole();
    await t.current.admin.query(`GRANT CREATE ON SCHEMA public TO ${login.role}`);
    const report = await checkRuntimeRole(clientFor(login.url));
    expect(report.ok).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ code: "can_create_objects", targets: ["schema public"] }),
    ]);
    await t.current.admin.query(`REVOKE CREATE ON SCHEMA public FROM ${login.role}`);
  });

  it("flags a role that can't switch to app_platform or app_rw (withTenant/withPlatform would fail)", async () => {
    const noPlatform = await noInheritRole();
    await t.current.admin.query(`REVOKE ${APP_PLATFORM_ROLE} FROM ${noPlatform.role}`);
    const partial = await checkRuntimeRole(clientFor(noPlatform.url));
    expect(partial.ok).toBe(false);
    // The catalog is still read, through withTenant.
    expect(partial.sessionUser).toBe(noPlatform.role);
    expect(partial.issues).toEqual([
      expect.objectContaining({ code: "cannot_assume_role", role: APP_PLATFORM_ROLE }),
    ]);

    const none = await noInheritRole();
    await t.current.admin.query(`REVOKE ${APP_RW_ROLE}, ${APP_PLATFORM_ROLE} FROM ${none.role}`);
    const report = await checkRuntimeRole(clientFor(none.url));
    expect(report).toEqual({
      ok: false,
      sessionUser: null,
      database: null,
      issues: [
        expect.objectContaining({ code: "cannot_assume_role", role: APP_PLATFORM_ROLE }),
        expect.objectContaining({ code: "cannot_assume_role", role: APP_RW_ROLE }),
      ],
    });
  });

  it("rejects (doesn't report) when the database can't be reached", async () => {
    const url = new URL(t.current.url);
    url.port = "1";
    await expect(checkRuntimeRole(clientFor(url.toString()))).rejects.toBeDefined();
  });

  it("only reads: both transactions are read-only", async () => {
    const calls: unknown[] = [];
    const spy: Pick<DbClient, "withTenant" | "withPlatform"> = {
      withPlatform: (fn, options) => {
        calls.push(["platform", options]);
        return t.current.db.withPlatform(fn, options);
      },
      withTenant: (id, fn, options) => {
        calls.push(["tenant", options]);
        return t.current.db.withTenant(id, fn, options);
      },
    };
    await checkRuntimeRole(spy);
    expect(calls).toEqual([
      ["platform", { accessMode: "read only" }],
      ["tenant", { accessMode: "read only" }],
    ]);
  });
});

describeDb("shape-B runtime role end to end", () => {
  const t = useTestDatabase();
  let a: TestTenant;
  let b: TestTenant;
  let noInherit: { role: string; url: string };
  let inherit: { role: string; url: string };
  let app: DbClient;

  beforeAll(async () => {
    a = await createTenant(t.current);
    b = await createTenant(t.current);
    await t.current.admin.query(
      "INSERT INTO areas (id, operator_id, name) VALUES ($1, $2, 'North'), ($3, $4, 'South')",
      [uuidv7(), a.operatorId, uuidv7(), b.operatorId],
    );
    noInherit = await t.current.createLoginRole();
    await t.current.admin.query(`ALTER ROLE ${noInherit.role} NOINHERIT`);
    await t.current.admin.query(
      `GRANT ${APP_RW_ROLE}, ${APP_PLATFORM_ROLE} TO ${noInherit.role} WITH INHERIT FALSE`,
    );
    inherit = await t.current.createLoginRole();
    app = createDb({
      connectionString: noInherit.url,
      driver: "pg",
      max: 2,
      onIdleError: () => {},
    });
  });

  afterAll(async () => {
    await app?.end();
  });

  async function raw<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  it("withTenant and withPlatform work for the runtime role, with the same isolation", async () => {
    const created = await app.withTenant(a.operatorId, (tx) =>
      tx.insert(areas).values({ operatorId: a.operatorId, name: "East" }).returning(),
    );
    expect(created).toHaveLength(1);
    const mine = await app.withTenant(a.operatorId, (tx) =>
      tx.select({ name: areas.name }).from(areas).orderBy(areas.name),
    );
    expect(mine.map((r) => r.name)).toEqual(["East", "North"]);
    const tenants = await app.withPlatform((tx) => tx.select({ id: operators.id }).from(operators));
    expect(tenants.map((r) => r.id).sort()).toEqual([a.operatorId, b.operatorId].sort());
    const report = await checkRuntimeRole(app);
    expect(report.ok).toBe(true);
  });

  it("a raw NOINHERIT connection outside the wrappers can't read any app table", async () => {
    await raw(noInherit.url, async (client) => {
      for (const table of ["areas", "operators", "users", "sessions"]) {
        const query = client.query(`SELECT * FROM ${table}`);
        await expect(query).rejects.toSatisfy((e) => sqlStateOf(e) === INSUFFICIENT_PRIVILEGE);
      }
    });
  });

  it("a raw INHERIT connection sees zero tenant rows (but every operators row: why NOINHERIT)", async () => {
    await raw(inherit.url, async (client) => {
      expect((await client.query("SELECT * FROM areas")).rows).toEqual([]);
      // operators has an app_platform SELECT policy; an inheriting role gets it without switching.
      expect((await client.query("SELECT id FROM operators")).rowCount).toBe(2);
    });
  });

  it("can use a table a later migration creates as the owner, with no extra GRANT (default privileges)", async () => {
    // As a later migration would: same owner role as migration 0000, after the runtime role exists.
    await t.current.admin.query(`
      CREATE TABLE t020a_late (
        seq bigserial,
        id uuid PRIMARY KEY,
        operator_id uuid NOT NULL REFERENCES operators (id),
        body text NOT NULL
      );
      ALTER TABLE t020a_late ENABLE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON t020a_late AS PERMISSIVE FOR ALL TO app_rw
        USING (operator_id = app.current_operator()) WITH CHECK (operator_id = app.current_operator());
    `);
    const owner = await t.current.admin.query<{ owner: string; me: string }>(
      "SELECT tableowner AS owner, current_user AS me FROM pg_tables WHERE tablename = 't020a_late'",
    );
    expect(owner.rows[0]?.owner).toBe(owner.rows[0]?.me);

    const insert = (operatorId: string, body: string) =>
      app.withTenant(operatorId, (tx) =>
        tx.execute(
          sql`INSERT INTO t020a_late (id, operator_id, body) VALUES (${uuidv7()}, ${operatorId}, ${body})`,
        ),
      );
    await insert(a.operatorId, "a1"); // needs INSERT on the table and USAGE on its sequence
    await insert(b.operatorId, "b1");
    const read = (operatorId: string) =>
      app.withTenant(operatorId, async (tx) => {
        const r = await tx.execute<{ body: string; seq: string }>(
          sql`SELECT body, seq::text FROM t020a_late ORDER BY seq`,
        );
        return r.rows.map((row) => row.body);
      });
    expect(await read(a.operatorId)).toEqual(["a1"]);
    expect(await read(b.operatorId)).toEqual(["b1"]);
    const updated = await app.withTenant(a.operatorId, (tx) =>
      tx.execute(sql`UPDATE t020a_late SET body = 'a2' WHERE body = 'a1'`),
    );
    expect(updated.rowCount).toBe(1);

    // The privileges came from migration 0000's ALTER DEFAULT PRIVILEGES, not a grant here.
    const privileges = await t.current.admin.query<{ role: string; table: boolean; seq: boolean }>(`
      SELECT r AS role,
             has_table_privilege(r, 't020a_late', 'SELECT, INSERT, UPDATE, DELETE') AS table,
             has_sequence_privilege(r, 't020a_late_seq_seq', 'USAGE') AS seq
        FROM unnest(ARRAY['app_rw', 'app_platform']) AS r`);
    expect(privileges.rows).toEqual([
      { role: "app_rw", table: true, seq: true },
      { role: "app_platform", table: true, seq: true },
    ]);

    // And the runtime role still owns nothing.
    expect((await checkRuntimeRole(app)).ok).toBe(true);
    await raw(inherit.url, async (client) => {
      expect((await client.query("SELECT * FROM t020a_late")).rows).toEqual([]);
    });
    const areaCount = await app.withTenant(b.operatorId, (tx) =>
      tx.select().from(areas).where(eq(areas.operatorId, a.operatorId)),
    );
    expect(areaCount).toEqual([]);
  });
});
