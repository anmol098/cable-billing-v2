/**
 * Row-level security building blocks for tenant tables (PLAN §9.1, E-03).
 *
 * Roles (created by migration 0000, never by drizzle-kit, hence `.existing()`):
 * - `app_rw`: every tenant transaction (`withTenant`) runs as this role. NOLOGIN, no BYPASSRLS,
 *   owns nothing, so RLS always applies to it.
 * - `app_platform`: cross-tenant jobs (`withPlatform`). Also no BYPASSRLS. Tenant tables have no
 *   policy for it, so it sees none of their rows; it only reaches tables that grant it a policy
 *   explicitly (or global tables without RLS, which must be allow-listed in the RLS coverage test).
 *
 * Usage in a schema module (see packages/db/README.md):
 *
 * ```ts
 * export const areas = pgTable(
 *   "areas",
 *   { id: primaryId(), operatorId: operatorIdColumn(), name: text("name").notNull() },
 *   (t) => [tenantKey(t), ...tenantPolicies(t)],
 * ).enableRLS();
 * ```
 */
import { type SQL, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  type PgPolicy,
  pgPolicy,
  pgRole,
  type UniqueConstraintBuilder,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/** Role names, as created by migration 0000. */
export const APP_RW_ROLE = "app_rw";
export const APP_PLATFORM_ROLE = "app_platform";

/** Transaction-local GUC holding the current tenant (read through `app.current_operator()`). */
export const OPERATOR_ID_SETTING = "app.operator_id";

export const appRw = pgRole(APP_RW_ROLE).existing();
export const appPlatform = pgRole(APP_PLATFORM_ROLE).existing();

/**
 * `app.current_operator()`: the tenant set by `withTenant`, or NULL when none is set (a fresh
 * connection, `withPlatform`, or after the transaction ended). NULL never equals anything, so a
 * policy `operator_id = app.current_operator()` yields zero rows instead of an error.
 */
export const currentOperator: SQL = sql`app.current_operator()`;

/** `operator_id uuid not null`: the tenant column every tenant-owned table has. */
export const operatorIdColumn = () => uuid("operator_id").notNull();

interface TenantColumns {
  id: AnyPgColumn;
  operatorId: AnyPgColumn;
}

/**
 * `UNIQUE (operator_id, id)`: the target of composite foreign keys `(operator_id, x_id) →
 * x(operator_id, id)`, which stop a row from pointing at another tenant's row (PLAN §7.1).
 */
export function tenantKey(table: TenantColumns, name?: string): UniqueConstraintBuilder {
  return unique(name).on(table.operatorId, table.id);
}

/**
 * The standard policy set for a tenant table: one permissive policy for `app_rw`, all commands,
 * `USING` and `WITH CHECK` `operator_id = app.current_operator()`. Reads see only the current
 * tenant's rows; inserts/updates that would write another tenant's `operator_id` fail.
 * No policy is created for `app_platform` (default deny). Drizzle-kit also emits
 * `ENABLE ROW LEVEL SECURITY` for tables that have policies; call `.enableRLS()` as well to be explicit.
 */
export function tenantPolicies(
  table: { operatorId: AnyPgColumn },
  options: { name?: string } = {},
): PgPolicy[] {
  const condition = sql`${table.operatorId} = ${currentOperator}`;
  return [
    pgPolicy(options.name ?? "tenant_isolation", {
      as: "permissive",
      for: "all",
      to: appRw,
      using: condition,
      withCheck: condition,
    }),
  ];
}
