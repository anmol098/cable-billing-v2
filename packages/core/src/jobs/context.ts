/**
 * The job (system) context: what a handler gets instead of a `TenantContext` (T-043; answers
 * T-025's open question "system actor for jobs").
 *
 * A job has no signed-in user, so it can't call `defineService` services (they need a context
 * issued by `resolveTenantContext`). Instead the handler works directly with transactions it gets
 * from its context, and the scope decides which ones:
 *
 * - **tenant jobs** (`operator_id` set): `withTenant(fn)` is bound to the job's own tenant. There
 *   is no way to open another tenant's transaction or a platform transaction, so a tenant job
 *   can't cross tenants even by mistake. The tenant id comes from the `jobs` row, never from the
 *   payload.
 * - **platform jobs** (`operator_id` NULL, e.g. a scheduler fanning out per tenant): `db` with
 *   `withPlatform` and `withTenant(operatorId, …)`, like T-020's `createDb` client.
 *
 * Audit: `audit(tx, event)` writes an `audit_events` row as the **system** (`actor_id` and
 * `actor_role` NULL), with the job's request id. Tenant jobs write into their tenant; platform
 * jobs write platform events (`operator_id` NULL, `withPlatform` tx), or tenant events through
 * `db.withTenant` with `operatorId` given explicitly.
 *
 * Writes that a tenant's read-only mode must stop (D-13, e.g. a billing run) check
 * `readTenantMode(tx)` themselves: the system actor has no capability list.
 */
import type { DbClient, Tx, TxOptions } from "@cb/db";
import { writeAuditEvent } from "../audit/audit";
import type { Logger } from "../logging/logger";

export interface JobInfo {
  readonly id: string;
  readonly type: string;
  /** The tenant the job works for; null for a platform job. */
  readonly operatorId: string | null;
  /** This attempt (1-based; a `continueLater` resume doesn't count). */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly createdAt: Date;
}

/** A system audit event (actor = the job). */
export interface JobAuditEvent {
  /** Dotted snake_case (`billing.run_completed`). */
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
}

interface JobContextBase<P> {
  readonly job: JobInfo;
  /** The validated payload. */
  readonly payload: P;
  /** Id for this run (logs, audit `request_id`). */
  readonly requestId: string;
  /** Logger with job_id, job_type, operator_id, attempt, worker_id and request_id set. No PII. */
  readonly log: Logger;
  /** The time this run started (worker clock). Use it instead of `new Date()`. */
  readonly now: Date;
  /** The worker clock, for long handlers that need the current time. */
  readonly clock: () => Date;
  /** When the worker wants this handler to have returned. */
  readonly deadline: Date;
  /** Milliseconds until `deadline` (negative once passed). */
  timeLeftMs(): number;
  /**
   * True once the time budget is nearly used up: stop at the next safe point and
   * `return continueLater({ payload: cursor })`. If a handler runs past the function's limit
   * anyway, its lease expires and the next invocation runs it again (as a new attempt), so
   * handlers must be idempotent.
   */
  shouldYield(): boolean;
}

export interface TenantJobContext<P> extends JobContextBase<P> {
  readonly scope: "tenant";
  readonly operatorId: string;
  /** A transaction in the job's tenant (`app_rw`, RLS on). */
  withTenant<T>(fn: (tx: Tx) => Promise<T>, options?: TxOptions): Promise<T>;
  /** Writes a system audit event for this tenant in `tx` (a `withTenant` transaction). */
  audit(tx: Tx, event: JobAuditEvent): Promise<string>;
}

export interface PlatformJobContext<P> extends JobContextBase<P> {
  readonly scope: "platform";
  /** `withPlatform` for cross-tenant reads/enqueues; `withTenant(operatorId, …)` per tenant. */
  readonly db: Pick<DbClient, "withPlatform" | "withTenant">;
  /**
   * Writes a system audit event in `tx`: `operatorId: null` in a `withPlatform` transaction, or the
   * tenant's id in that tenant's `withTenant` transaction.
   */
  audit(tx: Tx, event: JobAuditEvent & { readonly operatorId: string | null }): Promise<string>;
}

export type JobContext<P> = TenantJobContext<P> | PlatformJobContext<P>;

export interface BuildJobContextArgs<P> {
  readonly db: DbClient;
  readonly job: JobInfo;
  readonly payload: P;
  readonly requestId: string;
  readonly log: Logger;
  readonly clock: () => Date;
  readonly deadline: Date;
  /** `shouldYield()` turns true when less than this is left. */
  readonly yieldReserveMs: number;
}

/** Builds the context for one run (the worker calls this; exported for handler unit tests). */
export function buildJobContext<P>(args: BuildJobContextArgs<P>): JobContext<P> {
  const { db, job, clock, deadline, requestId } = args;
  const timeLeftMs = () => deadline.getTime() - clock().getTime();
  const base = {
    job,
    payload: args.payload,
    requestId,
    log: args.log,
    now: clock(),
    clock,
    deadline,
    timeLeftMs,
    shouldYield: () => timeLeftMs() < args.yieldReserveMs,
  };
  const write = (tx: Tx, operatorId: string | null, event: JobAuditEvent) =>
    writeAuditEvent(tx, {
      operatorId,
      actorId: null,
      actorRole: null,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      before: event.before,
      after: event.after,
      requestId,
    });

  if (job.operatorId !== null) {
    const operatorId = job.operatorId;
    return Object.freeze({
      ...base,
      scope: "tenant" as const,
      operatorId,
      withTenant: <T>(fn: (tx: Tx) => Promise<T>, options?: TxOptions) =>
        db.withTenant(operatorId, fn, options),
      audit: (tx: Tx, event: JobAuditEvent) => write(tx, operatorId, event),
    });
  }
  return Object.freeze({
    ...base,
    scope: "platform" as const,
    db: Object.freeze({
      withPlatform: db.withPlatform.bind(db),
      withTenant: db.withTenant.bind(db),
    }),
    audit: (tx: Tx, event: JobAuditEvent & { readonly operatorId: string | null }) =>
      write(tx, event.operatorId, event),
  });
}
