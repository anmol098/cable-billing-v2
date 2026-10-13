/**
 * @cb/core/testing: test helpers for core services (Vitest only; never import from app code).
 *
 * - Fixtures: `seedTenant`, `setSubscriptionStatus`, `contextFor`, `testRuntime`, `captureLogs`,
 *   `unverifiedTestContext` (pure unit tests only).
 * - Tenant isolation harness: `defineIsolationCases` / `exemptFromIsolation` (in your feature's
 *   `*.isolation.ts`), `checkIsolationCase`; discovery and coverage rules used by core's own
 *   `src/testing/isolation.test.ts` and `src/testing/coverage.test.ts`.
 * - `databaseFingerprint` / `changedTables` for "nothing was written" assertions.
 */
export { findCoverageGaps, inputTakesIds, MIN_EXEMPTION_REASON } from "./coverage";
export {
  CORE_SOURCE_DIR,
  type DiscoveredCaseSet,
  type DiscoveredService,
  discoverIsolationCaseSets,
  discoverServices,
  listModules,
} from "./discovery";
export { changedTables, databaseFingerprint, type Fingerprint } from "./fingerprint";
export {
  captureLogs,
  channelOf,
  contextFor,
  type LogCapture,
  type SeededTenant,
  type SeedTenantOptions,
  seedTenant,
  setSubscriptionStatus,
  testRuntime,
  unverifiedTestContext,
} from "./fixtures";
export {
  checkIsolationCase,
  collectUuids,
  defineIsolationCases,
  exemptFromIsolation,
  type IsolationCase,
  type IsolationCaseSet,
  type IsolationExpectation,
  type IsolationSeedArgs,
  isIsolationCaseSet,
} from "./isolation";
