/**
 * Append-only enforcement (PLAN §3 "Append-only financials", §7.1 Immutability, RULE-20, BR-13).
 *
 * Migration 0000 creates the trigger function `app.forbid_update_delete(allowed_column, …)`:
 * - DELETE and TRUNCATE always fail.
 * - UPDATE fails if any column outside the allowed list changes (an UPDATE that only touches
 *   allowed columns, or changes nothing, passes). A name in the list that is not a column of the
 *   table fails too, so typos surface on the first update instead of silently allowing nothing.
 * - Errors use SQLSTATE {@link IMMUTABLE_ROW_SQLSTATE} and name the table and columns, never values.
 *
 * Drizzle-kit can't express triggers in the schema, so a task adds them in a custom migration
 * (`pnpm --filter @cb/db db:generate --custom --name=<module>_append_only`), pasting the SQL that
 * {@link appendOnlyTriggerSql} returns. See packages/db/README.md.
 */

/** SQLSTATE raised by `app.forbid_update_delete()`. Map it to a CONFLICT-style error in core. */
export const IMMUTABLE_ROW_SQLSTATE = "CB001";

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function ident(value: string, what: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new TypeError(`appendOnlyTriggerSql: ${what} must be a lower-case SQL identifier`);
  }
  return `"${value}"`;
}

export interface AppendOnlyTriggerOptions {
  /** Table name (lower-case, unquoted). */
  table: string;
  /** Schema, default `public`. */
  schema?: string;
  /** Columns that may still change after insert (e.g. `review_status`). Default: none. */
  allowedColumns?: readonly string[];
  /**
   * Optional trigger `WHEN (...)` condition on `OLD`, for rows that become immutable only in some
   * state. Raw SQL written by the migration author; never pass user input.
   */
  when?: string;
}

/**
 * SQL for a custom migration that makes a table append-only: a row-level
 * `BEFORE UPDATE OR DELETE` trigger plus a statement-level `BEFORE TRUNCATE` trigger, both calling
 * `app.forbid_update_delete()`. Statements are separated by drizzle's `--> statement-breakpoint`.
 */
export function appendOnlyTriggerSql(options: AppendOnlyTriggerOptions): string {
  const table = ident(options.table, "table");
  const schema = ident(options.schema ?? "public", "schema");
  const args = (options.allowedColumns ?? []).map((c) => `'${ident(c, "column").slice(1, -1)}'`);
  const rowTrigger = ident(`${options.table}_append_only`, "trigger name");
  const truncateTrigger = ident(`${options.table}_no_truncate`, "trigger name");
  const when = options.when ? `\n  WHEN (${options.when})` : "";
  return [
    `CREATE TRIGGER ${rowTrigger}\n  BEFORE UPDATE OR DELETE ON ${schema}.${table}\n  FOR EACH ROW${when}\n  EXECUTE FUNCTION app.forbid_update_delete(${args.join(", ")});`,
    `CREATE TRIGGER ${truncateTrigger}\n  BEFORE TRUNCATE ON ${schema}.${table}\n  FOR EACH STATEMENT\n  EXECUTE FUNCTION app.forbid_update_delete();`,
  ].join("\n--> statement-breakpoint\n");
}

/** True if `error` (or anything in its `cause` chain, e.g. a DrizzleQueryError) is an append-only violation. */
export function isImmutableRowError(error: unknown): boolean {
  return sqlStateOf(error) === IMMUTABLE_ROW_SQLSTATE;
}

/** The Postgres SQLSTATE of an error, following `cause` (drizzle wraps driver errors). */
export function sqlStateOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
