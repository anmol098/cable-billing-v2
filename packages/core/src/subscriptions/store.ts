/**
 * Reading and writing a tenant's `subscriptions` row inside a `withTenant` transaction (RLS limits
 * the table to that tenant's one row). Every state change goes through
 * {@link applySubscriptionChange}: lock the row, run the pure state machine, write the row and one
 * audit event when something changed. Webhooks, the daily cron, checkout and (later) the admin
 * console all use it, so they can't disagree.
 */
import { billingRuns, subscriptions, type Tx, type UserRole } from "@cb/db";
import { and, asc, eq } from "drizzle-orm";
import { writeAuditEvent } from "../audit/audit";
import {
  nextSubscriptionState,
  type SubscriptionChange,
  type SubscriptionState,
  type SubscriptionStep,
  sameSubscriptionState,
} from "./state";

export interface StoredSubscription extends SubscriptionState {
  readonly operatorId: string;
  readonly planCode: string | null;
}

const COLUMNS = {
  operatorId: subscriptions.operatorId,
  status: subscriptions.status,
  trialEndsAt: subscriptions.trialEndsAt,
  currentPeriodEnd: subscriptions.currentPeriodEnd,
  graceEndsAt: subscriptions.graceEndsAt,
  cancelledAt: subscriptions.cancelledAt,
  razorpaySubscriptionId: subscriptions.razorpaySubscriptionId,
  razorpayStatus: subscriptions.razorpayStatus,
  razorpayStatusAt: subscriptions.razorpayStatusAt,
  planCode: subscriptions.planCode,
} as const;

/** The tenant's row (no lock), or null when it has none. */
export async function readSubscription(tx: Tx): Promise<StoredSubscription | null> {
  const rows = await tx.select(COLUMNS).from(subscriptions).limit(1);
  return rows[0] ?? null;
}

/** The tenant's row, locked until the transaction ends (state changes are serialised). */
export async function lockSubscription(tx: Tx): Promise<StoredSubscription | null> {
  const rows = await tx.select(COLUMNS).from(subscriptions).limit(1).for("update");
  return rows[0] ?? null;
}

/** Who caused a change, for the audit event (system = webhook, cron, reconciliation). */
export type SubscriptionActor =
  | { readonly kind: "system" }
  | { readonly kind: "user"; readonly userId: string; readonly role: UserRole };

export interface ApplyChangeOptions {
  readonly operatorId: string;
  readonly change: SubscriptionChange;
  readonly now: Date;
  readonly actor: SubscriptionActor;
  /** What caused it, e.g. `webhook:subscription.charged`, `cron`, `reconcile`, `checkout`. */
  readonly source: string;
  readonly requestId?: string | null;
  /** Stored with checkout_created. */
  readonly planCode?: string;
  /**
   * Writes the audit event instead of `writeAuditEvent` (a service passes its `audit.record`, so
   * the event carries the request's actor, IP and request id and counts for `defineService`).
   */
  readonly recordAudit?: (event: SubscriptionAuditEvent) => Promise<void>;
}

export interface SubscriptionAuditEvent {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before: unknown;
  readonly after: unknown;
}

export interface ApplyChangeResult {
  /** False when the tenant has no subscription row (nothing done). */
  readonly found: boolean;
  readonly before: StoredSubscription | null;
  readonly step: SubscriptionStep | null;
  readonly changed: boolean;
  /** Skipped billing months to show after a reactivation (D-25), oldest first. */
  readonly missedRunPeriods: readonly string[];
}

function auditView(state: SubscriptionState) {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    status: state.status,
    trial_ends_at: iso(state.trialEndsAt),
    current_period_end: iso(state.currentPeriodEnd),
    grace_ends_at: iso(state.graceEndsAt),
    cancelled_at: iso(state.cancelledAt),
    razorpay_subscription_id: state.razorpaySubscriptionId,
    razorpay_status: state.razorpayStatus,
  };
}

/** The tenant's skipped billing runs (D-25: never billed automatically), oldest first. */
export async function missedRunPeriods(tx: Tx, operatorId: string): Promise<string[]> {
  const rows = await tx
    .select({ period: billingRuns.period })
    .from(billingRuns)
    .where(and(eq(billingRuns.operatorId, operatorId), eq(billingRuns.status, "skipped")))
    .orderBy(asc(billingRuns.period));
  return rows.map((row) => row.period);
}

/**
 * Applies `change` to the tenant's subscription inside `tx` (a `withTenant(operatorId)`
 * transaction): lock, compute, write, audit (`subscription.state_changed`, only when the row
 * changes). Idempotent: applying the same change twice changes nothing the second time.
 */
export async function applySubscriptionChange(
  tx: Tx,
  options: ApplyChangeOptions,
): Promise<ApplyChangeResult> {
  const before = await lockSubscription(tx);
  if (!before) {
    return { found: false, before: null, step: null, changed: false, missedRunPeriods: [] };
  }
  const step = nextSubscriptionState(before, options.change, options.now);
  const after = step.state;
  const planChanged =
    options.change.kind === "checkout_created" &&
    options.planCode !== undefined &&
    options.planCode !== before.planCode;
  const changed = planChanged || !sameSubscriptionState(before, after);
  if (changed) {
    await tx
      .update(subscriptions)
      .set({
        status: after.status,
        trialEndsAt: after.trialEndsAt,
        currentPeriodEnd: after.currentPeriodEnd,
        graceEndsAt: after.graceEndsAt,
        cancelledAt: after.cancelledAt,
        razorpaySubscriptionId: after.razorpaySubscriptionId,
        razorpayStatus: after.razorpayStatus,
        razorpayStatusAt: after.razorpayStatusAt,
        ...(planChanged ? { planCode: options.planCode } : {}),
        updatedAt: options.now,
      })
      .where(eq(subscriptions.operatorId, options.operatorId));
    const event: SubscriptionAuditEvent = {
      action: "subscription.state_changed",
      entityType: "subscription",
      entityId: options.operatorId,
      before: auditView(before),
      after: {
        ...auditView(after),
        source: options.source,
        transitions: step.transitions.map((t) => `${t.from}->${t.to}`),
      },
    };
    if (options.recordAudit) {
      await options.recordAudit(event);
    } else {
      await writeAuditEvent(tx, {
        ...event,
        operatorId: options.operatorId,
        actorId: options.actor.kind === "user" ? options.actor.userId : null,
        actorRole: options.actor.kind === "user" ? options.actor.role : null,
        requestId: options.requestId ?? null,
      });
    }
  }
  const missed = step.reactivated ? await missedRunPeriods(tx, options.operatorId) : [];
  return { found: true, before, step, changed, missedRunPeriods: missed };
}
