/**
 * The job worker loop (T-043, PLAN §14 `job-worker`): one call per cron invocation.
 *
 * ```ts
 * const report = await runJobWorker({ db, registry, logger, budgetMs: 240_000, onFailure });
 * ```
 *
 * 1. Fails running jobs whose lease expired on their last attempt (and alerts).
 * 2. Loops: claim one job of a registered type → run its handler → record the outcome. It stops
 *    claiming when less than `yieldReserveMs` of the budget is left, when the queue is empty, or
 *    after `maxJobs`.
 * 3. Outcomes: success → `succeeded`; `continueLater(...)` → back to `queued` without using an
 *    attempt (resumed by the next invocation, optionally with a new payload); a thrown error →
 *    `queued` with exponential backoff + jitter, or `failed` on the last attempt / a
 *    `PermanentJobError` / an invalid payload, then `onFailure` (alert emails, Sentry).
 * 4. A handler that never returns (the function hits its time limit) keeps its lease until
 *    `leaseMs` passes; then the next invocation claims it again as a new attempt. So the lease must
 *    outlive the function (`leaseMs` ≥ the route's `maxDuration`), and handlers must be idempotent.
 */
import { type DbClient, uuidv7 } from "@cb/db";
import { createLogger, errorLogFields, type Logger, PiiInLogError } from "../logging/logger";
import { type BackoffOptions, backoffDelayMs } from "./backoff";
import { buildJobContext } from "./context";
import { type AnyJobDefinition, isContinueLater, PermanentJobError } from "./definition";
import { type JobFailure, type JobFailureHook, jobErrorSummary } from "./failure";
import {
  type ClaimedJob,
  claimJobs,
  completeJob,
  failExpiredLeases,
  failJob,
  requeueJob,
} from "./queue";
import type { JobRegistry } from "./registry";

/** PLAN §14: "processes … within a time budget (about 240 s)". */
export const DEFAULT_WORKER_BUDGET_MS = 240_000;
/** Stop claiming (and tell handlers to yield) when less than this is left. */
export const DEFAULT_YIELD_RESERVE_MS = 30_000;
/** ≥ the cron route's maxDuration (300 s), so a live run's lease never expires under it. */
export const DEFAULT_LEASE_MS = 300_000;
export const DEFAULT_MAX_JOBS_PER_RUN = 500;

export interface JobWorkerOptions {
  readonly db: DbClient;
  readonly registry: JobRegistry;
  readonly logger?: Logger;
  /** The clock (tests pass a controllable one). */
  readonly clock?: () => Date;
  readonly budgetMs?: number;
  readonly yieldReserveMs?: number;
  readonly leaseMs?: number;
  readonly maxJobs?: number;
  /** Identifies this invocation in `jobs.locked_by` and logs. Default `worker-<uuidv7>`. */
  readonly workerId?: string;
  /** Request id for this invocation's logs (e.g. from `x-vercel-id`). */
  readonly requestId?: string;
  readonly backoff?: BackoffOptions;
  /** Called once per job that ends up `failed`. Errors are logged, never rethrown. */
  readonly onFailure?: JobFailureHook;
}

export type WorkerStopReason = "queue_empty" | "budget" | "max_jobs";

export interface JobWorkerReport {
  readonly workerId: string;
  readonly claimed: number;
  readonly succeeded: number;
  /** `continueLater`: back in the queue, to be resumed. */
  readonly continued: number;
  /** Failed attempts put back with backoff. */
  readonly retried: number;
  /** Marked `failed` by this invocation (incl. expired last attempts). */
  readonly failed: number;
  /** Outcomes not recorded because another worker re-claimed the job after our lease expired. */
  readonly leaseLost: number;
  readonly stoppedBy: WorkerStopReason;
  readonly durationMs: number;
}

type Outcome = "succeeded" | "continued" | "retried" | "failed" | "lease_lost";

export async function runJobWorker(options: JobWorkerOptions): Promise<JobWorkerReport> {
  const clock = options.clock ?? (() => new Date());
  const budgetMs = options.budgetMs ?? DEFAULT_WORKER_BUDGET_MS;
  const reserveMs = options.yieldReserveMs ?? DEFAULT_YIELD_RESERVE_MS;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS_PER_RUN;
  const workerId = options.workerId ?? `worker-${uuidv7()}`;
  const requestId = options.requestId ?? uuidv7();
  const { db, registry } = options;
  const log = (options.logger ?? createLogger()).child({
    worker_id: workerId,
    request_id: requestId,
  });
  const started = clock();
  const deadline = new Date(started.getTime() + budgetMs);
  const types = registry.types();
  const counts: Record<Outcome, number> = {
    succeeded: 0,
    continued: 0,
    retried: 0,
    failed: 0,
    lease_lost: 0,
  };
  let claimed = 0;

  const notify = async (failure: JobFailure) => {
    if (!options.onFailure) return;
    try {
      await options.onFailure(failure);
    } catch (error) {
      if (error instanceof PiiInLogError) throw error;
      log.error("job.alert_hook_failed", { job_id: failure.jobId, ...errorLogFields(error) });
    }
  };

  // 1. Last attempts that ran out of time.
  for (const expired of await failExpiredLeases(db, { now: clock() })) {
    counts.failed += 1;
    const definition = registry.get(expired.type);
    log.error("job.failed", {
      job_id: expired.id,
      job_type: expired.type,
      operator_id: expired.operatorId,
      attempts: expired.attempts,
      reason: "lease_expired",
    });
    await notify({
      jobId: expired.id,
      type: expired.type,
      operatorId: expired.operatorId,
      attempts: expired.attempts,
      maxAttempts: expired.maxAttempts,
      reason: "lease_expired",
      lastError: expired.lastError,
      failedAt: clock(),
      notifyOwner: expired.operatorId !== null && (definition?.notifyOwner ?? true),
    });
  }

  // 2. Claim and run until the budget is nearly used up.
  let stoppedBy: WorkerStopReason;
  for (;;) {
    if (claimed >= maxJobs) {
      stoppedBy = "max_jobs";
      break;
    }
    if (deadline.getTime() - clock().getTime() < reserveMs) {
      stoppedBy = "budget";
      break;
    }
    const [job] = await claimJobs(db, { workerId, types, now: clock(), leaseMs, limit: 1 });
    if (!job) {
      stoppedBy = "queue_empty";
      break;
    }
    claimed += 1;
    const definition = registry.get(job.type);
    const outcome = definition
      ? await processJob(job, definition)
      : await recordFailure(job, undefined, new PermanentJobError("no_handler"));
    counts[outcome] += 1;
  }

  const report: JobWorkerReport = {
    workerId,
    claimed,
    succeeded: counts.succeeded,
    continued: counts.continued,
    retried: counts.retried,
    failed: counts.failed,
    leaseLost: counts.lease_lost,
    stoppedBy,
    durationMs: clock().getTime() - started.getTime(),
  };
  log.info("job_worker.finished", {
    claimed: report.claimed,
    succeeded: report.succeeded,
    continued: report.continued,
    retried: report.retried,
    failed: report.failed,
    lease_lost: report.leaseLost,
    stopped_by: report.stoppedBy,
    duration_ms: report.durationMs,
  });
  return report;

  async function processJob(job: ClaimedJob, definition: AnyJobDefinition): Promise<Outcome> {
    const runStarted = clock();
    const jobLog = log.child({
      job_id: job.id,
      job_type: job.type,
      operator_id: job.operatorId,
      attempt: job.attempts,
    });
    try {
      if ((definition.scope === "tenant") !== (job.operatorId !== null)) {
        throw new PermanentJobError("scope_mismatch");
      }
      const parsed = definition.payload.safeParse(job.payload);
      if (!parsed.success) throw new PermanentJobError("invalid_payload");
      const ctx = buildJobContext({
        db,
        job: {
          id: job.id,
          type: job.type,
          operatorId: job.operatorId,
          attempt: job.attempts,
          maxAttempts: job.maxAttempts,
          createdAt: job.createdAt,
        },
        payload: parsed.data,
        requestId: uuidv7(),
        log: jobLog,
        clock,
        deadline,
        yieldReserveMs: reserveMs,
      });
      const result = await definition.run(ctx);
      const now = clock();
      if (isContinueLater(result)) {
        let payload: Record<string, unknown> | undefined;
        if (result.payload !== undefined) {
          const next = definition.payload.safeParse(result.payload);
          if (!next.success) throw new PermanentJobError("invalid_continue_payload");
          payload = next.data as Record<string, unknown>;
        }
        const delayMs = Math.max(0, result.delayMs ?? 0);
        const kept = await requeueJob(db, job, {
          now,
          runAfter: new Date(now.getTime() + delayMs),
          refundAttempt: true,
          ...(payload === undefined ? {} : { payload }),
        });
        if (!kept) return leaseLost(jobLog);
        jobLog.info("job.continued", {
          duration_ms: now.getTime() - runStarted.getTime(),
          resume_in_ms: delayMs,
        });
        return "continued";
      }
      if (!(await completeJob(db, job, now))) return leaseLost(jobLog);
      jobLog.info("job.succeeded", { duration_ms: now.getTime() - runStarted.getTime() });
      return "succeeded";
    } catch (error) {
      if (error instanceof PiiInLogError) throw error;
      return recordFailure(job, definition, error, jobLog, runStarted);
    }
  }

  async function recordFailure(
    job: ClaimedJob,
    definition: AnyJobDefinition | undefined,
    error: unknown,
    jobLog: Logger = log.child({ job_id: job.id, job_type: job.type, attempt: job.attempts }),
    runStarted: Date = clock(),
  ): Promise<Outcome> {
    const now = clock();
    const lastError = jobErrorSummary(error);
    const permanent = error instanceof PermanentJobError;
    const fields = {
      duration_ms: now.getTime() - runStarted.getTime(),
      max_attempts: job.maxAttempts,
      ...errorLogFields(error),
      ...(permanent ? { error_code: error.code } : {}),
    };
    if (!permanent && job.attempts < job.maxAttempts) {
      const delayMs = backoffDelayMs(job.attempts, options.backoff);
      const kept = await requeueJob(db, job, {
        now,
        runAfter: new Date(now.getTime() + delayMs),
        lastError,
      });
      if (!kept) return leaseLost(jobLog);
      jobLog.warn("job.retry_scheduled", { ...fields, retry_in_ms: delayMs });
      return "retried";
    }
    if (!(await failJob(db, job, { now, lastError }))) return leaseLost(jobLog);
    const reason = permanent ? "permanent" : "max_attempts";
    jobLog.error("job.failed", { ...fields, reason });
    await notify({
      jobId: job.id,
      type: job.type,
      operatorId: job.operatorId,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      reason,
      lastError,
      failedAt: now,
      notifyOwner: job.operatorId !== null && (definition?.notifyOwner ?? true),
    });
    return "failed";
  }
}

function leaseLost(log: Logger): Outcome {
  log.warn("job.lease_lost", {});
  return "lease_lost";
}
