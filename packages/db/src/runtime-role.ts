/**
 * Boot check for the database role the app connects as (T-020a, PLAN §9.1, E-03).
 *
 * In staging and production the runtime `DATABASE_URL` must use a LOGIN role that is only a member
 * of `app_rw` and `app_platform` ("shape B" in README.md): not a superuser, no BYPASSRLS, no
 * CREATEROLE/CREATEDB, owns nothing and can't create objects. Then even a raw query that never set
 * a tenant can't read tenant rows. Previews and CI use the owner URL ("shape A") and fail this check
 * by design, so only call it where shape B is expected, and log/alert on the result rather than
 * crash.
 *
 * It runs through the normal `createDb` client (there is no raw handle): inside `withPlatform` and
 * `withTenant`, read-only, it reads the system catalog about `session_user` — the role that logged
 * in. `current_user` is `app_platform`/`app_rw` there, but `session_user` never changes with
 * `SET ROLE`, and the catalog (`pg_roles`, `pg_class`, `pg_proc`, `pg_has_role`, …) is readable by
 * every role. Running both wrappers also proves that the role switch every request needs works.
 */
import { sql } from "drizzle-orm";
import type { DbClient } from "./client";
import { APP_PLATFORM_ROLE, APP_RW_ROLE } from "./rls";
import type { Tx, TxOptions } from "./tenant";
import { sqlStateOf } from "./triggers";

/** What can be wrong with the runtime role. */
export type RuntimeRoleIssueCode =
  /** The role is a superuser: RLS doesn't apply to it at all. */
  | "superuser"
  /** The role has BYPASSRLS: RLS doesn't apply to it. */
  | "bypassrls"
  /** The role can create roles (and so grant itself more). */
  | "createrole"
  /** The role can create databases. */
  | "createdb"
  /** The role can open replication connections (reads every row). */
  | "replication"
  /** The role owns (or can become the owner of) tables, functions, schemas or the database. */
  | "owns_objects"
  /** The role may create objects (it would own them): CREATE on the database or a schema. */
  | "can_create_objects"
  /** `withTenant`/`withPlatform` can't switch to `app_rw`/`app_platform` with this role. */
  | "cannot_assume_role"
  /**
   * Warning only: the role inherits `app_rw`/`app_platform` privileges without switching, so a raw
   * query outside the wrappers can read tables that have an `app_platform` policy (operators, users,
   * sessions, …). Tenant tables still return zero rows. Create the role with NOINHERIT to close it.
   */
  | "inherits_app_roles";

/** An object the runtime role owns, directly or through membership of the owner role. */
export interface OwnedObject {
  /** `table`, `view`, `materialized view`, `sequence`, `foreign table`, `function`, `procedure`, `aggregate`, `schema` or `database`. */
  readonly kind: string;
  /** The schema it is in; `null` for a schema or the database itself. */
  readonly schema: string | null;
  /** Its name (functions include their argument types). */
  readonly name: string;
}

export interface RuntimeRoleIssue {
  readonly code: RuntimeRoleIssueCode;
  /** `error`: the role is not a safe runtime role. `warning`: safe, but could be tighter. */
  readonly severity: "error" | "warning";
  /** One line for logs. Names roles and objects, never secrets or row data. */
  readonly message: string;
  /** `cannot_assume_role` and `inherits_app_roles`: the app role concerned. */
  readonly role?: string;
  /** `owns_objects`: the first {@link MAX_LISTED_OBJECTS} objects. */
  readonly objects?: readonly OwnedObject[];
  /** `owns_objects`: how many objects in total. */
  readonly count?: number;
  /** `can_create_objects`: where (`database <name>` or `schema <name>`). */
  readonly targets?: readonly string[];
}

export interface RuntimeRoleReport {
  /** True when there is no `error` issue (warnings allowed). */
  readonly ok: boolean;
  /** The login role (`session_user`); `null` if neither app role could be assumed. */
  readonly sessionUser: string | null;
  /** The connected database; `null` if neither app role could be assumed. */
  readonly database: string | null;
  readonly issues: readonly RuntimeRoleIssue[];
}

/** How many owned objects an `owns_objects` issue lists. */
export const MAX_LISTED_OBJECTS = 20;

const READ_ONLY: TxOptions = { accessMode: "read only" };
/** Any valid UUID works: the check reads only the catalog, never tenant rows. */
const NO_TENANT = "00000000-0000-0000-0000-000000000000";
/** "permission denied to set role" and "role … does not exist". */
const ROLE_SWITCH_FAILED = new Set(["42501", "22023"]);

interface RoleRow extends Record<string, unknown> {
  session_user: string;
  database: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  inherits_rw: boolean;
  inherits_platform: boolean;
}

interface OwnedRow extends Record<string, unknown> {
  kind: string;
  schema: string | null;
  name: string;
}

interface CreateRow extends Record<string, unknown> {
  target: string;
}

interface CatalogSnapshot {
  role: RoleRow;
  owned: OwnedRow[];
  canCreate: string[];
}

// Schemas the app's objects can live in: everything except the system ones (pg_catalog, pg_toast,
// pg_temp_*, information_schema). Covers `public`, `app` and drizzle-kit's `drizzle`.
const USER_SCHEMA = sql.raw(`(n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%')`);

async function readCatalog(tx: Tx): Promise<CatalogSnapshot> {
  const role = await tx.execute<RoleRow>(sql`
    SELECT session_user::text AS session_user,
           current_database()::text AS database,
           r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
           pg_catalog.pg_has_role(session_user, ${APP_RW_ROLE}, 'USAGE') AS inherits_rw,
           pg_catalog.pg_has_role(session_user, ${APP_PLATFORM_ROLE}, 'USAGE') AS inherits_platform
      FROM pg_catalog.pg_roles r
     WHERE r.rolname = session_user`);

  // Ownership counts through membership too: a member of the owner role can SET ROLE to it (and,
  // with INHERIT, already has its rights), so 'MEMBER' is the widest and right test.
  const owned = await tx.execute<OwnedRow>(sql`
    SELECT o.kind, o.schema, o.name FROM (
      SELECT CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'table' WHEN 'v' THEN 'view'
                            WHEN 'm' THEN 'materialized view' WHEN 'S' THEN 'sequence'
                            ELSE 'foreign table' END AS kind,
             n.nspname::text AS schema, c.relname::text AS name, c.relowner AS owner, 1 AS rank
        FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f') AND ${USER_SCHEMA}
      UNION ALL
      SELECT CASE p.prokind WHEN 'p' THEN 'procedure' WHEN 'a' THEN 'aggregate' ELSE 'function' END,
             n.nspname::text,
             p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
             p.proowner, 2
        FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
       WHERE ${USER_SCHEMA}
      UNION ALL
      SELECT 'schema', NULL, n.nspname::text, n.nspowner, 0
        FROM pg_catalog.pg_namespace n
       WHERE ${USER_SCHEMA}
      UNION ALL
      SELECT 'database', NULL, d.datname::text, d.datdba, 0
        FROM pg_catalog.pg_database d
       WHERE d.datname = current_database()
    ) o
    WHERE pg_catalog.pg_has_role(session_user, o.owner, 'MEMBER')
    ORDER BY o.rank, o.schema NULLS FIRST, o.name`);

  const canCreate = await tx.execute<CreateRow>(sql`
    SELECT 'database ' || current_database() AS target
     WHERE pg_catalog.has_database_privilege(session_user, current_database(), 'CREATE')
    UNION ALL
    (SELECT 'schema ' || n.nspname
       FROM pg_catalog.pg_namespace n
      WHERE ${USER_SCHEMA} AND pg_catalog.has_schema_privilege(session_user, n.oid, 'CREATE')
      ORDER BY n.nspname)`);

  const row = role.rows[0];
  if (!row) throw new Error("checkRuntimeRole: session_user not found in pg_roles");
  return { role: row, owned: owned.rows, canCreate: canCreate.rows.map((r) => r.target) };
}

function attributeIssues(role: RoleRow): RuntimeRoleIssue[] {
  const name = role.session_user;
  const issues: RuntimeRoleIssue[] = [];
  const flag = (code: RuntimeRoleIssueCode, set: boolean, what: string) => {
    if (set) issues.push({ code, severity: "error", message: `role ${name} ${what}` });
  };
  flag("superuser", role.rolsuper, "is a superuser (row-level security does not apply)");
  flag("bypassrls", role.rolbypassrls, "has BYPASSRLS (row-level security does not apply)");
  flag("createrole", role.rolcreaterole, "has CREATEROLE");
  flag("createdb", role.rolcreatedb, "has CREATEDB");
  flag("replication", role.rolreplication, "has REPLICATION");
  return issues;
}

function snapshotIssues(snapshot: CatalogSnapshot): RuntimeRoleIssue[] {
  const { role, owned, canCreate } = snapshot;
  const name = role.session_user;
  const issues = attributeIssues(role);

  if (owned.length > 0) {
    const objects = owned.slice(0, MAX_LISTED_OBJECTS).map((o) => ({
      kind: o.kind,
      schema: o.schema,
      name: o.name,
    }));
    const listed = objects.map((o) => `${o.kind} ${o.schema ? `${o.schema}.` : ""}${o.name}`);
    const more = owned.length > objects.length ? `, and ${owned.length - objects.length} more` : "";
    issues.push({
      code: "owns_objects",
      severity: "error",
      message: `role ${name} owns (or can act as the owner of) ${owned.length} object(s): ${listed.join(", ")}${more}`,
      objects,
      count: owned.length,
    });
  }

  if (canCreate.length > 0) {
    issues.push({
      code: "can_create_objects",
      severity: "error",
      message: `role ${name} can create objects in: ${canCreate.join(", ")}`,
      targets: canCreate,
    });
  }

  const inherited = [
    role.inherits_rw ? APP_RW_ROLE : null,
    role.inherits_platform ? APP_PLATFORM_ROLE : null,
  ].filter((r): r is string => r !== null);
  // A superuser "inherits" everything; that is already an error above.
  if (!role.rolsuper) {
    for (const appRole of inherited) {
      const effect =
        appRole === APP_PLATFORM_ROLE
          ? "can read every row of tables with an app_platform policy (operators, users, sessions, …)"
          : "runs with app_rw's table privileges (RLS still hides tenant rows)";
      issues.push({
        code: "inherits_app_roles",
        severity: "warning",
        role: appRole,
        message: `role ${name} inherits ${appRole}: a raw query outside withTenant/withPlatform ${effect}; recreate it with NOINHERIT`,
      });
    }
  }
  return issues;
}

/**
 * Checks the role the client logs in as and reports everything that makes it unsafe as the
 * production runtime role. Never throws for a finding; it rejects only when the database can't be
 * reached or the catalog can't be read (the caller should catch, log and carry on):
 *
 * ```ts
 * checkRuntimeRole(db)
 *   .then((report) => { if (!report.ok) log.error({ issues: report.issues }, "unsafe DB runtime role"); })
 *   .catch((error) => log.error({ error }, "DB runtime role check failed"));
 * ```
 *
 * Read-only: two short read-only transactions (`withPlatform`, then `withTenant` with a dummy
 * tenant), catalog reads only.
 */
export async function checkRuntimeRole(
  db: Pick<DbClient, "withTenant" | "withPlatform">,
): Promise<RuntimeRoleReport> {
  const attempts: Array<[string, (fn: (tx: Tx) => Promise<void>) => Promise<void>]> = [
    [APP_PLATFORM_ROLE, (fn) => db.withPlatform(fn, READ_ONLY)],
    [APP_RW_ROLE, (fn) => db.withTenant(NO_TENANT, fn, READ_ONLY)],
  ];

  const issues: RuntimeRoleIssue[] = [];
  let snapshot: CatalogSnapshot | undefined;
  for (const [role, inTransaction] of attempts) {
    // The wrappers switch the role before calling back; an error before the callback ran is the
    // switch failing (or the connection), an error inside it is a real failure of the check.
    let switched = false;
    try {
      await inTransaction(async (tx) => {
        switched = true;
        snapshot ??= await readCatalog(tx);
      });
    } catch (error) {
      const state = sqlStateOf(error);
      if (switched || state === undefined || !ROLE_SWITCH_FAILED.has(state)) throw error;
      issues.push({
        code: "cannot_assume_role",
        severity: "error",
        role,
        message: `the connected role can't switch to ${role} (SQLSTATE ${state}): grant it with GRANT ${role} TO <role>`,
      });
    }
  }

  if (snapshot) issues.unshift(...snapshotIssues(snapshot));
  return {
    ok: issues.every((issue) => issue.severity !== "error"),
    sessionUser: snapshot?.role.session_user ?? null,
    database: snapshot?.role.database ?? null,
    issues,
  };
}
