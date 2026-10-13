import mysql from "mysql2";
import type { LegacyColumn, LegacySource, LegacyTable, LegacyValue } from "./types";

/** Default URL of the docker-compose MariaDB (tools/migration/docker-compose.yml). Local only. */
export const DEFAULT_LEGACY_DB_URL = "mysql://root:legacy-local-only@127.0.0.1:3307/legacy";

/** Quotes a MariaDB identifier. */
export function quoteMysqlIdent(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

interface ColumnRow {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  DATA_TYPE: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: string;
  COLUMN_KEY: string;
}

/**
 * Reads the restored legacy database. Values come back raw (see `LegacyValue`): dates as the
 * strings MariaDB prints (zero dates survive), DECIMAL and big integers as strings.
 */
export class MariaDbSource implements LegacySource {
  readonly label: string;
  readonly #conn: mysql.Connection;
  readonly #database: string;

  private constructor(conn: mysql.Connection, database: string, label: string) {
    this.#conn = conn;
    this.#database = database;
    this.label = label;
  }

  static async connect(url: string): Promise<MariaDbSource> {
    const parsed = new URL(url);
    if (parsed.protocol !== "mysql:" && parsed.protocol !== "mariadb:") {
      throw new Error("LEGACY_DB_URL must be a mysql:// URL");
    }
    const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (!database) throw new Error("LEGACY_DB_URL must name the database (…/legacy)");
    const conn = mysql.createConnection({
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 3306,
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      database,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: false,
      decimalNumbers: false,
      charset: "utf8mb4",
      timezone: "Z",
    });
    await conn.promise().connect();
    // Read exactly what is stored: no zero-date or strict-mode surprises on SELECT.
    await conn.promise().query("SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'");
    return new MariaDbSource(
      conn,
      database,
      `mariadb ${parsed.hostname}:${parsed.port || 3306}/${database}`,
    );
  }

  async listTables(): Promise<LegacyTable[]> {
    const [rows] = await this.#conn.promise().query(
      `SELECT c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.COLUMN_TYPE, c.IS_NULLABLE, c.COLUMN_KEY
         FROM information_schema.COLUMNS c
         JOIN information_schema.TABLES t
           ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
        WHERE c.TABLE_SCHEMA = ? AND t.TABLE_TYPE = 'BASE TABLE'
        ORDER BY c.TABLE_NAME, c.ORDINAL_POSITION`,
      [this.#database],
    );
    const tables = new Map<string, LegacyColumn[]>();
    for (const row of rows as ColumnRow[]) {
      const columns = tables.get(row.TABLE_NAME) ?? [];
      columns.push({
        name: row.COLUMN_NAME,
        dataType: row.DATA_TYPE.toLowerCase(),
        columnType: row.COLUMN_TYPE.toLowerCase(),
        nullable: row.IS_NULLABLE === "YES",
        primaryKey: row.COLUMN_KEY === "PRI",
      });
      tables.set(row.TABLE_NAME, columns);
    }
    return [...tables.entries()]
      .map(([name, columns]) => ({ name, columns }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async countRows(table: LegacyTable): Promise<number> {
    const [rows] = await this.#conn
      .promise()
      .query(`SELECT COUNT(*) AS n FROM ${quoteMysqlIdent(table.name)}`);
    return Number((rows as { n: number | string }[])[0]?.n ?? 0);
  }

  async *readRows(table: LegacyTable, batchSize: number): AsyncIterable<LegacyValue[][]> {
    const columns = table.columns.map((c) => quoteMysqlIdent(c.name)).join(", ");
    const stream = this.#conn
      .query({ sql: `SELECT ${columns} FROM ${quoteMysqlIdent(table.name)}`, rowsAsArray: true })
      .stream({ highWaterMark: batchSize });
    let batch: LegacyValue[][] = [];
    for await (const row of stream) {
      batch.push(row as LegacyValue[]);
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  async close(): Promise<void> {
    await this.#conn.promise().end();
  }
}
