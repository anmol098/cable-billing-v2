/**
 * The background job queue (T-023 table; T-043 builds the worker on it). PLAN §7.2, §14.
 *
 * One row per job. `operator_id` is the tenant the job works for (e.g. a billing batch), or NULL
 * for a platform job (e.g. the scheduler's fan-out). The worker (`job-worker` cron) runs on the
 * platform path (`withPlatform`), so `app_platform` may SELECT, INSERT and UPDATE every row
 * (policies below); it can't DELETE. Tenant transactions see and enqueue only their own tenant's
 * jobs (standard tenant policy). The handler then does the tenant's work in `withTenant`.
 *
 * Claiming (T-043), one statement in a `withPlatform` transaction:
 *
 * ```sql
 * UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_by = $worker,
 *        locked_until = now() + $lease, started_at = now(), updated_at = now()
 *  WHERE id IN (SELECT id FROM jobs
 *                WHERE (status = 'queued' AND run_after <= now())
 *                   OR (status = 'running' AND locked_until < now()   -- lease expired: resume
 *                       AND attempts < max_attempts)                 -- (else mark it failed)
 *                ORDER BY run_after, id
 *                LIMIT $n
 *                FOR UPDATE SKIP LOCKED)
 * RETURNING *;
 * ```
 *
 * Two workers never get the same row (SKIP LOCKED + the status change), and a job whose worker
 * ran out of time is picked up again once `locked_until` passes. `jobs_claimable_idx` and
 * `jobs_lease_idx` serve the two halves. On failure: `status = 'queued'`, `run_after = now() +
 * backoff`, `last_error`; when `attempts = max_attempts`: `status = 'failed'` (alert). Success:
 * `status = 'succeeded'`, `finished_at`.
 *
 * **Dedupe**: `dedupe_key` is unique per tenant among live jobs (`queued` / `running`):
 * `INSERT … ON CONFLICT DO NOTHING` enqueues a job only if the same one is not already waiting or
 * running (e.g. `billing_run:<period>`). Finished jobs don't block a new one.
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { appPlatform, tenantPolicies } from "../rls";
import { operators } from "./tenancy";

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const jobStatusEnum = pgEnum("job_status", JOB_STATUSES);

/** Job types: dotted snake_case, e.g. `billing.run_batch`. */
export const JOB_TYPE_PATTERN = "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$";

/** Default retry limit (PLAN §14: "up to 5 times, then failed"). */
export const DEFAULT_JOB_MAX_ATTEMPTS = 5;

/** Stand-in for NULL `operator_id` in the dedupe index (platform jobs dedupe among themselves). */
const NO_TENANT = "00000000-0000-0000-0000-000000000000";

export const jobs = pgTable(
  "jobs",
  {
    id: primaryId(),
    /** The tenant the job works for; NULL for platform jobs. */
    operatorId: uuid("operator_id").references(() => operators.id),
    type: text("type").notNull(),
    /** Handler input. Ids and periods only: no personal data, no secrets. */
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum("status").notNull().default("queued"),
    /** Not before this time (first run or backoff). */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(DEFAULT_JOB_MAX_ATTEMPTS),
    /** Lease: a `running` job whose lease passed is claimable again. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Which worker invocation holds the lease (for logs). */
    lockedBy: text("locked_by"),
    /** The last failure, for operators of the platform (no personal data). */
    lastError: text("last_error"),
    dedupeKey: text("dedupe_key"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("jobs_dedupe_live_unique")
      .on(sql`coalesce(${t.operatorId}, ${sql.raw(`'${NO_TENANT}'::uuid`)})`, t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL AND ${t.status} IN ('queued', 'running')`),
    index("jobs_claimable_idx").on(t.runAfter, t.id).where(sql`${t.status} = 'queued'`),
    index("jobs_lease_idx").on(t.lockedUntil).where(sql`${t.status} = 'running'`),
    index("jobs_operator_type_idx").on(t.operatorId, t.type, t.createdAt),
    check("jobs_type_format", sql`${t.type} ~ ${sql.raw(`'${JOB_TYPE_PATTERN}'`)}`),
    check("jobs_payload_object", sql`jsonb_typeof(${t.payload}) = 'object'`),
    check(
      "jobs_attempts_range",
      sql`${t.maxAttempts} >= 1 AND ${t.attempts} >= 0 AND ${t.attempts} <= ${t.maxAttempts}`,
    ),
    check("jobs_running_has_lease", sql`${t.status} <> 'running' OR ${t.lockedUntil} IS NOT NULL`),
    check(
      "jobs_finished_iff_done",
      sql`(${t.status} IN ('succeeded', 'failed')) = (${t.finishedAt} IS NOT NULL)`,
    ),
    check("jobs_dedupe_key_not_blank", sql`${t.dedupeKey} IS NULL OR btrim(${t.dedupeKey}) <> ''`),
    ...tenantPolicies(t),
    pgPolicy("jobs_platform_select", { for: "select", to: appPlatform, using: sql`true` }),
    pgPolicy("jobs_platform_insert", { for: "insert", to: appPlatform, withCheck: sql`true` }),
    pgPolicy("jobs_platform_update", {
      for: "update",
      to: appPlatform,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();
