import type { LegacyColumn } from "../source/types";

/**
 * How a MariaDB column is stored in the Postgres `legacy` schema. The copy is **raw**: nothing is
 * interpreted, so transforms (T-092/T-093) and the profiler see exactly what the legacy system held.
 *
 * - Integers → `bigint` (`numeric(20)` for BIGINT UNSIGNED, which can exceed bigint).
 * - FLOAT/DOUBLE → `double precision` (the legacy float values, not rounded).
 * - DECIMAL → `numeric` (exact).
 * - DATE/DATETIME/TIMESTAMP/TIME/YEAR → **`text`**, the string MariaDB printed. Postgres has no
 *   zero date, and converting `0000-00-00` to NULL here would hide it from the profiler.
 * - Binary/BLOB/BIT → `bytea`. Everything else (CHAR/VARCHAR/TEXT/ENUM/SET/JSON) → `text`.
 */
export type ColumnKind = "integer" | "float" | "decimal" | "temporal" | "binary" | "text";

export interface PgColumnType {
  readonly kind: ColumnKind;
  readonly pgType: string;
}

const INTEGER = new Set(["tinyint", "smallint", "mediumint", "int", "integer", "bigint"]);
const FLOAT = new Set(["float", "double", "real", "double precision"]);
const DECIMAL = new Set(["decimal", "numeric", "dec", "fixed"]);
const TEMPORAL = new Set(["date", "datetime", "timestamp", "time", "year"]);
const BINARY = new Set([
  "binary",
  "varbinary",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
  "bit",
  "geometry",
]);

export function pgColumnType(column: Pick<LegacyColumn, "dataType" | "columnType">): PgColumnType {
  const dataType = column.dataType.toLowerCase();
  if (INTEGER.has(dataType)) {
    const unsignedBig = dataType === "bigint" && /unsigned/i.test(column.columnType);
    return { kind: "integer", pgType: unsignedBig ? "numeric(20)" : "bigint" };
  }
  if (FLOAT.has(dataType)) return { kind: "float", pgType: "double precision" };
  if (DECIMAL.has(dataType)) return { kind: "decimal", pgType: "numeric" };
  if (TEMPORAL.has(dataType)) return { kind: "temporal", pgType: "text" };
  if (BINARY.has(dataType)) return { kind: "binary", pgType: "bytea" };
  return { kind: "text", pgType: "text" };
}

/** Double-quotes a Postgres identifier (legacy names keep their case, e.g. `isReceipt`). */
export function quotePgIdent(name: string): string {
  if (name.length === 0 || name.length > 63 || name.includes("\0")) {
    throw new TypeError(`unsupported identifier: ${JSON.stringify(name)}`);
  }
  return `"${name.replaceAll('"', '""')}"`;
}
