/**
 * `pnpm --filter @cb/db db:test:clean`: drops every cb_tpl_* / cb_test_* database and cb_login_*
 * role the test harness made on the DATABASE_URL server (local hosts only, like the harness).
 * Don't run it while another checkout's DB tests are running on the same server.
 */
import { testDatabaseUrl } from "./env";
import { dropAllTestDatabases } from "./template";

const dropped = await dropAllTestDatabases(testDatabaseUrl());
console.warn(
  dropped.length ? `Dropped: ${dropped.join(", ")}` : "Nothing to drop: no harness databases.",
);
