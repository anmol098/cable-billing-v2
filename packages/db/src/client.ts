/**
 * Database client (E-02): a connection pool wrapped so that every query runs inside `withTenant`
 * or `withPlatform`. There is deliberately no raw `db` handle: code outside a transaction wrapper
 * can't query, so it can't forget the tenant.
 *
 * Drivers:
 * - `neon`: `@neondatabase/serverless` Pool (WebSocket). Runtime on Vercel; supports interactive
 *   transactions and `SELECT … FOR UPDATE`, which the HTTP driver can't (E-02).
 * - `pg`: node-postgres Pool over TCP. Local Postgres, CI, tests and scripts.
 * - `auto` (default): `neon` for `*.neon.tech` hosts, `pg` otherwise.
 *
 * Use one client per process (a module-level singleton in apps/web) and `end()` it in scripts.
 */
import { Pool as NeonPool } from "@neondatabase/serverless";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-serverless";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { type Database, runAsPlatform, runInTenant, type Tx, type TxOptions } from "./tenant";

export type DbDriver = "neon" | "pg";

export interface CreateDbOptions {
  /** Postgres URL. On Vercel: `DATABASE_URL` (Neon pooled endpoint). */
  connectionString: string;
  /** Default `auto`: `neon` for `*.neon.tech` hosts, otherwise `pg`. */
  driver?: DbDriver | "auto";
  /** Maximum pooled connections (default 10). */
  max?: number;
  /**
   * Called when an idle pooled connection fails (e.g. the server closed it). The pool drops that
   * connection and carries on; without a listener the error would crash the process.
   * Default: `console.error`.
   */
  onIdleError?: (error: Error) => void;
}

export interface DbClient {
  /** The driver in use. */
  readonly driver: DbDriver;
  /**
   * Runs `fn` in a transaction scoped to one tenant (role `app_rw`, `app.operator_id` set, RLS on).
   * Commits on success, rolls back and rethrows on error. Never let `tx` escape `fn`.
   */
  withTenant<T>(operatorId: string, fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T>;
  /**
   * Runs `fn` in a transaction as `app_platform` with no tenant: cross-tenant jobs only. Tenant
   * tables return no rows here; use `withTenant` per tenant for their data.
   */
  withPlatform<T>(fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T>;
  /** Closes the pool. */
  end(): Promise<void>;
}

/** Picks the driver for a URL: Neon's WebSocket driver for `*.neon.tech`, node-postgres otherwise. */
export function resolveDriver(
  connectionString: string,
  driver: DbDriver | "auto" = "auto",
): DbDriver {
  if (driver !== "auto") return driver;
  let host: string;
  try {
    host = new URL(connectionString).hostname;
  } catch {
    throw new TypeError("createDb: connectionString is not a valid URL");
  }
  return host === "neon.tech" || host.endsWith(".neon.tech") ? "neon" : "pg";
}

/** Creates a pooled client. Connections open lazily, on the first transaction. */
export function createDb(options: CreateDbOptions): DbClient {
  const driver = resolveDriver(options.connectionString, options.driver);
  const poolConfig = { connectionString: options.connectionString, max: options.max ?? 10 };
  const onIdleError =
    options.onIdleError ??
    ((error: Error) => console.error("@cb/db: idle connection error", error.message));

  let db: Database;
  let end: () => Promise<void>;
  if (driver === "neon") {
    const pool = new NeonPool(poolConfig);
    pool.on("error", onIdleError);
    // Both drivers return node-postgres-shaped results; Database is typed with the pg HKT.
    db = drizzleNeon({ client: pool, schema }) as unknown as Database;
    end = () => pool.end();
  } else {
    const pool = new pg.Pool(poolConfig);
    pool.on("error", onIdleError);
    db = drizzlePg({ client: pool, schema });
    end = () => pool.end();
  }

  return {
    driver,
    withTenant: (operatorId, fn, txOptions) => runInTenant(db, operatorId, fn, txOptions),
    withPlatform: (fn, txOptions) => runAsPlatform(db, fn, txOptions),
    end,
  };
}
