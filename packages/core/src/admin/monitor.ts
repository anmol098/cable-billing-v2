/**
 * Job monitor, billing runs across tenants, Razorpay event log and the platform audit log
 * (T-086, PLAN §12.4, §14). Platform path only; every read writes a platform audit event.
 *
 * - Jobs (T-043): type, tenant, status, tries, the safe `last_error`. Never the payload.
 * - Retry: a `failed` job is re-enqueued as a **new** job (same type, tenant, payload, dedupe key
 *   and try limit); the failed row stays as it was (history). Refused when a live (queued or
 *   running) copy already exists. Billing jobs resume their run from its cursor (T-044 handlers
 *   are idempotent).
 * - Billing runs (T-044): the columns `PLATFORM_READ_COLUMNS` allows (status and counts, no
 *   money) and the failed items' reasons, counted.
 * - Razorpay events (T-085 `subscription_events`): id, type, tenant, received/processed, error
 *   code. Never the payload (it can hold the payer's contact details).
 */
import { BILLING_RUN_STATUSES, JOB_STATUSES, jobs, type Tx, uuidv7 } from "@cb/db";
import { err, ok } from "@cb/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import * as z from "zod";
import { notFound, serviceError } from "../errors/errors";
import { asDate, asInt } from "./rows";
import { defineAdminService } from "./service";
import { type AdminBillingRunSummary, billingRunSummary } from "./tenants";

export const ADMIN_LIST_LIMIT = 100;

/** Keyset cursor `<iso time>|<uuid>` (newest first). */
const Cursor = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\|[0-9a-f-]{36}$/)
  .optional();

function splitCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = cursor.split("|");
  return at && id ? { at, id } : null;
}

const nextCursor = (at: Date | null, id: string) => (at ? `${at.toISOString()}|${id}` : null);

export interface AdminJobRow {
  readonly jobId: string;
  readonly operatorId: string | null;
  readonly operatorName: string | null;
  readonly type: string;
  readonly status: (typeof JOB_STATUSES)[number];
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly finishedAt: Date | null;
  readonly runAfter: Date | null;
}

export const ListJobsInput = z.object({
  status: z.enum(JOB_STATUSES).optional(),
  cursor: Cursor,
});

export const listJobs = defineAdminService({
  name: "admin.jobs_list",
  input: ListJobsInput,
  async run({ input, runtime, audit }) {
    return ok(
      await runtime.db.withPlatform(async (tx) => {
        const after = splitCursor(input.cursor);
        const filters = [sql`true`];
        if (input.status) filters.push(sql`j.status = ${input.status}`);
        if (after) {
          filters.push(sql`(j.created_at, j.id) < (${after.at}::timestamptz, ${after.id}::uuid)`);
        }
        const result = await tx.execute(sql`
          SELECT j.id, j.operator_id, o.name AS operator_name, j.type, j.status::text AS status,
                 j.attempts, j.max_attempts, j.last_error, j.created_at, j.finished_at, j.run_after
            FROM jobs j LEFT JOIN operators o ON o.id = j.operator_id
           WHERE ${sql.join(filters, sql` AND `)}
           ORDER BY j.created_at DESC, j.id DESC
           LIMIT ${ADMIN_LIST_LIMIT + 1}`);
        const counts = await tx.execute(sql`
          SELECT status::text AS status, count(*)::int AS n FROM jobs GROUP BY status`);
        await audit.platform(tx, {
          action: "admin.jobs_viewed",
          entityType: "job",
          after: { status: input.status ?? null },
        });
        const rows: AdminJobRow[] = (result.rows as Record<string, unknown>[])
          .slice(0, ADMIN_LIST_LIMIT)
          .map((r) => ({
            jobId: String(r.id),
            operatorId: r.operator_id === null ? null : String(r.operator_id),
            operatorName: r.operator_name === null ? null : String(r.operator_name),
            type: String(r.type),
            status: r.status as AdminJobRow["status"],
            attempts: asInt(r.attempts),
            maxAttempts: asInt(r.max_attempts),
            lastError: r.last_error === null ? null : String(r.last_error),
            createdAt: asDate(r.created_at) ?? new Date(0),
            finishedAt: asDate(r.finished_at),
            runAfter: asDate(r.run_after),
          }));
        const last = rows[rows.length - 1];
        const byStatus: Record<string, number> = {};
        for (const r of counts.rows as Record<string, unknown>[]) {
          byStatus[String(r.status)] = asInt(r.n);
        }
        return {
          rows,
          countsByStatus: byStatus,
          nextCursor:
            result.rows.length > ADMIN_LIST_LIMIT && last
              ? nextCursor(last.createdAt, last.jobId)
              : null,
        };
      }),
    );
  },
});

export const RetryJobInput = z.object({ jobId: z.uuid() });

async function liveCopy(
  tx: Tx,
  job: { operatorId: string | null; type: string; payload: unknown; dedupeKey: string | null },
): Promise<string | null> {
  const sameTenant =
    job.operatorId === null
      ? sql`${jobs.operatorId} IS NULL`
      : sql`${jobs.operatorId} = ${job.operatorId}`;
  const sameJob =
    job.dedupeKey === null
      ? sql`${jobs.payload} = ${JSON.stringify(job.payload)}::jsonb`
      : sql`${jobs.dedupeKey} = ${job.dedupeKey}`;
  const rows = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        sameTenant,
        eq(jobs.type, job.type),
        sameJob,
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

export const retryJob = defineAdminService({
  name: "admin.job_retry",
  input: RetryJobInput,
  async run({ input, runtime, audit, now }) {
    const outcome = await runtime.db.withPlatform(async (tx) => {
      const rows = await tx
        .select({
          id: jobs.id,
          operatorId: jobs.operatorId,
          type: jobs.type,
          status: jobs.status,
          payload: jobs.payload,
          dedupeKey: jobs.dedupeKey,
          maxAttempts: jobs.maxAttempts,
        })
        .from(jobs)
        .where(eq(jobs.id, input.jobId))
        .for("update")
        .limit(1);
      const job = rows[0];
      if (!job) return { kind: "not_found" as const };
      if (job.status !== "failed") return { kind: "not_failed" as const };
      const live = await liveCopy(tx, job);
      if (live) return { kind: "already_queued" as const, jobId: live };
      const newJobId = uuidv7();
      await tx.insert(jobs).values({
        id: newJobId,
        operatorId: job.operatorId,
        type: job.type,
        payload: job.payload,
        maxAttempts: job.maxAttempts,
        dedupeKey: job.dedupeKey,
        runAfter: now,
        createdAt: now,
        updatedAt: now,
      });
      await audit.platform(tx, {
        action: "admin.job_retried",
        entityType: "job",
        entityId: job.id,
        after: { new_job_id: newJobId, type: job.type, operator_id: job.operatorId },
      });
      return { kind: "queued" as const, jobId: newJobId };
    });
    if (outcome.kind === "not_found") return err(notFound());
    if (outcome.kind === "not_failed") {
      return err(
        serviceError("CONFLICT", "Only failed jobs can be retried", { reason: "not_failed" }),
      );
    }
    if (outcome.kind === "already_queued") {
      return err(
        serviceError("CONFLICT", "A copy of this job is already waiting or running", {
          reason: "already_queued",
          jobId: outcome.jobId,
        }),
      );
    }
    return ok({ newJobId: outcome.jobId });
  },
});

export interface AdminBillingRunRow extends AdminBillingRunSummary {
  readonly operatorId: string;
  readonly operatorName: string;
  /** Failed items by reason code. */
  readonly failedReasons: Readonly<Record<string, number>>;
}

export const ListBillingRunsInput = z.object({
  /** `YYYY-MM-01`. Default: every period, newest first. */
  period: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/)
    .optional(),
  status: z.enum(BILLING_RUN_STATUSES).optional(),
});

export const listBillingRuns = defineAdminService({
  name: "admin.billing_runs_list",
  input: ListBillingRunsInput,
  async run({ input, runtime, audit }) {
    return ok(
      await runtime.db.withPlatform(async (tx) => {
        const filters = [sql`true`];
        if (input.period) filters.push(sql`r.period = ${input.period}::date`);
        if (input.status) filters.push(sql`r.status = ${input.status}`);
        const runs = await tx.execute(sql`
          SELECT r.id, r.operator_id, o.name AS operator_name, r.period::text AS period,
                 r.status::text AS status, r.trigger::text AS trigger, r.customer_count,
                 r.created_count, r.already_exists_count, r.skipped_count, r.failed_count,
                 r.finished_at
            FROM billing_runs r JOIN operators o ON o.id = r.operator_id
           WHERE ${sql.join(filters, sql` AND `)}
           ORDER BY r.period DESC, r.failed_count DESC, o.name, r.id
           LIMIT ${ADMIN_LIST_LIMIT}`);
        const runRows = runs.rows as Record<string, unknown>[];
        const ids = runRows.map((r) => String(r.id));
        const reasons = ids.length
          ? await tx.execute(sql`
              SELECT run_id, coalesce(reason, 'unknown') AS reason, count(*)::int AS n
                FROM billing_run_items
               WHERE outcome = 'failed' AND run_id IN (${sql.join(
                 ids.map((id) => sql`${id}::uuid`),
                 sql`, `,
               )})
               GROUP BY run_id, reason`)
          : { rows: [] };
        const byRun = new Map<string, Record<string, number>>();
        for (const r of reasons.rows as Record<string, unknown>[]) {
          const key = String(r.run_id);
          const entry = byRun.get(key) ?? {};
          entry[String(r.reason)] = asInt(r.n);
          byRun.set(key, entry);
        }
        await audit.platform(tx, {
          action: "admin.billing_runs_viewed",
          entityType: "billing_run",
          after: { period: input.period ?? null, status: input.status ?? null },
        });
        return runRows.map(
          (r): AdminBillingRunRow => ({
            ...billingRunSummary(r),
            operatorId: String(r.operator_id),
            operatorName: String(r.operator_name),
            failedReasons: byRun.get(String(r.id)) ?? {},
          }),
        );
      }),
    );
  },
});

export interface AdminRazorpayEventRow {
  readonly eventId: string;
  readonly razorpayEventId: string;
  readonly type: string;
  readonly operatorId: string | null;
  readonly operatorName: string | null;
  readonly receivedAt: Date;
  readonly processedAt: Date | null;
  readonly processingError: string | null;
}

export const ListRazorpayEventsInput = z.object({
  /** `problems`: not processed, or with a processing error (unmatched, etc.). */
  filter: z.enum(["all", "problems"]).default("all"),
  cursor: Cursor,
});

export const listRazorpayEvents = defineAdminService({
  name: "admin.razorpay_events_list",
  input: ListRazorpayEventsInput,
  async run({ input, runtime, audit }) {
    return ok(
      await runtime.db.withPlatform(async (tx) => {
        const after = splitCursor(input.cursor);
        const filters = [sql`true`];
        if (input.filter === "problems") {
          filters.push(sql`(e.processed_at IS NULL OR e.processing_error IS NOT NULL)`);
        }
        if (after) {
          filters.push(sql`(e.received_at, e.id) < (${after.at}::timestamptz, ${after.id}::uuid)`);
        }
        const result = await tx.execute(sql`
          SELECT e.id, e.razorpay_event_id, e.type, e.operator_id, o.name AS operator_name,
                 e.received_at, e.processed_at, e.processing_error
            FROM subscription_events e LEFT JOIN operators o ON o.id = e.operator_id
           WHERE ${sql.join(filters, sql` AND `)}
           ORDER BY e.received_at DESC, e.id DESC
           LIMIT ${ADMIN_LIST_LIMIT + 1}`);
        await audit.platform(tx, {
          action: "admin.razorpay_events_viewed",
          entityType: "subscription_event",
          after: { filter: input.filter },
        });
        const rows: AdminRazorpayEventRow[] = (result.rows as Record<string, unknown>[])
          .slice(0, ADMIN_LIST_LIMIT)
          .map((r) => ({
            eventId: String(r.id),
            razorpayEventId: String(r.razorpay_event_id),
            type: String(r.type),
            operatorId: r.operator_id === null ? null : String(r.operator_id),
            operatorName: r.operator_name === null ? null : String(r.operator_name),
            receivedAt: asDate(r.received_at) ?? new Date(0),
            processedAt: asDate(r.processed_at),
            processingError: r.processing_error === null ? null : String(r.processing_error),
          }));
        const last = rows[rows.length - 1];
        return {
          rows,
          nextCursor:
            result.rows.length > ADMIN_LIST_LIMIT && last
              ? nextCursor(last.receivedAt, last.eventId)
              : null,
        };
      }),
    );
  },
});

export interface AdminAuditRow {
  readonly eventId: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly operatorName: string | null;
  readonly actorName: string | null;
  readonly actorRole: string | null;
  readonly at: Date;
  readonly after: unknown;
}

export const ListPlatformAuditInput = z.object({
  /** Hide the console's own "viewed" events. Default true. */
  hideViews: z.boolean().default(true),
  cursor: Cursor,
});

export const listPlatformAudit = defineAdminService({
  name: "admin.platform_audit_list",
  input: ListPlatformAuditInput,
  async run({ input, runtime, audit }) {
    return ok(
      await runtime.db.withPlatform(async (tx) => {
        const after = splitCursor(input.cursor);
        // RLS limits app_platform to operator_id IS NULL (platform events) anyway.
        const filters = [sql`a.operator_id IS NULL`];
        if (input.hideViews) filters.push(sql`a.action NOT LIKE 'admin.%\\_viewed'`);
        if (after) filters.push(sql`(a.at, a.id) < (${after.at}::timestamptz, ${after.id}::uuid)`);
        const result = await tx.execute(sql`
          SELECT a.id, a.action, a.entity_type, a.entity_id, a.actor_role::text AS actor_role,
                 a.at, a.after, u.name AS actor_name,
                 CASE WHEN a.entity_type = 'operator' THEN o.name END AS operator_name
            FROM audit_events a
            LEFT JOIN users u ON u.id = a.actor_id
            LEFT JOIN operators o ON o.id = a.entity_id
           WHERE ${sql.join(filters, sql` AND `)}
           ORDER BY a.at DESC, a.id DESC
           LIMIT ${ADMIN_LIST_LIMIT + 1}`);
        await audit.platform(tx, {
          action: "admin.audit_viewed",
          entityType: "audit_event",
          after: { hide_views: input.hideViews },
        });
        const rows: AdminAuditRow[] = (result.rows as Record<string, unknown>[])
          .slice(0, ADMIN_LIST_LIMIT)
          .map((r) => ({
            eventId: String(r.id),
            action: String(r.action),
            entityType: String(r.entity_type),
            entityId: r.entity_id === null ? null : String(r.entity_id),
            operatorName: r.operator_name === null ? null : String(r.operator_name),
            actorName: r.actor_name === null ? null : String(r.actor_name),
            actorRole: r.actor_role === null ? null : String(r.actor_role),
            at: asDate(r.at) ?? new Date(0),
            after: r.after ?? null,
          }));
        const last = rows[rows.length - 1];
        return {
          rows,
          nextCursor:
            result.rows.length > ADMIN_LIST_LIMIT && last
              ? nextCursor(last.at, last.eventId)
              : null,
        };
      }),
    );
  },
});
