/**
 * @cb/core: services, tenant guard, auth, authorization, audit and jobs.
 *
 * Foundations (T-025): TenantContext, capabilities + role matrix, read-only guard, defineService,
 * audit writer, error codes, structured logger. Test helpers (isolation harness) are in
 * `@cb/core/testing`. How to write a service: see the T-025 completion notes.
 *
 * Feature tasks append one `export * from "./<feature>";` line per module at the end.
 */
export const packageName = "@cb/core";

export {
  type AuditEventInput,
  type AuditRecorder,
  type AuditRow,
  type AuditSkipReason,
  writeAuditEvent,
} from "./audit/audit";
export { isSensitiveAuditKey, REDACTED, redactForAudit } from "./audit/redact";
export * from "./auth";
export { assertRole } from "./authz/assert-role";
export {
  CAPABILITIES,
  CAPABILITY_NAMES,
  type Capability,
  type CapabilityKind,
  type CapabilitySpec,
  can,
  capabilitySpec,
  isCapability,
  isTenantRole,
  rolesFor,
  TENANT_ROLES,
  type TenantRole,
} from "./authz/capabilities";
export {
  assertWritable,
  isAllowedInMode,
  READ_ONLY_ALLOWLIST,
  READ_ONLY_STATUSES,
  readTenantMode,
  type TenantMode,
  tenantModeOf,
} from "./authz/writable";
export * from "./billing";
export * from "./collections";
export {
  createServiceRuntime,
  isRequestId,
  newRequestId,
  requestIdFrom,
  type ServiceRuntime,
  type ServiceRuntimeOptions,
} from "./context/runtime";
export {
  logRuntimeRoleCheck,
  type RuntimeRoleCheckOptions,
  shouldCheckRuntimeRole,
  startRuntimeRoleCheck,
} from "./context/runtime-role";
export {
  type AnyService,
  defineService,
  isService,
  type Service,
  type ServiceArgs,
  type ServiceDefinition,
  type ServiceInput,
} from "./context/service";
export {
  type AuthenticatedPrincipal,
  type Channel,
  type ClientInfo,
  type ContextError,
  isIssuedTenantContext,
  resolveTenantContext,
  type TenantContext,
} from "./context/tenant-context";
export * from "./customers";
export {
  CORE_ERROR_CODES,
  type CoreErrorCode,
  type FieldIssue,
  isCoreErrorCode,
  isExpectedError,
  notFound,
  type ServiceError,
  serviceError,
  toServiceError,
  validationError,
} from "./errors/errors";
export * from "./invariants";
export * from "./jobs";
export {
  createLogger,
  errorLogFields,
  jsonLineSink,
  LOG_LEVELS,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type LogRecord,
  type LogSink,
  PiiInLogError,
  silentLogger,
  strictLoggingByDefault,
} from "./logging/logger";
export { findPii, isPiiKey, type PiiFinding, piiKindOfValue, scrubText } from "./logging/pii";
export * from "./mobile-auth";
export * from "./payments";
export * from "./receipts/links";
export * from "./tenants";
