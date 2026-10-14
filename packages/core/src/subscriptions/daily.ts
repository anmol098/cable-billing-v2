/**
 * The daily `subscription-states` cron (PLAN §14, `30 0 * * *` = 06:00 IST): for every active
 * operator,
 *
 * 1. **reconciles** with Razorpay when something can still change (`needsReconcile`: a
 *    subscription that isn't finished and isn't safely mid-month), in case a webhook was missed;
 * 2. applies the **date-based transitions** (trialing → grace → read_only, active → grace or
 *    cancelled) through the same state machine as the webhook;
 * 3. sends the **reminder** that is due (T-7, T-1, grace start, grace T-7/T-1), at most one per
 *    tenant per run and each only once (`notices.ts`), and the "working again" email when a
 *    reconciliation ended read-only mode (with the missed bill runs, D-25).
 *
 * Idempotent: a second run the same day changes nothing and sends nothing. One tenant's failure is
 * logged and the others continue; database failures make the run throw at the end
 * ({@link SubscriptionStatesError}, so the cron answers 500 and Sentry hears about it). A Razorpay
 * outage only skips the reconciliation (dates still apply) and is counted.
 */
import { type DbClient, operators, subscriptions } from "@cb/db";
import { eq } from "drizzle-orm";
import { errorLogFields, type Logger } from "../logging/logger";
import { noticeAlreadySent, type SubscriptionNotifier, sendSubscriptionNotice } from "./notices";
import type { RazorpayClient } from "./razorpay/client";
import { snapshotOf } from "./razorpay/payload";
import { needsReconcile } from "./reconcile";
import {
  dueNotice,
  reactivatedNotice,
  type SubscriptionChange,
  type SubscriptionNotice,
  type SubscriptionState,
} from "./state";
import { applySubscriptionChange } from "./store";

export interface SubscriptionStatesOptions {
  readonly db: Pick<DbClient, "withTenant" | "withPlatform">;
  /** Business clock (injected in tests). */
  readonly now: () => Date;
  readonly log: Logger;
  readonly requestId?: string | null;
  /** `null` when Razorpay is not configured: dates still apply, nothing is reconciled. */
  readonly razorpay: RazorpayClient | null;
  /** `null`: no emails (logged). */
  readonly notifier: SubscriptionNotifier | null;
  /** Parallel tenants (Razorpay calls). Default 4. */
  readonly concurrency?: number;
  /** Stop starting new tenants after this long. Default 240 s (route `maxDuration` 300 s). */
  readonly budgetMs?: number;
  /** Elapsed-time clock for the budget (ms). Default `Date.now`. */
  readonly elapsed?: () => number;
}

export interface SubscriptionStatesReport {
  readonly tenants: number;
  readonly processed: number;
  readonly changed: number;
  readonly transitions: Readonly<Record<string, number>>;
  readonly reconciled: number;
  readonly reconcileErrors: number;
  readonly reactivated: number;
  readonly noticesSent: number;
  readonly noticeFailures: number;
  readonly failed: number;
  readonly stoppedBy: "done" | "budget";
}

/** At least one tenant failed for a reason other than Razorpay; the report is attached. */
export class SubscriptionStatesError extends Error {
  readonly report: SubscriptionStatesReport;
  constructor(report: SubscriptionStatesReport) {
    super(`subscription-states: ${report.failed} tenant(s) failed`);
    this.name = "SubscriptionStatesError";
    this.report = report;
  }
}

type Row = SubscriptionState & { operatorId: string };

function nextDeadline(row: Row): number {
  const candidates = [row.trialEndsAt, row.currentPeriodEnd, row.graceEndsAt]
    .filter((d): d is Date => d !== null)
    .map((d) => d.getTime());
  return candidates.length > 0 ? Math.min(...candidates) : Number.MAX_SAFE_INTEGER;
}

export async function runSubscriptionStates(
  options: SubscriptionStatesOptions,
): Promise<SubscriptionStatesReport> {
  const elapsed = options.elapsed ?? Date.now;
  const started = elapsed();
  const budgetMs = options.budgetMs ?? 240_000;
  const log = options.log;
  if (!options.razorpay) log.warn("subscription_states.razorpay_not_configured", {});
  if (!options.notifier) log.warn("subscription_states.email_not_configured", {});

  const rows: Row[] = await options.db.withPlatform(
    (tx) =>
      tx
        .select({
          operatorId: subscriptions.operatorId,
          status: subscriptions.status,
          trialEndsAt: subscriptions.trialEndsAt,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          graceEndsAt: subscriptions.graceEndsAt,
          cancelledAt: subscriptions.cancelledAt,
          razorpaySubscriptionId: subscriptions.razorpaySubscriptionId,
          razorpayStatus: subscriptions.razorpayStatus,
          razorpayStatusAt: subscriptions.razorpayStatusAt,
        })
        .from(subscriptions)
        .innerJoin(operators, eq(operators.id, subscriptions.operatorId))
        .where(eq(operators.status, "active")),
    { accessMode: "read only" },
  );
  // Nearest deadline first, so a short budget still handles the tenants that change today.
  rows.sort(
    (a, b) => nextDeadline(a) - nextDeadline(b) || a.operatorId.localeCompare(b.operatorId),
  );

  const transitions: Record<string, number> = {};
  const counts = {
    processed: 0,
    changed: 0,
    reconciled: 0,
    reconcileErrors: 0,
    reactivated: 0,
    noticesSent: 0,
    noticeFailures: 0,
    failed: 0,
  };
  let stoppedBy = "done" as "done" | "budget";
  let next = 0;

  async function processTenant(row: Row): Promise<void> {
    const tenantLog = log.child({ operator_id: row.operatorId });
    let change: SubscriptionChange = { kind: "clock" };
    if (options.razorpay && row.razorpaySubscriptionId && needsReconcile(row, options.now())) {
      try {
        const entity = await options.razorpay.fetchSubscription(row.razorpaySubscriptionId);
        change = { kind: "razorpay", snapshot: snapshotOf(entity, options.now()) };
        counts.reconciled += 1;
      } catch (error) {
        counts.reconcileErrors += 1;
        tenantLog.warn("subscription_states.reconcile_failed", errorLogFields(error));
      }
    }

    const outcome = await options.db.withTenant(row.operatorId, async (tx) => {
      const now = options.now();
      const applied = await applySubscriptionChange(tx, {
        operatorId: row.operatorId,
        change,
        now,
        actor: { kind: "system" },
        source: change.kind === "razorpay" ? "reconcile" : "cron",
        requestId: options.requestId ?? null,
      });
      if (!applied.step) return null;
      const state = applied.step.state;
      let notice: SubscriptionNotice | null = null;
      if (applied.step.reactivated) {
        notice = reactivatedNotice(state, now);
      } else {
        const due = dueNotice(state, now);
        if (due && !(await noticeAlreadySent(tx, row.operatorId, due.key))) notice = due;
      }
      return { applied, notice };
    });
    counts.processed += 1;
    if (!outcome) {
      tenantLog.error("subscription_states.no_row", {});
      return;
    }
    const { applied, notice } = outcome;
    if (applied.changed) counts.changed += 1;
    for (const t of applied.step?.transitions ?? []) {
      const key = `${t.from}->${t.to}`;
      transitions[key] = (transitions[key] ?? 0) + 1;
    }
    if (applied.step?.reactivated) counts.reactivated += 1;
    if (applied.step && applied.step.transitions.length > 0) {
      tenantLog.info("subscription_states.transition", {
        transitions: applied.step.transitions.map((t) => `${t.from}->${t.to}`).join(","),
        source: change.kind === "razorpay" ? "reconcile" : "cron",
      });
    }
    if (notice && options.notifier) {
      const sent = await sendSubscriptionNotice({
        db: options.db,
        operatorId: row.operatorId,
        notice,
        missedRunPeriods: applied.missedRunPeriods,
        notifier: options.notifier,
        log,
        requestId: options.requestId ?? null,
      });
      counts.noticesSent += sent.sent;
      counts.noticeFailures += sent.failed;
    } else if (notice) {
      tenantLog.info("subscription_states.notice_not_sent", { notice_kind: notice.kind });
    }
  }

  async function worker(): Promise<void> {
    while (next < rows.length) {
      if (elapsed() - started >= budgetMs) {
        stoppedBy = "budget";
        return;
      }
      const row = rows[next];
      next += 1;
      if (!row) return;
      try {
        await processTenant(row);
      } catch (error) {
        counts.failed += 1;
        log.error("subscription_states.tenant_failed", {
          operator_id: row.operatorId,
          ...errorLogFields(error),
        });
      }
    }
  }

  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 16));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const report: SubscriptionStatesReport = {
    tenants: rows.length,
    ...counts,
    transitions,
    stoppedBy,
  };
  if (stoppedBy === "budget") {
    log.warn("subscription_states.budget_exhausted", { left: rows.length - counts.processed });
  }
  log.info("subscription_states.finished", {
    tenants: report.tenants,
    processed: report.processed,
    changed: report.changed,
    reconciled: report.reconciled,
    reconcile_errors: report.reconcileErrors,
    notices_sent: report.noticesSent,
    failed: report.failed,
  });
  if (report.failed > 0) throw new SubscriptionStatesError(report);
  return report;
}
