/**
 * Migrated template database, built once per migration set and cloned for every test file.
 *
 * The template is named after a hash of `packages/db/migrations/**`, so editing or adding a
 * migration builds a new one automatically, and a run with unchanged migrations reuses it (cloning
 * takes ~100 ms; migrating from scratch for each file would not). An advisory lock on the admin
 * database (the one in DATABASE_URL) serialises template builds between test files, parallel
 * vitest workers and other checkouts using the same server. Templates have ALLOW_CONNECTIONS false, so nothing can hold a connection that
 * would block `CREATE DATABASE … TEMPLATE`.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { describeUrl, quoteIdent, withDatabase } from "./env";

/** Absolute path of `packages/db/migrations`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

/** Advisory lock (two-int form) taken on the admin database while templates are built/cleaned. */
const LOCK = [742_020, 1] as const;

/** Test databases and login roles older than this are leftovers of crashed runs and are dropped. */
const STALE_AFTER_SECONDS = 6 * 60 * 60;

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    })
    .sort();
}

/** Short content hash of the migrations folder (file names + contents). */
export function migrationsHash(dir: string = MIGRATIONS_DIR): string {
  const hash = createHash("sha256");
  for (const file of listFiles(dir)) {
    hash.update(relative(dir, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** Applies all migrations in `packages/db/migrations` to the database at `url` (drizzle migrator). */
export async function migrateDatabase(url: string): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await migrate(drizzle({ client }), {
      migrationsFolder: MIGRATIONS_DIR,
      migrationsSchema: "drizzle",
      migrationsTable: "__drizzle_migrations",
    });
  } finally {
    await client.end();
  }
}

/** Connects an admin client, turning "no server" into an actionable message. */
export async function connectAdmin(adminUrl: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot connect to Postgres at ${describeUrl(adminUrl)} (${reason}). DB integration tests ` +
        "need a running Postgres 17: start the local server (docs/runbooks/environments.md) or set " +
        "DATABASE_URL. To skip DB suites deliberately, set CB_SKIP_DB_TESTS=1.",
      { cause: error },
    );
  }
  return client;
}

async function dropDatabase(client: pg.Client, name: string): Promise<void> {
  await client.query(`ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE false`).catch(() => {});
  await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
}

/** Drops `cb_test_<epoch>_*` databases and `cb_login_<epoch>_*` roles left by crashed runs. */
async function dropStale(client: pg.Client): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_AFTER_SECONDS;
  const dbs = await client.query<{ datname: string }>(
    "SELECT datname FROM pg_database WHERE datname ~ '^cb_test_[0-9]+_[a-z0-9]+$'",
  );
  for (const { datname } of dbs.rows) {
    if (Number(datname.split("_")[2]) < cutoff) await dropDatabase(client, datname);
  }
  const roles = await client.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname ~ '^cb_login_[0-9]+_[a-z0-9]+$'",
  );
  for (const { rolname } of roles.rows) {
    if (Number(rolname.split("_")[2]) < cutoff) {
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(rolname)}`).catch(() => {});
    }
  }
}

/** Builds (if needed) and returns the name of the template database for the current migrations. */
export async function ensureTemplate(adminUrl: string): Promise<string> {
  const name = `cb_tpl_${migrationsHash()}`;
  const client = await connectAdmin(adminUrl);
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [...LOCK]);
    const existing = await client.query<{ datistemplate: boolean }>(
      "SELECT datistemplate FROM pg_database WHERE datname = $1",
      [name],
    );
    await dropStale(client);
    if (existing.rows[0]?.datistemplate) return name;
    // Missing, or half-built by a crashed run (never marked as template): build from scratch.
    if (existing.rowCount) await dropDatabase(client, name);
    await client.query(`CREATE DATABASE ${quoteIdent(name)}`);
    try {
      await migrateDatabase(withDatabase(adminUrl, name));
    } catch (error) {
      await dropDatabase(client, name);
      throw error;
    }
    await client.query(
      `ALTER DATABASE ${quoteIdent(name)} WITH IS_TEMPLATE true ALLOW_CONNECTIONS false`,
    );
    return name;
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [...LOCK]).catch(() => {});
    await client.end();
  }
}

/** Drops every harness database and login role on the server (`pnpm --filter @cb/db db:test:clean`). */
export async function dropAllTestDatabases(adminUrl: string): Promise<string[]> {
  const client = await connectAdmin(adminUrl);
  const dropped: string[] = [];
  try {
    await client.query("SELECT pg_advisory_lock($1, $2)", [...LOCK]);
    const dbs = await client.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname ~ '^cb_(test|tpl)_[a-z0-9_]+$'",
    );
    for (const { datname } of dbs.rows) {
      await dropDatabase(client, datname);
      dropped.push(datname);
    }
    const roles = await client.query<{ rolname: string }>(
      "SELECT rolname FROM pg_roles WHERE rolname ~ '^cb_login_[a-z0-9_]+$'",
    );
    for (const { rolname } of roles.rows) {
      await client.query(`DROP ROLE IF EXISTS ${quoteIdent(rolname)}`);
      dropped.push(rolname);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1, $2)", [...LOCK]).catch(() => {});
    await client.end();
  }
  return dropped;
}
