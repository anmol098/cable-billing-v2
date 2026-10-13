import type pg from "pg";
import { LEGACY_SCHEMA } from "../config";
import type { ColumnKind } from "../copy/types";
import { quotePgIdent } from "../copy/types";
import { type ColumnClassification, classifyColumn } from "./classify";

/** A copied legacy column, as recorded by the copy step in `legacy._copy_columns`. */
export interface CatalogColumn {
  readonly name: string;
  readonly ordinal: number;
  readonly dataType: string;
  readonly columnType: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly kind: ColumnKind;
  readonly nulBytesRemoved: number;
  readonly classification: ColumnClassification;
}

export interface CatalogTable {
  readonly name: string;
  readonly sourceRows: number;
  readonly columns: readonly CatalogColumn[];
}

export interface CopyRunInfo {
  readonly id: number;
  readonly sourceLabel: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface Catalog {
  readonly tables: readonly CatalogTable[];
  readonly lastRun: CopyRunInfo | null;
}

export const qualified = (table: string): string =>
  `${quotePgIdent(LEGACY_SCHEMA)}.${quotePgIdent(table)}`;

/** Reads what the copy step recorded. Fails clearly when nothing was copied yet. */
export async function readCatalog(client: pg.ClientBase): Promise<Catalog> {
  const exists = await client.query<{ ok: boolean }>("SELECT to_regclass($1) IS NOT NULL AS ok", [
    `${quotePgIdent(LEGACY_SCHEMA)}._copy_columns`,
  ]);
  if (!exists.rows[0]?.ok) {
    throw new Error(`no ${LEGACY_SCHEMA} schema in the target: run the copy step first`);
  }
  const tables = await client.query<{ table_name: string; source_rows: string }>(
    `SELECT table_name, source_rows FROM ${qualified("_copy_tables")} ORDER BY table_name`,
  );
  const columns = await client.query<{
    table_name: string;
    ordinal: number;
    column_name: string;
    source_data_type: string;
    source_column_type: string;
    nullable: boolean;
    primary_key: boolean;
    kind: ColumnKind;
    nul_bytes_removed: string;
  }>(`SELECT * FROM ${qualified("_copy_columns")} ORDER BY table_name, ordinal`);
  const run = await client.query<{
    id: string;
    source_label: string;
    started_at: Date;
    finished_at: Date | null;
  }>(
    `SELECT id, source_label, started_at, finished_at FROM ${qualified("_copy_runs")}
      WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`,
  );
  const lastRunRow = run.rows[0];
  return {
    lastRun: lastRunRow
      ? {
          id: Number(lastRunRow.id),
          sourceLabel: lastRunRow.source_label,
          startedAt: lastRunRow.started_at.toISOString(),
          finishedAt: lastRunRow.finished_at?.toISOString() ?? null,
        }
      : null,
    tables: tables.rows.map((table) => ({
      name: table.table_name,
      sourceRows: Number(table.source_rows),
      columns: columns.rows
        .filter((c) => c.table_name === table.table_name)
        .map((c) => ({
          name: c.column_name,
          ordinal: c.ordinal,
          dataType: c.source_data_type,
          columnType: c.source_column_type,
          nullable: c.nullable,
          primaryKey: c.primary_key,
          kind: c.kind,
          nulBytesRemoved: Number(c.nul_bytes_removed),
          classification: classifyColumn({
            name: c.column_name,
            dataType: c.source_data_type,
            columnType: c.source_column_type,
          }),
        })),
    })),
  };
}

/** Finds a column by any of its candidate names (case-insensitive, first candidate wins). */
export function findColumn(
  table: CatalogTable | undefined,
  candidates: readonly string[],
): CatalogColumn | undefined {
  if (!table) return undefined;
  for (const candidate of candidates) {
    const found = table.columns.find((c) => c.name.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }
  return undefined;
}

export function findTable(catalog: Catalog, name: string): CatalogTable | undefined {
  return (
    catalog.tables.find((t) => t.name === name) ??
    catalog.tables.find((t) => t.name.toLowerCase() === name.toLowerCase())
  );
}
