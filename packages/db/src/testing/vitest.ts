/**
 * Vitest glue: one database per test file.
 *
 * ```ts
 * import { createTenant, describeDb, useTestDatabase } from "@cb/db/testing";
 *
 * describeDb("areas", () => {
 *   const t = useTestDatabase();
 *   it("is tenant-scoped", async () => {
 *     const a = await createTenant(t.current);
 *     await t.current.db.withTenant(a.operatorId, async (tx) => { … });
 *   });
 * });
 * ```
 */
import { afterAll, beforeAll, describe } from "vitest";
import { createTestDatabase, type TestDatabase } from "./database";
import { dbTestsSkipped } from "./env";

/**
 * `describe` for suites that need Postgres. Normally it is plain `describe`: the suite runs and,
 * without a server, fails with a clear message. With `CB_SKIP_DB_TESTS=1` the suite is reported
 * as skipped, with "[SKIPPED: CB_SKIP_DB_TESTS=1]" in its name, never as passed.
 */
export function describeDb(name: string, fn: () => void): void {
  if (dbTestsSkipped()) {
    describe.skip(`${name} [SKIPPED: CB_SKIP_DB_TESTS=1, DB suites not run]`, fn);
  } else {
    describe(name, fn);
  }
}

export interface TestDatabaseHandle {
  /** The database for this file. Throws if read before `beforeAll` ran. */
  readonly current: TestDatabase;
}

/** Creates a migrated database in `beforeAll` and drops it in `afterAll`. Call inside describeDb. */
export function useTestDatabase(): TestDatabaseHandle {
  let database: TestDatabase | undefined;
  beforeAll(async () => {
    database = await createTestDatabase();
  }, 120_000);
  afterAll(async () => {
    await database?.drop();
  }, 60_000);
  return {
    get current(): TestDatabase {
      if (!database)
        throw new Error("useTestDatabase: the database is not ready (use it in tests)");
      return database;
    },
  };
}
