/**
 * Reconciliation with Razorpay's API (PLAN §13: "a daily cron reconciles state with the Razorpay
 * API in case a webhook was missed"; also used right after checkout). Reads the tenant's current
 * Razorpay subscription **outside** any transaction, then applies what Razorpay says through the
 * same state machine as a webhook (older reports never overwrite newer ones).
 */
import type { DbClient } from "@cb/db";
import type { RazorpayClient } from "./razorpay/client";
import { snapshotOf } from "./razorpay/payload";
import type { SubscriptionState } from "./state";
import {
  type ApplyChangeResult,
  applySubscriptionChange,
  readSubscription,
  type SubscriptionActor,
} from "./store";

/** Razorpay statuses that never change again: nothing to reconcile. */
const FINAL: readonly string[] = ["cancelled", "completed", "expired"];

/** Within this long of the paid month's end, an active tenant is checked every day. */
const RENEWAL_WINDOW_MS = 36 * 60 * 60 * 1000;

/**
 * Whether the daily cron should ask Razorpay about this tenant. Only when something can still
 * change: a subscription exists, Razorpay hasn't said it is over, and the tenant is not safely in
 * the middle of a paid month. Keeps the calls to roughly "tenants around their renewal day".
 */
export function needsReconcile(state: SubscriptionState, now: Date): boolean {
  if (!state.razorpaySubscriptionId) return false;
  if (state.razorpayStatus && FINAL.includes(state.razorpayStatus)) return false;
  if (state.status !== "active") return true;
  if (!state.currentPeriodEnd) return true;
  return state.currentPeriodEnd.getTime() - now.getTime() <= RENEWAL_WINDOW_MS;
}

export interface ReconcileOptions {
  readonly db: Pick<DbClient, "withTenant">;
  readonly razorpay: RazorpayClient;
  readonly operatorId: string;
  readonly now: () => Date;
  readonly actor: SubscriptionActor;
  readonly source: string;
  readonly requestId?: string | null;
}

export type ReconcileResult =
  | { readonly kind: "no_subscription" }
  | { readonly kind: "applied"; readonly result: ApplyChangeResult };

/** Reads the tenant's Razorpay subscription and applies it. Razorpay errors are thrown. */
export async function reconcileWithRazorpay(options: ReconcileOptions): Promise<ReconcileResult> {
  const current = await options.db.withTenant(options.operatorId, (tx) => readSubscription(tx), {
    accessMode: "read only",
  });
  const subscriptionId = current?.razorpaySubscriptionId;
  if (!subscriptionId) return { kind: "no_subscription" };
  const entity = await options.razorpay.fetchSubscription(subscriptionId);
  const seenAt = options.now();
  const result = await options.db.withTenant(options.operatorId, (tx) =>
    applySubscriptionChange(tx, {
      operatorId: options.operatorId,
      change: { kind: "razorpay", snapshot: snapshotOf(entity, seenAt) },
      now: options.now(),
      actor: options.actor,
      source: options.source,
      requestId: options.requestId ?? null,
    }),
  );
  return { kind: "applied", result };
}
