/**
 * Where DB integration tests run, and the guard rails around it.
 *
 * - `DATABASE_URL` names the server (CI sets it; locally it defaults to the Docker/apt Postgres
 *   from apps/web/.env.example). The harness creates and drops its own `cb_tpl_*` / `cb_test_*`
 *   databases there and never touches the database named in the URL beyond an advisory lock.
 * - Remote hosts are refused unless `CB_TEST_DATABASE_ALLOW_REMOTE=1`, so a production URL in a
 *   developer's shell can't have test databases created on it.
 * - `CB_SKIP_DB_TESTS=1` is the only way to skip DB suites: `describeDb` then skips them and says so
 *   loudly. There is no automatic skip when Postgres is down: the suites fail with a clear message.
 */

export const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5432/cable_billing";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The admin URL tests connect to (superuser or a role with CREATEDB + CREATEROLE). */
export function testDatabaseUrl(): string {
  const url = process.env.DATABASE_URL || DEFAULT_TEST_DATABASE_URL;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid postgres:// URL");
  }
  if (!LOCAL_HOSTS.has(host) && process.env.CB_TEST_DATABASE_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing to create test databases on remote host "${host}". DB tests run against a local ` +
        "Postgres (CI: the service container). Set CB_TEST_DATABASE_ALLOW_REMOTE=1 to override.",
    );
  }
  return url;
}

/** True when DB suites were deliberately switched off with `CB_SKIP_DB_TESTS=1`. */
export function dbTestsSkipped(): boolean {
  return process.env.CB_SKIP_DB_TESTS === "1";
}

/** `url` with another database name. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** `url` with other credentials. */
export function withCredentials(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = encodeURIComponent(user);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

/** `host:port/database` for messages (no credentials). */
export function describeUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
}

/** Double-quotes an identifier we generated ourselves (validated, so no escaping games). */
export function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new TypeError(`unsafe identifier: ${name}`);
  return `"${name}"`;
}
