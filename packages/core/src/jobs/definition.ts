/**
 * Job definitions (T-043, PLAN §14): what a background job is called, whose work it does, what its
 * payload looks like and how to run it.
 *
 * ```ts
 * // packages/core/src/billing/jobs.ts (T-044)
 * export const billingRunJob = defineJob({
 *   type: "billing.run",                 // dotted snake_case, unique
 *   scope: "tenant",                     // runs inside withTenant(job.operator_id)
 *   payload: z.object({ period: z.iso.date() }),
 *   async run({ payload, withTenant, shouldYield, log }) {
 *     for (const batch of batches) {
 *       if (shouldYield()) return continueLater({ payload: { ...payload, cursor } });
 *       await withTenant((tx) => billBatch(tx, batch));
 *     }
 *   },
 * });
 * ```
 *
 * A definition is a plain frozen value with no side effects: export it from your feature module
 * (re-exported by `@cb/core`), and the job worker finds it (`collectJobDefinitions(core)`). There
 * is no global registry to mutate at import time (T-025: core modules have no import-time side
 * effects).
 */
import type { z } from "zod";
import type { JobContext, PlatformJobContext, TenantJobContext } from "./context";

/** `tenant`: the job works for one tenant (`operator_id` set). `platform`: cross-tenant work. */
export const JOB_SCOPES = ["tenant", "platform"] as const;
export type JobScope = (typeof JOB_SCOPES)[number];

/** Job types: dotted snake_case with at least one dot (`billing.run`), as the `jobs` CHECK. */
const JOB_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/**
 * Returned by a handler that stopped early on purpose (its time budget is nearly used up): the job
 * goes back to the queue **without using up an attempt**, with an optional new payload (a cursor),
 * and the next worker invocation resumes it.
 */
export interface ContinueLater {
  readonly kind: "continue_later";
  /** Replaces the job's payload (validated against the definition's schema). */
  readonly payload?: Record<string, unknown>;
  /** Wait at least this long before resuming. Default 0 (the next invocation). */
  readonly delayMs?: number;
}

export function continueLater(
  options: { payload?: Record<string, unknown>; delayMs?: number } = {},
): ContinueLater {
  return Object.freeze({ kind: "continue_later" as const, ...options });
}

export function isContinueLater(value: unknown): value is ContinueLater {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "continue_later"
  );
}

/**
 * Throw from a handler when retrying cannot help (bad payload, a referenced row is gone): the job
 * is marked `failed` at once and the failure alert goes out. `code` is a snake_case reason that is
 * stored in `jobs.last_error` and logged, so it must not contain personal data.
 */
export class PermanentJobError extends Error {
  readonly code: string;
  constructor(code: string) {
    if (!/^[a-z][a-z0-9_]*$/.test(code)) {
      throw new TypeError(`PermanentJobError code must be snake_case, got "${code}"`);
    }
    super(`Permanent job failure: ${code}`);
    this.name = "PermanentJobError";
    this.code = code;
  }
}

/** What a handler may return: nothing (done) or `continueLater(...)`. */
export type JobHandlerResult = undefined | ContinueLater;

export type TenantJobHandler<P> = (
  ctx: TenantJobContext<P>,
) => Promise<JobHandlerResult> | Promise<void>;
export type PlatformJobHandler<P> = (
  ctx: PlatformJobContext<P>,
) => Promise<JobHandlerResult> | Promise<void>;

interface DefinitionBase<S extends z.ZodType> {
  /** Dotted snake_case, unique across the app (`billing.run`, `subscriptions.reconcile`). */
  readonly type: string;
  /** Zod schema of the payload (ids, periods and cursors only: never personal data or secrets). */
  readonly payload: S;
  /** Attempts before the job is marked `failed` (default 5, PLAN §14). */
  readonly maxAttempts?: number;
  /** Email the tenant owner when the job finally fails (tenant jobs only; default true). */
  readonly notifyOwner?: boolean;
}

export interface TenantJobDefinitionInput<S extends z.ZodType> extends DefinitionBase<S> {
  readonly scope: "tenant";
  run: TenantJobHandler<z.output<S>>;
}

export interface PlatformJobDefinitionInput<S extends z.ZodType> extends DefinitionBase<S> {
  readonly scope: "platform";
  run: PlatformJobHandler<z.output<S>>;
}

const JOB_MARK = Symbol.for("@cb/core/job-definition");

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  readonly [JOB_MARK]: true;
  readonly type: string;
  readonly scope: JobScope;
  readonly payload: S;
  readonly maxAttempts: number | undefined;
  readonly notifyOwner: boolean;
  /** Runs the handler with a context of the right scope (the worker calls this). */
  readonly run: (ctx: JobContext<z.output<S>>) => Promise<JobHandlerResult | undefined>;
}

// biome-ignore lint/suspicious/noExplicitAny: any job, whatever its payload schema.
export type AnyJobDefinition = JobDefinition<any>;

/** The payload type a definition accepts when enqueued. */
export type JobPayloadInput<D> = D extends JobDefinition<infer S> ? z.input<S> : never;

export function isJobDefinition(value: unknown): value is AnyJobDefinition {
  return typeof value === "object" && value !== null && JOB_MARK in value;
}

export function isJobType(value: unknown): value is string {
  return typeof value === "string" && JOB_TYPE.test(value);
}

export function defineJob<S extends z.ZodType>(
  input: TenantJobDefinitionInput<S> | PlatformJobDefinitionInput<S>,
): JobDefinition<S> {
  if (!isJobType(input.type)) {
    throw new TypeError(`defineJob: type must be dotted snake_case (a.b), got "${input.type}"`);
  }
  const scope: unknown = input.scope;
  if (scope !== "tenant" && scope !== "platform") {
    throw new TypeError(`defineJob(${input.type}): unknown scope "${String(scope)}"`);
  }
  const { maxAttempts } = input;
  if (maxAttempts !== undefined && (!Number.isInteger(maxAttempts) || maxAttempts < 1)) {
    throw new TypeError(`defineJob(${input.type}): maxAttempts must be a positive integer`);
  }
  const run = input.run as (ctx: JobContext<z.output<S>>) => Promise<JobHandlerResult | undefined>;
  return Object.freeze({
    [JOB_MARK]: true as const,
    type: input.type,
    scope: input.scope,
    payload: input.payload,
    maxAttempts,
    notifyOwner: input.scope === "tenant" && input.notifyOwner !== false,
    run,
  });
}
