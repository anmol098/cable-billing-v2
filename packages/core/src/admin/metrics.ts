/**
 * PRD §16 product and operational metrics, across all tenants (T-086). Aggregates only, read on
 * the platform path through the column grants of `PLATFORM_READ_COLUMNS` (counts, statuses,
 * reasons, times): no tenant row, name or amount leaves this function, and the database would
 * refuse them anyway. One platform audit event per read (`admin.metrics_viewed`).
 *
 * | PRD §16 metric | Here |
 * |---|---|
 * | Billing success rate | billed (created + already existed) ÷ (billed + failed) items of the month's runs |
 * | Billing exception rate | failed ÷ looked-at items, and failed items by reason |
 * | Payment sync success rate | phone payments accepted ÷ payment ids with a final answer (accepted or rejected), deduplicated by payment id, last 30 IST days (`payment_sync_batches`, T-086a) |
 * | Duplicate prevention count | idempotent replays answered `duplicate`, last 30 IST days (`payment_sync_batches`) |
 * | Receipt action usage | print / WhatsApp / SMS launches in the last 30 days (`receipt_actions`) |
 * | Reconciliation discrepancy rate | accepted handovers with a discrepancy reason ÷ accepted, last 30 days |
 * | Migration exception count | **not measured yet**: the migration (T-092) has not run |
 * | Active operator / field usage | tenants and people with sign-in activity in the last 7 days |
 */
import {
  BILLING_RUN_STATUSES,
  type PaymentSyncRejectCode,
  type PaymentSyncRetryCode,
  RECEIPT_ACTIONS,
} from "@cb/db";
import { addDays, businessDateOf, ok, periodOfInstant } from "@cb/domain";
import { sql } from "drizzle-orm";
import * as z from "zod";
import { asInt, percent } from "./rows";
import { defineAdminService } from "./service";

export const METRICS_ACTIVE_DAYS = 7;
export const METRICS_WINDOW_DAYS = 30;

export interface PlatformMetrics {
  /** The billing month the billing figures are for (`YYYY-MM-01`). */
  readonly period: string;
  readonly tenants: {
    readonly total: number;
    readonly bySubscription: Readonly<Record<string, number>>;
    /** Tenants with any web or app sign-in activity in the last 7 days. */
    readonly activeLast7Days: number;
  };
  readonly people: {
    readonly activeWebUsersLast7Days: number;
    readonly activeLinemenLast7Days: number;
  };
  readonly billing: {
    readonly runsByStatus: Readonly<Record<string, number>>;
    readonly billed: number;
    readonly failed: number;
    readonly nothingToBill: number;
    /** Percent, one decimal; null with nothing to measure. */
    readonly successRate: number | null;
    readonly exceptionRate: number | null;
    readonly failedByReason: Readonly<Record<string, number>>;
  };
  readonly receiptActionsLast30Days: Readonly<Record<string, number>>;
  /**
   * PRD §16 payment sync (T-086a), `/payments:batch` answers of the last 30 IST days. Deduplicated
   * by payment id: `attempts` = distinct payment ids with a final answer (accepted, or rejected
   * for the first time, an id accepted after an earlier refusal counted once); `retryLater` items
   * (nothing decided yet, the phone sends them again) are not in the rate.
   */
  readonly paymentSync: {
    readonly batches: number;
    /** Items in those batches (every answer, replays included). */
    readonly items: number;
    readonly attempts: number;
    /** Accepted payment ids (`posted` + `posted_needs_review`). */
    readonly accepted: number;
    readonly acceptedNeedsReview: number;
    /** Rejected payment ids (first refusal of each id). */
    readonly rejected: number;
    /** Percent, one decimal: accepted ÷ attempts; null with nothing to measure. */
    readonly successRate: number | null;
    /** Idempotent replays answered `duplicate` (PRD §16 duplicate prevention count). */
    readonly duplicatesPrevented: number;
    /** Every `rejected` answer by code (replays included), and those without a payment id. */
    readonly rejectedAnswersByCode: Readonly<Record<PaymentSyncRejectCode, number>>;
    readonly rejectedWithoutId: number;
    /** `retry_later` answers by code (temporary: the phone sends them again). */
    readonly retryLaterByCode: Readonly<Record<PaymentSyncRetryCode, number>>;
  };
  readonly reconciliation: {
    readonly acceptedLast30Days: number;
    readonly withDiscrepancy: number;
    readonly discrepancyRate: number | null;
  };
  readonly books: {
    /** Tenants whose latest nightly check found a breach (T-052). */
    readonly tenantsWithBreach: number;
    readonly tenantsChecked: number;
  };
  readonly jobs: {
    readonly failedLast7Days: number;
    readonly waiting: number;
  };
  /** PRD §16 metrics with no data source yet (shown as "not measured"). */
  readonly notMeasured: readonly "migration_exceptions"[];
}

export const PlatformMetricsInput = z.object({
  period: z
    .string()
    .regex(/^\d{4}-\d{2}-01$/)
    .optional(),
});

export const platformMetrics = defineAdminService({
  name: "admin.metrics",
  input: PlatformMetricsInput,
  async run({ input, runtime, audit, now }) {
    const period = input.period ?? periodOfInstant(now);
    const activeSince = new Date(now.getTime() - METRICS_ACTIVE_DAYS * 86_400_000);
    const windowSince = new Date(now.getTime() - METRICS_WINDOW_DAYS * 86_400_000);
    const windowFromDay = addDays(businessDateOf(now), -METRICS_WINDOW_DAYS);
    const failedSince = activeSince;
    const metrics = await runtime.db.withPlatform(async (tx) => {
      const rows = async (query: ReturnType<typeof sql>) =>
        (await tx.execute(query)).rows as Record<string, unknown>[];

      const subs = await rows(sql`
        SELECT coalesce(s.status::text, 'none') AS k, count(*)::int AS n
          FROM operators o LEFT JOIN subscriptions s ON s.operator_id = o.id GROUP BY 1`);
      const activeWeb = await rows(sql`
        SELECT count(DISTINCT u.id)::int AS people, count(DISTINCT u.operator_id)::int AS tenants
          FROM sessions se JOIN users u ON u.id = se.user_id
         WHERE u.operator_id IS NOT NULL AND se.updated_at >= ${activeSince.toISOString()}::timestamptz`);
      const activeApp = await rows(sql`
        SELECT count(DISTINCT m.user_id)::int AS people FROM mobile_refresh_tokens m
         WHERE m.created_at >= ${activeSince.toISOString()}::timestamptz`);
      const activeTenants = await rows(sql`
        SELECT count(*)::int AS n FROM (
          SELECT u.operator_id FROM sessions se JOIN users u ON u.id = se.user_id
           WHERE u.operator_id IS NOT NULL AND se.updated_at >= ${activeSince.toISOString()}::timestamptz
          UNION
          SELECT m.operator_id FROM mobile_refresh_tokens m
           WHERE m.created_at >= ${activeSince.toISOString()}::timestamptz) t`);
      const runs = await rows(sql`
        SELECT status::text AS k, count(*)::int AS n,
               coalesce(sum(created_count + already_exists_count), 0)::int AS billed,
               coalesce(sum(failed_count), 0)::int AS failed,
               coalesce(sum(skipped_count), 0)::int AS skipped
          FROM billing_runs WHERE period = ${period}::date GROUP BY status`);
      const reasons = await rows(sql`
        SELECT coalesce(i.reason, 'unknown') AS k, count(*)::int AS n
          FROM billing_run_items i
          JOIN billing_runs r ON r.operator_id = i.operator_id AND r.id = i.run_id
         WHERE r.period = ${period}::date AND i.outcome = 'failed' GROUP BY 1`);
      const receipts = await rows(sql`
        SELECT action::text AS k, count(*)::int AS n FROM receipt_actions
         WHERE at >= ${windowSince.toISOString()}::timestamptz GROUP BY 1`);
      const sync = await rows(sql`
        SELECT count(*)::int AS batches,
               coalesce(sum(items), 0)::int AS items,
               coalesce(sum(posted), 0)::int AS posted,
               coalesce(sum(posted_needs_review), 0)::int AS posted_needs_review,
               coalesce(sum(duplicate), 0)::int AS duplicate,
               coalesce(sum(rejected_validation), 0)::int AS rejected_validation,
               coalesce(sum(rejected_customer_not_found), 0)::int AS rejected_customer_not_found,
               coalesce(sum(rejected_id_reused), 0)::int AS rejected_id_reused,
               coalesce(sum(rejected_without_id), 0)::int AS rejected_without_id,
               coalesce(sum(rejected_new_ids), 0)::int AS rejected_new_ids,
               coalesce((SELECT sum(d.value::int) FROM payment_sync_batches b2,
                                 jsonb_each_text(b2.accepted_after_rejection_by_day) d
                          WHERE b2.business_date >= ${windowFromDay}::date
                            AND d.key >= ${windowFromDay}), 0)::int
                 AS accepted_after_rejection_in_window,
               coalesce(sum(retry_later_conflict), 0)::int AS retry_later_conflict,
               coalesce(sum(retry_later_internal), 0)::int AS retry_later_internal,
               coalesce(sum(retry_later_rate_limited), 0)::int AS retry_later_rate_limited
          FROM payment_sync_batches WHERE business_date >= ${windowFromDay}::date`);
      const handovers = await rows(sql`
        SELECT count(*)::int AS accepted,
               count(*) FILTER (WHERE discrepancy_reason IS NOT NULL)::int AS discrepant
          FROM collection_sessions
         WHERE status = 'accepted' AND business_date >= ${windowFromDay}::date`);
      const books = await rows(sql`
        SELECT count(*)::int AS checked,
               count(*) FILTER (WHERE status = 'breach')::int AS breach
          FROM (SELECT DISTINCT ON (operator_id) operator_id, status
                  FROM invariant_checks ORDER BY operator_id, checked_at DESC, id DESC) latest`);
      const jobRows = await rows(sql`
        SELECT count(*) FILTER (WHERE status = 'failed'
                                  AND finished_at >= ${failedSince.toISOString()}::timestamptz)::int AS failed,
               count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS waiting
          FROM jobs`);
      await audit.platform(tx, {
        action: "admin.metrics_viewed",
        entityType: "platform",
        after: { period },
      });

      const bySubscription: Record<string, number> = {};
      let total = 0;
      for (const r of subs) {
        bySubscription[String(r.k)] = asInt(r.n);
        total += asInt(r.n);
      }
      const runsByStatus: Record<string, number> = Object.fromEntries(
        BILLING_RUN_STATUSES.map((s) => [s, 0]),
      );
      let billed = 0;
      let failed = 0;
      let nothingToBill = 0;
      for (const r of runs) {
        runsByStatus[String(r.k)] = asInt(r.n);
        billed += asInt(r.billed);
        failed += asInt(r.failed);
        nothingToBill += asInt(r.skipped);
      }
      const failedByReason: Record<string, number> = {};
      for (const r of reasons) failedByReason[String(r.k)] = asInt(r.n);
      const receiptActionsLast30Days: Record<string, number> = Object.fromEntries(
        RECEIPT_ACTIONS.map((a) => [a, 0]),
      );
      for (const r of receipts) receiptActionsLast30Days[String(r.k)] = asInt(r.n);
      const s0 = sync[0] ?? {};
      const syncAccepted = asInt(s0.posted) + asInt(s0.posted_needs_review);
      const syncRejected = asInt(s0.rejected_new_ids);
      // Subtract only the accepted ids whose earlier refusal is inside the window (a refusal before
      // it is not in `rejected_new_ids` here either); never fewer attempts than accepted ids.
      const syncAttempts = Math.max(
        syncAccepted,
        syncAccepted + syncRejected - asInt(s0.accepted_after_rejection_in_window),
      );
      const rejectedAnswersByCode: Record<PaymentSyncRejectCode, number> = {
        VALIDATION: asInt(s0.rejected_validation),
        CUSTOMER_NOT_FOUND: asInt(s0.rejected_customer_not_found),
        ID_REUSED_WITH_DIFFERENT_DATA: asInt(s0.rejected_id_reused),
      };
      const retryLaterByCode: Record<PaymentSyncRetryCode, number> = {
        CONFLICT: asInt(s0.retry_later_conflict),
        INTERNAL: asInt(s0.retry_later_internal),
        RATE_LIMITED: asInt(s0.retry_later_rate_limited),
      };
      const accepted = asInt(handovers[0]?.accepted);
      const discrepant = asInt(handovers[0]?.discrepant);
      const result: PlatformMetrics = {
        period,
        tenants: {
          total,
          bySubscription,
          activeLast7Days: asInt(activeTenants[0]?.n),
        },
        people: {
          activeWebUsersLast7Days: asInt(activeWeb[0]?.people),
          activeLinemenLast7Days: asInt(activeApp[0]?.people),
        },
        billing: {
          runsByStatus,
          billed,
          failed,
          nothingToBill,
          successRate: percent(billed, billed + failed),
          exceptionRate: percent(failed, billed + failed + nothingToBill),
          failedByReason,
        },
        receiptActionsLast30Days,
        paymentSync: {
          batches: asInt(s0.batches),
          items: asInt(s0.items),
          attempts: syncAttempts,
          accepted: syncAccepted,
          acceptedNeedsReview: asInt(s0.posted_needs_review),
          rejected: syncRejected,
          successRate: percent(syncAccepted, syncAttempts),
          duplicatesPrevented: asInt(s0.duplicate),
          rejectedAnswersByCode,
          rejectedWithoutId: asInt(s0.rejected_without_id),
          retryLaterByCode,
        },
        reconciliation: {
          acceptedLast30Days: accepted,
          withDiscrepancy: discrepant,
          discrepancyRate: percent(discrepant, accepted),
        },
        books: {
          tenantsChecked: asInt(books[0]?.checked),
          tenantsWithBreach: asInt(books[0]?.breach),
        },
        jobs: {
          failedLast7Days: asInt(jobRows[0]?.failed),
          waiting: asInt(jobRows[0]?.waiting),
        },
        notMeasured: ["migration_exceptions"],
      };
      return result;
    });
    return ok(metrics);
  },
});
