/**
 * The queue operations on the `jobs` table (T-023 schema; claim SQL documented in
 * `packages/db/src/schema/jobs.ts`).
 *
 * - `enqueueJob(tx, job, payload, options)`: inside any transaction (a tenant service's
 *   `withTenant` tx, or `withPlatform`), so the job is created atomically with the change that
 *   needs it. Dedupe: at most one live (`queued`/`running`) job per tenant and `dedupeKey`.
 * - `claimJobs`, `completeJob`, `requeueJob`, `failJob`, `failExpiredLeases`: the worker's steps.
 *   Each runs in its own short `withPlatform` transaction; completion is guarded by the lease
 *   (`status = 'running' AND locked_by AND attempts`), so a worker whose lease expired (and whose
 *   job another worker re-claimed) can't overwrite the newer run's outcome.
 *
 * All times come from the caller's clock (passed as parameters, never the database's `now()`), so
 * tests can move time and production uses one clock for leases and backoff.
 */
import { type DbClient, DEFAULT_JOB_MAX_ATTEMPTS, jobs, type Tx, uuidv7 } from "@cb/db";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { type AnyJobDefinition, isJobDefinition, isJobType } from "./definition";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface EnqueueOptions {
  /**
   * The tenant the job works for. Default: the transaction's tenant (`withTenant`), or none on the
   * platform path. A tenant transaction can only enqueue for its own tenant (RLS).
   */
  readonly operatorId?: string | null;
  /** At most one live job per tenant and key (e.g. `billing.run:2026-10-01`). */
  readonly dedupeKey?: string;
  /** Not before this time. Default: now (database time of the transaction). */
  readonly runAfter?: Date;
  /** Overrides the definition's `maxAttempts` (default 5). */
  readonly maxAttempts?: number;
}

export interface EnqueueResult {
  readonly jobId: string;
  /** false: a live job with the same dedupe key already existed; `jobId` is that job. */
  readonly created: boolean;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function currentTenant(tx: Tx): Promise<string | null> {
  const result = await tx.execute<{ operator_id: string | null }>(
    sql`select app.current_operator() as operator_id`,
  );
  return result.rows[0]?.operator_id ?? null;
}

/**
 * Enqueues a job in `tx`. With a definition the payload is validated (and stored as parsed) and
 * the scope is enforced: a tenant job needs a tenant, a platform job has none. Throws on a
 * programming error (bad type, invalid payload, wrong scope); RLS rejects a tenant enqueueing for
 * another tenant (42501).
 */
export async function enqueueJob(
  tx: Tx,
  job: AnyJobDefinition | string,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<EnqueueResult> {
  const definition = isJobDefinition(job) ? job : undefined;
  const type = definition ? definition.type : job;
  if (!isJobType(type)) throw new TypeError(`enqueueJob: bad job type "${String(type)}"`);
  const stored = definition ? definition.payload.parse(payload) : payload;
  if (!isPlainObject(stored)) throw new TypeError(`enqueueJob(${type}): payload must be an object`);
  if (options.dedupeKey !== undefined && options.dedupeKey.trim() === "") {
    throw new TypeError(`enqueueJob(${type}): dedupeKey must not be blank`);
  }

  let operatorId =
    options.operatorId === undefined
      ? definition?.scope === "platform"
        ? null
        : await currentTenant(tx)
      : options.operatorId;
  if (definition?.scope === "tenant" && operatorId === null) {
    throw new TypeError(`enqueueJob(${type}): a tenant job needs an operatorId`);
  }
  if (definition?.scope === "platform" && operatorId !== null) {
    throw new TypeError(`enqueueJob(${type}): a platform job has no operatorId`);
  }
  operatorId = operatorId ?? null;

  const maxAttempts = options.maxAttempts ?? definition?.maxAttempts ?? DEFAULT_JOB_MAX_ATTEMPTS;
  // Retry once if the live duplicate finished between our insert and our lookup.
  for (let round = 0; round < 3; round += 1) {
    const id = uuidv7();
    const inserted = await tx
      .insert(jobs)
      .values({
        id,
        operatorId,
        type,
        payload: stored,
        maxAttempts,
        dedupeKey: options.dedupeKey ?? null,
        ...(options.runAfter ? { runAfter: options.runAfter } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: jobs.id });
    if (inserted[0]) return { jobId: inserted[0].id, created: true };
    if (options.dedupeKey === undefined) break; // conflict on the id itself: can't happen
    const live = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          sql`coalesce(${jobs.operatorId}, ${NIL_UUID}::uuid) = coalesce(${operatorId}::uuid, ${NIL_UUID}::uuid)`,
          eq(jobs.dedupeKey, options.dedupeKey),
          inArray(jobs.status, ["queued", "running"]),
        ),
      )
      .limit(1);
    if (live[0]) return { jobId: live[0].id, created: false };
  }
  throw new Error(`enqueueJob(${type}): could not insert or find the job`);
}

/** A job as the worker holds it after claiming. */
export interface ClaimedJob {
  readonly id: string;
  readonly type: string;
  readonly operatorId: string | null;
  readonly payload: Record<string, unknown>;
  /** Including this claim. */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lockedBy: string;
  readonly lockedUntil: Date;
  readonly createdAt: Date;
}

type JobRow = {
  id: string;
  type: string;
  operator_id: string | null;
  payload: Record<string, unknown> | string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: string | Date | null;
  created_at: string | Date;
  last_error?: string | null;
};

const toDate = (value: string | Date): Date => (value instanceof Date ? value : new Date(value));

function toClaimed(row: JobRow): ClaimedJob {
  return {
    id: row.id,
    type: row.type,
    operatorId: row.operator_id,
    payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lockedBy: row.locked_by ?? "",
    lockedUntil: toDate(row.locked_until ?? new Date(0)),
    createdAt: toDate(row.created_at),
  };
}

const ts = (date: Date): SQL => sql`${date.toISOString()}::timestamptz`;
const typeList = (types: readonly string[]): SQL =>
  sql.join(
    types.map((t) => sql`${t}`),
    sql`, `,
  );

export interface ClaimOptions {
  readonly workerId: string;
  /** Only these job types (the ones the worker has handlers for). */
  readonly types: readonly string[];
  readonly now: Date;
  readonly leaseMs: number;
  readonly limit?: number;
}

/**
 * Claims up to `limit` jobs (default 1): queued jobs whose `run_after` has come, and running jobs
 * whose lease expired with attempts left (resumed). `FOR UPDATE SKIP LOCKED` + the status change
 * mean two workers never get the same job.
 */
export async function claimJobs(
  db: Pick<DbClient, "withPlatform">,
  options: ClaimOptions,
): Promise<ClaimedJob[]> {
  if (options.types.length === 0) return [];
  const now = ts(options.now);
  const until = ts(new Date(options.now.getTime() + options.leaseMs));
  const limit = options.limit ?? 1;
  return db.withPlatform(async (tx) => {
    const result = await tx.execute<JobRow>(sql`
      UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = ${options.workerId},
             locked_until = ${until}, started_at = ${now}, updated_at = ${now}
       WHERE id IN (SELECT id FROM jobs
                     WHERE type IN (${typeList(options.types)})
                       AND ((status = 'queued' AND run_after <= ${now})
                         OR (status = 'running' AND locked_until < ${now}
                             AND attempts < max_attempts))
                     ORDER BY run_after, id
                     LIMIT ${limit}
                     FOR UPDATE SKIP LOCKED)
      RETURNING id, type, operator_id, payload, attempts, max_attempts, locked_by, locked_until,
                created_at`);
    return result.rows.map(toClaimed);
  });
}

const leaseGuard = (job: ClaimedJob): SQL =>
  sql`id = ${job.id} AND status = 'running' AND locked_by = ${job.lockedBy} AND attempts = ${job.attempts}`;

async function guardedUpdate(
  db: Pick<DbClient, "withPlatform">,
  job: ClaimedJob,
  set: SQL,
): Promise<boolean> {
  return db.withPlatform(async (tx) => {
    const result = await tx.execute<{ id: string }>(
      sql`UPDATE jobs SET ${set} WHERE ${leaseGuard(job)} RETURNING id`,
    );
    return result.rows.length === 1;
  });
}

/** Marks a claimed job succeeded. false: the lease was lost (another worker owns the job now). */
export function completeJob(
  db: Pick<DbClient, "withPlatform">,
  job: ClaimedJob,
  now: Date,
): Promise<boolean> {
  return guardedUpdate(
    db,
    job,
    sql`status = 'succeeded', finished_at = ${ts(now)}, locked_until = NULL, updated_at = ${ts(now)}`,
  );
}

export interface RequeueOptions {
  readonly now: Date;
  readonly runAfter: Date;
  /** Stored as `last_error` (a failed attempt). Omit for a `continueLater`. */
  readonly lastError?: string;
  /** New payload (a `continueLater` cursor). */
  readonly payload?: Record<string, unknown>;
  /** Give the attempt back (a `continueLater` is not a failure). */
  readonly refundAttempt?: boolean;
}

/** Puts a claimed job back in the queue (backoff or resume). false: the lease was lost. */
export function requeueJob(
  db: Pick<DbClient, "withPlatform">,
  job: ClaimedJob,
  options: RequeueOptions,
): Promise<boolean> {
  const parts: SQL[] = [
    sql`status = 'queued'`,
    sql`run_after = ${ts(options.runAfter)}`,
    sql`locked_until = NULL`,
    sql`updated_at = ${ts(options.now)}`,
  ];
  if (options.lastError !== undefined) parts.push(sql`last_error = ${options.lastError}`);
  if (options.payload !== undefined) {
    parts.push(sql`payload = ${JSON.stringify(options.payload)}::jsonb`);
  }
  if (options.refundAttempt) parts.push(sql`attempts = attempts - 1`);
  return guardedUpdate(db, job, sql.join(parts, sql`, `));
}

/** Marks a claimed job failed (no more retries). false: the lease was lost. */
export function failJob(
  db: Pick<DbClient, "withPlatform">,
  job: ClaimedJob,
  options: { now: Date; lastError: string },
): Promise<boolean> {
  return guardedUpdate(
    db,
    job,
    sql`status = 'failed', finished_at = ${ts(options.now)}, locked_until = NULL,
        last_error = ${options.lastError}, updated_at = ${ts(options.now)}`,
  );
}

export interface ExpiredJob {
  readonly id: string;
  readonly type: string;
  readonly operatorId: string | null;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string;
}

/** `last_error` of a job whose last attempt ran out of time. */
export const LEASE_EXPIRED_ERROR = "lease_expired: the last attempt did not finish in time";

/**
 * Fails running jobs whose lease expired on their last allowed attempt (the claim no longer picks
 * them up). Returns them, for the failure alert.
 */
export async function failExpiredLeases(
  db: Pick<DbClient, "withPlatform">,
  options: { now: Date; limit?: number },
): Promise<ExpiredJob[]> {
  const now = ts(options.now);
  return db.withPlatform(async (tx) => {
    const result = await tx.execute<JobRow>(sql`
      UPDATE jobs SET status = 'failed', finished_at = ${now}, locked_until = NULL,
             last_error = ${LEASE_EXPIRED_ERROR}, updated_at = ${now}
       WHERE id IN (SELECT id FROM jobs
                     WHERE status = 'running' AND locked_until < ${now}
                       AND attempts >= max_attempts
                     ORDER BY locked_until, id
                     LIMIT ${options.limit ?? 100}
                     FOR UPDATE SKIP LOCKED)
      RETURNING id, type, operator_id, payload, attempts, max_attempts, locked_by, locked_until,
                created_at, last_error`);
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      operatorId: row.operator_id,
      attempts: Number(row.attempts),
      maxAttempts: Number(row.max_attempts),
      lastError: row.last_error ?? LEASE_EXPIRED_ERROR,
    }));
  });
}
