/**
 * A legacy database the copy step reads from: the restored MariaDB (`MariaDbSource`) or, in tests,
 * the synthetic fixture held in memory (`MemorySource`). Both describe columns the way MariaDB's
 * information_schema does, and return rows as arrays in column order with raw values:
 *
 * - integers → number, or string when they don't fit a JS number safely (BIGINT UNSIGNED …)
 * - FLOAT/DOUBLE → number; DECIMAL → string (exact)
 * - DATE/DATETIME/TIMESTAMP/TIME/YEAR → the string MariaDB prints, **including zero dates**
 *   (`0000-00-00`), which is why nothing is parsed here
 * - text types and ENUM/SET → string; binary types → Buffer
 */

export interface LegacyColumn {
  readonly name: string;
  /** information_schema.COLUMNS.DATA_TYPE, lower case: `int`, `varchar`, `datetime`, `float` … */
  readonly dataType: string;
  /** information_schema.COLUMNS.COLUMN_TYPE: `int(11) unsigned`, `enum('a','b')`, `tinyint(1)` … */
  readonly columnType: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
}

export interface LegacyTable {
  readonly name: string;
  readonly columns: readonly LegacyColumn[];
}

export type LegacyValue = string | number | bigint | Buffer | null;

export interface LegacySource {
  /** For logs and the copy-run record. Never contains credentials. */
  readonly label: string;
  /** Base tables, in name order. */
  listTables(): Promise<LegacyTable[]>;
  countRows(table: LegacyTable): Promise<number>;
  /** Streams the table in batches of at most `batchSize` rows. */
  readRows(table: LegacyTable, batchSize: number): AsyncIterable<LegacyValue[][]>;
  close(): Promise<void>;
}
