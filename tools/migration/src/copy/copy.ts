/**
 * Copies every legacy table, raw, into the Postgres `legacy` schema (PLAN §15 step 3, first half).
 *
 * - One transaction per table: the table is dropped, recreated and filled, and its row count is
 *   checked against the source before commit. Re-running replaces the copy (idempotent).
 * - Metadata lives next to the data: `legacy._copy_columns` keeps each column's MariaDB type (the
 *   profiler needs it to find dates and floats), `legacy._copy_tables` the row counts, and
 *   `legacy._copy_runs` one row per run.
 * - The schema is closed to PUBLIC: it holds real personal data and the app's runtime role must
 *   never read it.
 *
 * The caller connects to a target that passed `checkTarget` / `assertTargetDeclaredNonProd`.
 */
import type pg from "pg";
import { LEGACY_SCHEMA } from "../config";
import type { LegacySource, LegacyTable, LegacyValue } from "../source/types";
import { type ColumnKind, pgColumnType, quotePgIdent } from "./types";

export const METADATA_PREFIX = "_copy_";
const MAX_PARAMS = 60_000;

export interface CopyOptions {
  /** Rows read from the source per batch (default 2,000). */
  readonly batchSize?: number;
  /** Copy only these tables (default: all). Stale tables are only removed on a full copy. */
  readonly tables?: readonly string[];
  readonly onProgress?: (message: string) => void;
}

export interface CopiedTable {
  readonly name: string;
  readonly columns: number;
  readonly rows: number;
  readonly nulBytesRemoved: number;
}

export interface CopyResult {
  readonly runId: number;
  readonly tables: readonly CopiedTable[];
  readonly droppedStale: readonly string[];
}

const schema = quotePgIdent(LEGACY_SCHEMA);

export async function ensureLegacySchema(client: pg.ClientBase): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}._copy_runs (
      id bigserial PRIMARY KEY,
      source_label text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      table_count integer,
      row_count bigint
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}._copy_tables (
      table_name text PRIMARY KEY,
      run_id bigint NOT NULL,
      source_rows bigint NOT NULL,
      copied_rows bigint NOT NULL,
      copied_at timestamptz NOT NULL DEFAULT now()
    )`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${schema}._copy_columns (
      table_name text NOT NULL,
      ordinal integer NOT NULL,
      column_name text NOT NULL,
      source_data_type text NOT NULL,
      source_column_type text NOT NULL,
      nullable boolean NOT NULL,
      primary_key boolean NOT NULL,
      kind text NOT NULL,
      pg_type text NOT NULL,
      nul_bytes_removed bigint NOT NULL DEFAULT 0,
      PRIMARY KEY (table_name, column_name)
    )`);
}

export async function copyLegacy(
  source: LegacySource,
  client: pg.ClientBase,
  options: CopyOptions = {},
): Promise<CopyResult> {
  const batchSize = options.batchSize ?? 2000;
  const log = options.onProgress ?? (() => {});
  await ensureLegacySchema(client);

  const all = await source.listTables();
  for (const table of all) {
    if (table.name.startsWith(METADATA_PREFIX)) {
      throw new Error(`legacy table "${table.name}" clashes with the copy's metadata tables`);
    }
  }
  const wanted = options.tables ? new Set(options.tables) : undefined;
  if (wanted) {
    const missing = [...wanted].filter((name) => !all.some((t) => t.name === name));
    if (missing.length > 0) throw new Error(`not in the source: ${missing.join(", ")}`);
  }
  const tables = wanted ? all.filter((t) => wanted.has(t.name)) : all;

  const run = await client.query<{ id: string }>(
    `INSERT INTO ${schema}._copy_runs (source_label) VALUES ($1) RETURNING id`,
    [source.label],
  );
  const runId = Number(run.rows[0]?.id);

  const copied: CopiedTable[] = [];
  for (const table of tables) {
    const result = await copyTable(source, client, table, runId, batchSize);
    log(`${table.name}: ${result.rows} rows`);
    copied.push(result);
  }

  const droppedStale: string[] = [];
  if (!wanted) {
    const known = await client.query<{ table_name: string }>(
      `SELECT table_name FROM ${schema}._copy_tables ORDER BY table_name`,
    );
    for (const { table_name } of known.rows) {
      if (all.some((t) => t.name === table_name)) continue;
      await client.query("BEGIN");
      await client.query(`DROP TABLE IF EXISTS ${schema}.${quotePgIdent(table_name)}`);
      await client.query(`DELETE FROM ${schema}._copy_tables WHERE table_name = $1`, [table_name]);
      await client.query(`DELETE FROM ${schema}._copy_columns WHERE table_name = $1`, [table_name]);
      await client.query("COMMIT");
      droppedStale.push(table_name);
    }
  }

  await client.query(
    `UPDATE ${schema}._copy_runs SET finished_at = now(), table_count = $2, row_count = $3 WHERE id = $1`,
    [runId, copied.length, copied.reduce((sum, t) => sum + t.rows, 0)],
  );
  return { runId, tables: copied, droppedStale };
}

async function copyTable(
  source: LegacySource,
  client: pg.ClientBase,
  table: LegacyTable,
  runId: number,
  batchSize: number,
): Promise<CopiedTable> {
  const columns = table.columns.map((column) => ({ column, ...pgColumnType(column) }));
  const target = `${schema}.${quotePgIdent(table.name)}`;
  const sourceRows = await source.countRows(table);
  const nulBytes = new Array<number>(columns.length).fill(0);
  let copiedRows = 0;

  await client.query("BEGIN");
  try {
    await client.query(`DROP TABLE IF EXISTS ${target}`);
    const definitions = columns.map(
      ({ column, pgType }) => `${quotePgIdent(column.name)} ${pgType}`,
    );
    await client.query(`CREATE TABLE ${target} (${definitions.join(", ")})`);

    const columnList = columns.map(({ column }) => quotePgIdent(column.name)).join(", ");
    const rowsPerInsert = Math.max(1, Math.min(batchSize, Math.floor(MAX_PARAMS / columns.length)));
    for await (const batch of source.readRows(table, batchSize)) {
      for (let start = 0; start < batch.length; start += rowsPerInsert) {
        const slice = batch.slice(start, start + rowsPerInsert);
        const params: unknown[] = [];
        const tuples = slice.map((row) => {
          const placeholders = columns.map(({ kind }, i) => {
            const converted = toPg(row[i] ?? null, kind);
            if (converted.nulBytes) nulBytes[i] = (nulBytes[i] ?? 0) + 1;
            params.push(converted.value);
            return `$${params.length}`;
          });
          return `(${placeholders.join(", ")})`;
        });
        await client.query(
          `INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(", ")}`,
          params,
        );
        copiedRows += slice.length;
      }
    }

    const count = await client.query<{ n: string }>(`SELECT count(*) AS n FROM ${target}`);
    const inTarget = Number(count.rows[0]?.n);
    if (inTarget !== sourceRows || copiedRows !== sourceRows) {
      throw new Error(
        `${table.name}: source has ${sourceRows} rows but ${inTarget} were copied ` +
          "(was the legacy database written to during the copy? Freeze it first.)",
      );
    }

    await client.query(`DELETE FROM ${schema}._copy_columns WHERE table_name = $1`, [table.name]);
    for (const [ordinal, { column, kind, pgType }] of columns.entries()) {
      await client.query(
        `INSERT INTO ${schema}._copy_columns
           (table_name, ordinal, column_name, source_data_type, source_column_type, nullable,
            primary_key, kind, pg_type, nul_bytes_removed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          table.name,
          ordinal + 1,
          column.name,
          column.dataType,
          column.columnType,
          column.nullable,
          column.primaryKey,
          kind,
          pgType,
          nulBytes[ordinal] ?? 0,
        ],
      );
    }
    await client.query(
      `INSERT INTO ${schema}._copy_tables (table_name, run_id, source_rows, copied_rows, copied_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (table_name) DO UPDATE SET run_id = EXCLUDED.run_id,
         source_rows = EXCLUDED.source_rows, copied_rows = EXCLUDED.copied_rows, copied_at = now()`,
      [table.name, runId, sourceRows, inTarget],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return {
    name: table.name,
    columns: columns.length,
    rows: copiedRows,
    nulBytesRemoved: nulBytes.reduce((a, b) => a + b, 0),
  };
}

/** Converts one raw legacy value for its Postgres column. Never interprets dates or money. */
export function toPg(
  value: LegacyValue,
  kind: ColumnKind,
): { value: string | number | Buffer | null; nulBytes: boolean } {
  if (value === null || value === undefined) return { value: null, nulBytes: false };
  if (kind === "binary") {
    return { value: Buffer.isBuffer(value) ? value : Buffer.from(String(value)), nulBytes: false };
  }
  if (typeof value === "bigint") return { value: value.toString(), nulBytes: false };
  if (typeof value === "number") {
    return {
      value: kind === "text" || kind === "temporal" ? String(value) : value,
      nulBytes: false,
    };
  }
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  if ((kind === "text" || kind === "temporal") && text.includes("\0")) {
    // Postgres text cannot hold NUL. The removal is counted per column in _copy_columns.
    return { value: text.replaceAll("\0", ""), nulBytes: true };
  }
  return { value: text, nulBytes: false };
}
