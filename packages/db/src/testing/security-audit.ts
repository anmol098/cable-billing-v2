/**
 * Catalog audit of the tenancy guarantees. The @cb/db suite runs it against the fully migrated
 * database, so every table a later migration adds is checked automatically:
 *
 * 1. `app_rw` / `app_platform` exist, cannot log in, are not superuser, have no BYPASSRLS,
 *    CREATEROLE, CREATEDB or REPLICATION, and own no schema, relation or function (an owner
 *    bypasses RLS on its own tables).
 * 2. Every table in `public` has row-level security enabled, unless it is allow-listed with a
 *    reason (global tables such as a job queue); app_rw has SELECT/INSERT/UPDATE/DELETE on it.
 * 3. Every table with an `operator_id` column has a policy for app_rw whose USING and WITH CHECK
 *    both use `app.current_operator()`, and no policy that applies to PUBLIC.
 * 4. Views are `security_invoker` (otherwise they read as their owner and skip RLS); materialized
 *    views and SECURITY DEFINER functions in `public`/`app` must be allow-listed with a reason.
 */
import type pg from "pg";
import { APP_PLATFORM_ROLE, APP_RW_ROLE } from "../rls";

export interface SecurityAuditOptions {
  /** Tables (in `public`) allowed without RLS, each with the reason. */
  allowWithoutRls?: Readonly<Record<string, string>>;
  /** Materialized views / SECURITY DEFINER functions allowed, by name, with the reason. */
  allowDefinerObjects?: Readonly<Record<string, string>>;
}

type Queryable = Pick<pg.ClientBase, "query">;

const APP_ROLES = [APP_RW_ROLE, APP_PLATFORM_ROLE];

/** Returns human-readable problems; an empty array means the database passes. */
export async function auditDatabaseSecurity(
  db: Queryable,
  options: SecurityAuditOptions = {},
): Promise<string[]> {
  const allowWithoutRls = options.allowWithoutRls ?? {};
  const allowDefiner = options.allowDefinerObjects ?? {};
  const problems: string[] = [];

  // 1. Roles.
  const roles = await db.query<{
    rolname: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    rolcanlogin: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
  }>(
    `SELECT rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb, rolreplication
       FROM pg_roles WHERE rolname = ANY ($1)`,
    [APP_ROLES],
  );
  for (const name of APP_ROLES) {
    const role = roles.rows.find((r) => r.rolname === name);
    if (!role) {
      problems.push(`role ${name} is missing`);
      continue;
    }
    for (const attr of [
      "rolsuper",
      "rolbypassrls",
      "rolcanlogin",
      "rolcreaterole",
      "rolcreatedb",
      "rolreplication",
    ] as const) {
      if (role[attr]) problems.push(`role ${name} must not have ${attr}`);
    }
  }

  const owned = await db.query<{ kind: string; name: string; owner: string }>(
    `SELECT 'schema' AS kind, nspname AS name, pg_get_userbyid(nspowner) AS owner FROM pg_namespace
      UNION ALL
     SELECT 'relation', n.nspname || '.' || c.relname, pg_get_userbyid(c.relowner)
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      UNION ALL
     SELECT 'function', n.nspname || '.' || p.proname, pg_get_userbyid(p.proowner)
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace`,
  );
  for (const row of owned.rows) {
    if (APP_ROLES.includes(row.owner)) {
      problems.push(`${row.kind} ${row.name} is owned by ${row.owner} (owners bypass RLS)`);
    }
  }

  // 2 + 3. Tables.
  const tables = await db.query<{
    relname: string;
    rls: boolean;
    tenant: boolean;
    can_select: boolean;
    can_insert: boolean;
    can_update: boolean;
    can_delete: boolean;
  }>(
    `SELECT c.relname,
            c.relrowsecurity AS rls,
            EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'operator_id' AND NOT a.attisdropped) AS tenant,
            has_table_privilege($1, c.oid, 'SELECT') AS can_select,
            has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
            has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
            has_table_privilege($1, c.oid, 'DELETE') AS can_delete
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
      ORDER BY c.relname`,
    [APP_RW_ROLE],
  );
  const policies = await db.query<{
    tablename: string;
    policyname: string;
    roles: string[];
    cmd: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `SELECT tablename, policyname, roles::text[] AS roles, cmd, qual, with_check
       FROM pg_policies WHERE schemaname = 'public'`,
  );
  for (const table of tables.rows) {
    const name = table.relname;
    if (!table.rls && !(name in allowWithoutRls)) {
      problems.push(`table ${name} has row-level security disabled (enable it or allow-list it)`);
    }
    for (const priv of ["select", "insert", "update", "delete"] as const) {
      if (!table[`can_${priv}`]) {
        problems.push(
          `table ${name}: ${APP_RW_ROLE} lacks ${priv.toUpperCase()} (default privileges not applied?)`,
        );
      }
    }
    if (!table.tenant) continue;
    if (name in allowWithoutRls) {
      problems.push(`table ${name} has operator_id, so it cannot be allow-listed without RLS`);
    }
    const tablePolicies = policies.rows.filter((p) => p.tablename === name);
    const isolated = tablePolicies.some(
      (p) =>
        p.roles.includes(APP_RW_ROLE) &&
        p.cmd === "ALL" &&
        p.qual?.includes("current_operator()") &&
        p.with_check?.includes("current_operator()"),
    );
    if (!isolated) {
      problems.push(
        `tenant table ${name} has no ALL policy for ${APP_RW_ROLE} on app.current_operator() (use tenantPolicies())`,
      );
    }
    for (const p of tablePolicies) {
      if (p.roles.includes("public")) {
        problems.push(`tenant table ${name}: policy ${p.policyname} applies to PUBLIC`);
      }
    }
  }

  // 4. Views, materialized views, SECURITY DEFINER functions.
  const views = await db.query<{ relname: string; relkind: string; invoker: boolean }>(
    `SELECT c.relname, c.relkind,
            coalesce(c.reloptions::text[] && ARRAY['security_invoker=true', 'security_invoker=on'], false) AS invoker
       FROM pg_class c
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm')`,
  );
  for (const view of views.rows) {
    if (view.relkind === "v" && !view.invoker) {
      problems.push(`view ${view.relname} must be created WITH (security_invoker = true)`);
    }
    if (view.relkind === "m" && !(view.relname in allowDefiner)) {
      problems.push(`materialized view ${view.relname} has no RLS (allow-list it with a reason)`);
    }
  }
  const definers = await db.query<{ name: string }>(
    `SELECT n.nspname || '.' || p.proname AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname IN ('public', 'app')`,
  );
  for (const { name } of definers.rows) {
    if (!(name in allowDefiner)) {
      problems.push(
        `function ${name} is SECURITY DEFINER (it bypasses RLS; allow-list it with a reason)`,
      );
    }
  }

  return problems;
}
