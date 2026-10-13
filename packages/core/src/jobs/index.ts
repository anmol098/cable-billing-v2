/**
 * Background jobs (T-043, PLAN §14): DB queue, handler registry, time-budgeted worker, failure
 * alerts. How to add a job: see `definition.ts` and the T-043 completion notes.
 */
export {
  createJobFailureNotifier,
  createLogOnlyEmailTransport,
  createRecordingEmailTransport,
  createResendEmailTransport,
  type EmailMessage,
  EmailSendError,
  type EmailTransport,
  findJobAlertRecipients,
  type JobAlertAudience,
  type JobAlertRecipient,
  type JobAlertReport,
  type JobFailureEvent,
  type JobFailureNotifierOptions,
  RESEND_EMAILS_ENDPOINT,
  type RenderJobAlert,
  type RenderJobAlertArgs,
  type ResendTransportOptions,
} from "./alerts";
export {
  type BackoffOptions,
  backoffDelayMs,
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_MAX_MS,
} from "./backoff";
export {
  type BuildJobContextArgs,
  buildJobContext,
  type JobAuditEvent,
  type JobContext,
  type JobInfo,
  type PlatformJobContext,
  type TenantJobContext,
} from "./context";
export {
  type AnyJobDefinition,
  type ContinueLater,
  continueLater,
  defineJob,
  isContinueLater,
  isJobDefinition,
  isJobType,
  JOB_SCOPES,
  type JobDefinition,
  type JobHandlerResult,
  type JobPayloadInput,
  type JobScope,
  PermanentJobError,
  type PlatformJobDefinitionInput,
  type PlatformJobHandler,
  type TenantJobDefinitionInput,
  type TenantJobHandler,
} from "./definition";
export {
  JOB_FAILURE_REASONS,
  type JobFailure,
  type JobFailureHook,
  type JobFailureReason,
  jobErrorSummary,
} from "./failure";
export {
  type ClaimedJob,
  type ClaimOptions,
  claimJobs,
  completeJob,
  type EnqueueOptions,
  type EnqueueResult,
  type ExpiredJob,
  enqueueJob,
  failExpiredLeases,
  failJob,
  LEASE_EXPIRED_ERROR,
  type RequeueOptions,
  requeueJob,
} from "./queue";
export { collectJobDefinitions, createJobRegistry, type JobRegistry } from "./registry";
export {
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_JOBS_PER_RUN,
  DEFAULT_WORKER_BUDGET_MS,
  DEFAULT_YIELD_RESERVE_MS,
  type JobWorkerOptions,
  type JobWorkerReport,
  runJobWorker,
  type WorkerStopReason,
} from "./worker";
