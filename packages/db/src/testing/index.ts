/**
 * @cb/db/testing: DB integration-test harness (Vitest only; never import from app code).
 * See packages/db/README.md "Testing".
 */
export { createTestDatabase, type TestDatabase } from "./database";
export {
  DEFAULT_TEST_DATABASE_URL,
  dbTestsSkipped,
  testDatabaseUrl,
  withCredentials,
  withDatabase,
} from "./env";
export { createTenant, type TestTenant } from "./fixtures";
export { auditDatabaseSecurity, type SecurityAuditOptions } from "./security-audit";
export { ensureTemplate, MIGRATIONS_DIR, migrateDatabase, migrationsHash } from "./template";
export { describeDb, type TestDatabaseHandle, useTestDatabase } from "./vitest";
