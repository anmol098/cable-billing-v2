/**
 * Scratch Postgres databases for the DB-backed tests. Same conventions as `@cb/db/testing`:
 * `DATABASE_URL` names the server (CI: the Postgres service; locally the default below), remote
 * hosts are refused unless `CB_TEST_DATABASE_ALLOW_REMOTE=1`, and `CB_SKIP_DB_TESTS=1` is the only
 * way to skip (there is no silent skip when Postgres is down).
 */
import { randomBytes } from "node:crypto";
import pg from "pg";

const DEFAULT_URL = "postgres://postgres:postgres@localhost:5432/cable_billing";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export const pgTestsSkipped = (): boolean => process.env.CB_SKIP_DB_TESTS === "1";

function serverUrl(): string {
  const url = process.env.DATABASE_URL || DEFAULT_URL;
  const host = new URL(url).hostname;
  if (!LOCAL_HOSTS.has(host) && process.env.CB_TEST_DATABASE_ALLOW_REMOTE !== "1") {
    throw new Error(`Refusing to create test databases on remote host "${host}".`);
  }
  return url;
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export interface ScratchDatabase {
  readonly url: string;
  readonly client: pg.Client;
  drop(): Promise<void>;
}

/** Creates an empty database `cb_mig_test_<random>` and connects to it. */
export async function createScratchDatabase(): Promise<ScratchDatabase> {
  const server = serverUrl();
  const name = `cb_mig_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: server });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = withDatabase(server, name);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    url,
    client,
    async drop() {
      await client.end();
      const dropper = new pg.Client({ connectionString: server });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
