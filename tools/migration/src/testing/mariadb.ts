/**
 * Scratch MariaDB databases for the tests that exercise the real restore/copy path.
 *
 * CI has no MariaDB, so these suites run only when `LEGACY_TEST_MARIADB_URL` points at a server
 * (e.g. `mysql://root:legacy-local-only@127.0.0.1:3307/` for the docker-compose service) and skip
 * with a message otherwise. Local hosts only.
 */
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import { quoteMysqlIdent } from "../source/mariadb";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function mariadbTestUrl(): string | undefined {
  const url = process.env.LEGACY_TEST_MARIADB_URL;
  if (!url) return undefined;
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`LEGACY_TEST_MARIADB_URL must be local, got ${host}`);
  return url;
}

export interface ScratchMariaDb {
  readonly name: string;
  /** URL of the scratch database (for MariaDbSource). */
  readonly url: string;
  /** Runs a multi-statement SQL script in the scratch database. */
  load(sql: string): Promise<void>;
  drop(): Promise<void>;
}

export async function createScratchMariaDb(serverUrl: string): Promise<ScratchMariaDb> {
  const name = `cb_mig_test_${randomBytes(6).toString("hex")}`;
  const parsed = new URL(serverUrl);
  const options = {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
  const admin = await mysql.createConnection(options);
  await admin.query(`CREATE DATABASE ${quoteMysqlIdent(name)} CHARACTER SET utf8mb4`);
  await admin.end();
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  return {
    name,
    url: url.toString(),
    async load(sql) {
      const conn = await mysql.createConnection({
        ...options,
        database: name,
        multipleStatements: true,
      });
      try {
        await conn.query(sql);
      } finally {
        await conn.end();
      }
    },
    async drop() {
      const conn = await mysql.createConnection(options);
      try {
        await conn.query(`DROP DATABASE IF EXISTS ${quoteMysqlIdent(name)}`);
      } finally {
        await conn.end();
      }
    },
  };
}
