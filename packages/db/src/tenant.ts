/**
 * Tenant and platform transactions: the only way @cb/db runs queries (PLAN §3, §9.1).
 *
 * `runInTenant(db, operatorId, fn)`:
 *   BEGIN
 *   select set_config('role', 'app_rw', true), set_config('app.operator_id', $1, true)
 *   …fn(tx)…
 *   COMMIT (or ROLLBACK if fn throws)
 *
 * `set_config(…, true)` is transaction-local (the same as `SET LOCAL`): both the role and the tenant
 * revert at COMMIT/ROLLBACK, so a pooled connection never carries a tenant (or the restricted role)
 * into the next transaction, and this is also safe behind a transaction-mode pooler (Neon's
 * pgbouncer). Session-level `SET` would not be.
 *
 * `runAsPlatform(db, fn)` is the same with role `app_platform` and an explicitly empty tenant.
 */
import { sql } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgTransaction, PgTransactionConfig } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm/relations";
import { isUuid } from "./ids";
import { APP_PLATFORM_ROLE, APP_RW_ROLE, OPERATOR_ID_SETTING } from "./rls";
import type * as schema from "./schema";

export type Schema = typeof schema;

/** A Drizzle database over either driver (node-postgres or Neon serverless; same result shape). */
export type Database = PgDatabase<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** The transaction handle passed to `withTenant` / `withPlatform` callbacks. */
export type Tx = PgTransaction<NodePgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;

/** Optional transaction settings, e.g. `{ isolationLevel: "serializable" }` for a billing run. */
export type TxOptions = Pick<PgTransactionConfig, "isolationLevel" | "accessMode">;

/** Thrown when a `tx` is used after its `withTenant` / `withPlatform` callback has finished. */
export class TransactionFinishedError extends Error {
  constructor() {
    super(
      "This transaction has finished: use `tx` only inside its withTenant/withPlatform callback " +
        "(its connection may already be serving another tenant).",
    );
    this.name = "TransactionFinishedError";
  }
}

/**
 * Wraps `tx` so any use after the callback settles throws instead of running a query on a pooled
 * connection that may already belong to another transaction (and another tenant).
 */
function guard(tx: Tx): { tx: Tx; close: () => void } {
  let open = true;
  const proxy = new Proxy(tx, {
    get(target, property) {
      if (!open) throw new TransactionFinishedError();
      if (property === "transaction") {
        // Nested transactions (savepoints) get their own guard.
        return <T>(fn: (inner: Tx) => Promise<T>) =>
          target.transaction(async (inner) => {
            const nested = guard(inner);
            try {
              return await fn(nested.tx);
            } finally {
              nested.close();
            }
          });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    tx: proxy,
    close: () => {
      open = false;
    },
  };
}

async function run<T>(
  db: Database,
  role: string,
  operatorId: string,
  fn: (tx: Tx) => Promise<T>,
  options: TxOptions | undefined,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    // One round trip. Both settings are LOCAL to this transaction. Changing `role` this way is
    // exactly `SET LOCAL ROLE`, with the same membership check.
    await rawTx.execute(
      sql`select set_config('role', ${role}, true), set_config(${OPERATOR_ID_SETTING}, ${operatorId}, true)`,
    );
    const { tx, close } = guard(rawTx);
    try {
      return await fn(tx);
    } finally {
      close();
    }
  }, options);
}

/**
 * Runs `fn` in a transaction as `app_rw` with `app.operator_id = operatorId`, so RLS limits every
 * statement to that tenant. Commits when `fn` resolves, rolls back when it throws (the error is
 * rethrown). `operatorId` must come from the server session/token, never from request input.
 */
export function runInTenant<T>(
  db: Database,
  operatorId: string,
  fn: (tx: Tx) => Promise<T>,
  options?: TxOptions,
): Promise<T> {
  if (!isUuid(operatorId)) {
    return Promise.reject(new TypeError("withTenant: operatorId must be a UUID"));
  }
  return run(db, APP_RW_ROLE, operatorId.toLowerCase(), fn, options);
}

/**
 * Runs `fn` in a transaction as `app_platform` with no tenant set. For cross-tenant jobs only
 * (scheduler, job queue, subscription states). Tenant tables are invisible here; to touch a
 * tenant's data, list the tenants here and then call `withTenant` once per tenant.
 */
export function runAsPlatform<T>(
  db: Database,
  fn: (tx: Tx) => Promise<T>,
  options?: TxOptions,
): Promise<T> {
  return run(db, APP_PLATFORM_ROLE, "", fn, options);
}
