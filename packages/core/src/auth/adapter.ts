/**
 * Better Auth's database adapter, running every query on the platform path (T-021 decision 1).
 *
 * Sign-in, sessions, password reset and two-factor checks happen before a tenant is known, so
 * they run as `app_platform` through `db.withPlatform`. `createDb` has no raw handle (T-020), so
 * Better Auth's Drizzle adapter can't hold one either. Instead each adapter call opens its own
 * short platform transaction and runs a Drizzle adapter built over that transaction's `tx`; when
 * Better Auth asks for a transaction (`adapter.transaction`), the whole callback runs in one
 * `withPlatform` transaction.
 *
 * The object returned is Better Auth's own factory-made adapter with its methods replaced, so the
 * schema check Better Auth attaches to it (field names, types) still runs.
 */
import { authSchema, type DbClient, type Tx } from "@cb/db";
import type { BetterAuthOptions, DBAdapter } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

type AdapterFactory = (options: BetterAuthOptions) => DBAdapter<BetterAuthOptions>;

const DRIZZLE_CONFIG = { provider: "pg", schema: authSchema } as const;

/** Methods that never touch the database (left as Better Auth made them). */
const LOCAL_MEMBERS = new Set(["id", "options", "createSchema"]);

/** `database` option for Better Auth: the Drizzle adapter over `withPlatform` transactions. */
export function platformAuthAdapter(db: Pick<DbClient, "withPlatform">): AdapterFactory {
  return (options) => {
    const overTx = (tx: Tx) => drizzleAdapter(tx, DRIZZLE_CONFIG)(options);
    // Built over a stand-in: only its configuration and its registered schema check are used.
    // Every database method is replaced below, so the stand-in is never queried.
    const adapter = drizzleAdapter({}, DRIZZLE_CONFIG)(options);
    const members = adapter as unknown as Record<string, unknown>;
    for (const [name, value] of Object.entries(members)) {
      if (LOCAL_MEMBERS.has(name) || typeof value !== "function") continue;
      if (name === "transaction") continue;
      members[name] = (...args: unknown[]) =>
        db.withPlatform((tx) => {
          const inner = overTx(tx) as unknown as Record<string, (...a: unknown[]) => unknown>;
          const method = inner[name];
          if (typeof method !== "function") {
            throw new TypeError(`Better Auth adapter has no method "${name}"`);
          }
          return Promise.resolve(method.apply(inner, args));
        });
    }
    adapter.transaction = (callback) => db.withPlatform((tx) => callback(overTx(tx)));
    return adapter;
  };
}
