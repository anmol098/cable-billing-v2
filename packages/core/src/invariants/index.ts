/**
 * Nightly invariants (T-052, PLAN §14 `invariants`, PLAN §8.4): set-based per-tenant checks of the
 * ledger, allocations, VC assignments and invoice uniqueness; results in `invariant_checks`; a
 * breach fails the `invariants.check` job, which raises the platform job-failure alert.
 */
export {
  type CheckTenantInvariantsOptions,
  checkTenantInvariants,
  DEFAULT_INVARIANT_SAMPLE_LIMIT,
  DEFAULT_INVARIANT_STATEMENT_TIMEOUT_MS,
} from "./check";
export {
  INVARIANT_CODES,
  type InvariantCode,
  type InvariantEntityType,
  type InvariantViolation,
  isInvariantCode,
  LEDGER_INVARIANT_CODES,
  type TenantInvariantReport,
} from "./codes";
export {
  createInvariantsCheckJob,
  enqueueInvariantsCheck,
  INVARIANT_BREACH_ERROR,
  INVARIANT_CHECK_INCOMPLETE_ERROR,
  INVARIANTS_CHECK_DEDUPE_KEY,
  INVARIANTS_TENANT_PAGE,
  InvariantsCheckPayload,
  type InvariantsCheckSettings,
  invariantsCheckJob,
} from "./job";
