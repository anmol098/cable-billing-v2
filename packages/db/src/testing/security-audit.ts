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
 * 5. Platform reads (T-086c): every table `app_platform` can read rows of must be on the reviewed
 *    `platformRead` allow-list, with the exact columns it may read (or `"all"`), the rows (`"all"`
 *    or the exact USING filter) and the reason. See {@link PlatformReadRule}.
 *
 * **What "readable by app_platform" means here.** A table (or partition, materialized view,
 * foreign table) in a schema `app_platform` has USAGE on, where it has SELECT on at least one
 * column (`has_any_column_privilege`, which counts table-wide grants, column grants and role
 * membership), **and** rows reach it: RLS is off (or the relation has no RLS at all, like a
 * materialized view), or a permissive SELECT/ALL policy applies to `app_platform`, to PUBLIC or to
 * a role `app_platform` is a member of. Restrictive policies only narrow, so they never make a
 * table readable. Views are not listed separately: they are `security_invoker` (check 4), so
 * reading one needs the same access to the tables under it.
 *
 * **Decision: a privilege without a policy is not reported.** The default privileges (migration
 * 0000) give `app_platform` table-wide SELECT on every new table, so every tenant table without a
 * platform policy carries that privilege, and RLS returns no rows (default deny). Listing those
 * would bury the real findings. It is still safe, because the privilege only matters once rows
 * reach the role, and both ways that can happen are caught: adding a platform/PUBLIC policy, or
 * turning RLS off (check 2), make the table readable, so it must be allow-listed with its columns,
 * and the table-wide SELECT is then reported unless the entry says `"all"`. App roles can't
 * bypass RLS any other way: no BYPASSRLS and they own nothing (check 1).
 */
import type pg from "pg";
import { APP_PLATFORM_ROLE, APP_RW_ROLE } from "../rls";

/**
 * One reviewed entry of the platform read allow-list: what `app_platform` may read of one table,
 * and why.
 */
export interface PlatformReadRule {
  /**
   * The columns `app_platform` may SELECT. A list must equal the readable columns exactly (an
   * extra or a missing column is reported) and implies column grants only: a table-wide SELECT
   * is reported, since it opens every future column too. `"all"`: the whole row, including
   * columns added later, for tables the platform path needs whole (Better Auth, the job queue).
   */
  readonly columns: readonly string[] | "all";
  /**
   * The rows: `"all"`, or the exact USING expression, as Postgres prints it (`pg_policies.qual`,
   * e.g. `"(operator_id IS NULL)"`), that every policy letting `app_platform` read the table must
   * have. A policy with another filter (say `true`) is reported, so widening the rows is caught.
   */
  readonly rows: string;
  /** Why the platform path reads this table (reviewed). Must not be blank. */
  readonly reason: string;
}

export interface SecurityAuditOptions {
  /** Tables (in `public`) allowed without RLS, each with the reason. */
  allowWithoutRls?: Readonly<Record<string, string>>;
  /** Materialized views / SECURITY DEFINER functions allowed, by name, with the reason. */
  allowDefinerObjects?: Readonly<Record<string, string>>;
  /**
   * Every table `app_platform` may read, keyed by table name (`schema.table` outside `public`).
   * Omitted means empty: then every table the platform role can read is reported.
   */
  platformRead?: Readonly<Record<string, PlatformReadRule>>;
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

  // 5. Platform reads.
  problems.push(...(await auditPlatformReads(db, options.platformRead ?? {})));

  return problems;
}

/** Check 5: what `app_platform` can read equals the reviewed allow-list. */
async function auditPlatformReads(
  db: Queryable,
  allowList: Readonly<Record<string, PlatformReadRule>>,
): Promise<string[]> {
  const problems: string[] = [];
  const role = APP_PLATFORM_ROLE;

  // Relations the role holds SELECT on (any column), in schemas it can use.
  const relations = await db.query<{
    name: string;
    rls: boolean;
    table_wide: boolean;
    columns: string[];
  }>(
    `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name,
            (c.relkind IN ('r', 'p') AND c.relrowsecurity) AS rls,
            has_table_privilege($1, c.oid, 'SELECT') AS table_wide,
            ARRAY(SELECT a.attname::text FROM pg_attribute a
                   WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                     AND has_column_privilege($1, c.oid, a.attnum, 'SELECT')
                   ORDER BY a.attnum) AS columns
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p', 'm', 'f')
        AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
        AND has_schema_privilege($1, n.oid, 'USAGE')
        AND has_any_column_privilege($1, c.oid, 'SELECT')
      ORDER BY 1`,
    [role],
  );
  // Permissive SELECT/ALL policies that apply to the role (directly, via PUBLIC or membership).
  const policies = await db.query<{ name: string; policyname: string; qual: string | null }>(
    `SELECT CASE WHEN n.nspname = 'public' THEN c.relname ELSE n.nspname || '.' || c.relname END AS name,
            p.polname AS policyname,
            pg_get_expr(p.polqual, p.polrelid) AS qual
       FROM pg_policy p
       JOIN pg_class c ON c.oid = p.polrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE p.polpermissive AND p.polcmd IN ('r', '*')
        AND EXISTS (SELECT 1 FROM unnest(p.polroles) AS r(oid)
                     WHERE r.oid = 0 OR pg_has_role($1, r.oid, 'MEMBER'))
      ORDER BY 1, 2`,
    [role],
  );

  const readable = new Set<string>();
  for (const rel of relations.rows) {
    const relPolicies = policies.rows.filter((p) => p.name === rel.name);
    if (rel.rls && relPolicies.length === 0) continue; // default deny: no rows reach the role
    readable.add(rel.name);
    const how = rel.rls
      ? `policy ${relPolicies.map((p) => `${p.policyname} USING ${p.qual ?? "(none)"}`).join(", ")}`
      : "row-level security is off";
    const rule = allowList[rel.name];
    if (!rule) {
      problems.push(
        `table ${rel.name} is readable by ${role} (${how}) but is not on the platform read allow-list (add it with its columns, rows and reason after a review, or remove the access)`,
      );
      continue;
    }
    if (rule.reason.trim() === "") {
      problems.push(`table ${rel.name}: the platform read allow-list entry has no reason`);
    }
    if (rule.rows !== "all") {
      if (!rel.rls) {
        problems.push(
          `table ${rel.name}: allow-listed for rows ${rule.rows} only, but row-level security is off, so ${role} reads every row`,
        );
      }
      for (const p of relPolicies) {
        if (p.qual !== rule.rows) {
          problems.push(
            `table ${rel.name}: policy ${p.policyname} lets ${role} read rows USING ${p.qual ?? "(none)"}, but the allow-list says USING ${rule.rows}`,
          );
        }
      }
    }
    if (rule.columns === "all") continue;
    if (rel.table_wide) {
      problems.push(
        `table ${rel.name}: ${role} has table-wide SELECT, which opens every column (revoke it and grant the allow-listed columns only)`,
      );
    }
    const extra = rel.columns.filter((c) => !rule.columns.includes(c));
    if (extra.length > 0) {
      problems.push(
        `table ${rel.name}: ${role} can read column(s) ${extra.join(", ")} not on the platform read allow-list (revoke them, or add them after a review)`,
      );
    }
    const missing = rule.columns.filter((c) => !rel.columns.includes(c));
    if (missing.length > 0) {
      problems.push(
        `table ${rel.name}: allow-listed column(s) ${missing.join(", ")} are not readable by ${role} (grant them, or remove them from the list)`,
      );
    }
  }

  for (const name of Object.keys(allowList).sort()) {
    if (!readable.has(name)) {
      problems.push(
        `table ${name} is on the platform read allow-list but ${role} cannot read it (remove the stale entry)`,
      );
    }
  }
  return problems;
}
