/**
 * Database fingerprints for "no writes happened" assertions: per table, the row count and an md5
 * of every row's text form (through the admin pool, which bypasses RLS and sees everything).
 */
import type { TestDatabase } from "@cb/db/testing";

export type Fingerprint = Readonly<Record<string, string>>;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Fingerprints every table in `public`. With `operatorId`, only tables that have an `operator_id`
 * column, and only that tenant's rows.
 */
export async function databaseFingerprint(
  database: Pick<TestDatabase, "admin">,
  options: { operatorId?: string } = {},
): Promise<Fingerprint> {
  const tables = await database.admin.query<{ table_name: string; has_operator: boolean }>(
    `SELECT t.table_name,
            EXISTS (SELECT 1 FROM information_schema.columns c
                    WHERE c.table_schema = 'public' AND c.table_name = t.table_name
                      AND c.column_name = 'operator_id') AS has_operator
       FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY t.table_name`,
  );
  const result: Record<string, string> = {};
  for (const { table_name: table, has_operator: hasOperator } of tables.rows) {
    if (options.operatorId !== undefined && !hasOperator) continue;
    const where = options.operatorId === undefined ? "" : " WHERE t.operator_id = $1";
    const params = options.operatorId === undefined ? [] : [options.operatorId];
    const row = await database.admin.query<{ n: number; h: string }>(
      `SELECT count(*)::int AS n,
              coalesce(md5(string_agg(t::text, E'\\n' ORDER BY t::text)), '') AS h
         FROM public.${quoteIdent(table)} t${where}`,
      params,
    );
    result[table] = `${row.rows[0]?.n ?? 0}:${row.rows[0]?.h ?? ""}`;
  }
  return result;
}

/** Names of tables whose fingerprint differs. */
export function changedTables(before: Fingerprint, after: Fingerprint): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names].filter((name) => before[name] !== after[name]).sort();
}
