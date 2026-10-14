/**
 * Platform admin console services (T-086, PLAN §9.4, §12.4, §13; PRD §3, §16). See the T-086
 * completion notes for the security model.
 */
export {
  type AdminContext,
  type AdminContextError,
  type AdminPrincipal,
  assertIssuedAdminContext,
  isIssuedAdminContext,
  resolveAdminContext,
} from "./context";
export { CreateTenantInput, createTenantByAdmin } from "./create-tenant";
export {
  METRICS_ACTIVE_DAYS,
  METRICS_WINDOW_DAYS,
  type PlatformMetrics,
  PlatformMetricsInput,
  platformMetrics,
} from "./metrics";
export {
  ADMIN_LIST_LIMIT,
  type AdminAuditRow,
  type AdminBillingRunRow,
  type AdminJobRow,
  type AdminRazorpayEventRow,
  ListBillingRunsInput,
  ListJobsInput,
  ListPlatformAuditInput,
  ListRazorpayEventsInput,
  listBillingRuns,
  listJobs,
  listPlatformAudit,
  listRazorpayEvents,
  RetryJobInput,
  retryJob,
} from "./monitor";
export {
  type AdminAuditEvent,
  type AdminAuditRecorder,
  type AdminService,
  type AdminServiceArgs,
  type AdminServiceDefinition,
  defineAdminService,
} from "./service";
export {
  addMonthsToDate,
  ExtendSubscriptionInput,
  extendSubscription,
  MAX_EXTEND_DAYS,
  MAX_OFFLINE_PAYMENT_PAISE,
  RecordOfflinePaymentInput,
  recordOfflinePayment,
} from "./subscription";
export {
  EndSupportAccessInput,
  endSupportAccess,
  GrantSupportAccessInput,
  grantSupportAccess,
  type SupportGrantView,
  type SupportView,
  SupportViewInput,
  supportView,
} from "./support";
export {
  ADMIN_TENANTS_PAGE_SIZE,
  type AdminBillingRunSummary,
  type AdminSupportGrant,
  type AdminTenantDetail,
  type AdminTenantRow,
  type AdminTimelineEvent,
  ListTenantsInput,
  listTenants,
  TenantDetailInput,
  tenantDetail,
} from "./tenants";
