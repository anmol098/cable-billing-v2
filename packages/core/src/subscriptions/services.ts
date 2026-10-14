/**
 * Owner-facing subscription services (capability `subscription.manage`: Owner only, allowed in
 * read-only mode because paying is how a tenant leaves it, PLAN §9.4 / T-025 allowlist).
 *
 * - `subscriptions.overview`: the subscription page's data (state, plan amounts, autopay, missed
 *   bill runs after a reactivation). Reads only; audit skipped (`no_change`).
 * - `subscriptions.record_checkout`: remembers the Razorpay subscription the Owner is about to
 *   authorise (called by `startSubscriptionCheckout` after Razorpay created it). Audited.
 *
 * Talking to Razorpay happens outside these services' transactions (`checkout.ts`): a network
 * call never holds the subscription row lock.
 */
import type { SubscriptionStatus } from "@cb/db";
import { type BusinessDate, ok } from "@cb/domain";
import { z } from "zod";
import { type TenantMode, tenantModeOf } from "../authz/writable";
import { defineService } from "../context/service";
import { CURRENT_PLAN, planFor, SUBSCRIPTION_PLANS } from "./plan";
import {
  AUTOPAY_ON_STATUSES,
  lastDayBefore,
  type RazorpaySubscriptionStatus,
  type SubscriptionState,
} from "./state";
import { applySubscriptionChange, missedRunPeriods, readSubscription } from "./store";

/** Autopay as the Owner sees it. */
export type AutopayState =
  /** Razorpay will charge every month (mandate authorised). */
  | "on"
  /** Checkout opened but not finished (the Owner can try again). */
  | "not_finished"
  /** A payment failed; Razorpay is retrying or gave up. */
  | "failing"
  /** No autopay (never set up, cancelled or finished). */
  | "off";

export function autopayOf(status: RazorpaySubscriptionStatus | null): AutopayState {
  if (status === null) return "off";
  if (AUTOPAY_ON_STATUSES.includes(status)) return "on";
  if (status === "created") return "not_finished";
  if (status === "pending" || status === "halted") return "failing";
  return "off";
}

export interface SubscriptionPlanView {
  readonly code: string;
  readonly pricePaise: number;
  readonly gstPercent: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
}

export interface SubscriptionView {
  readonly operatorId: string;
  /** `null`: the tenant has no subscription row (read-only, fail closed). */
  readonly status: SubscriptionStatus | null;
  readonly mode: TenantMode;
  readonly trialEndsAt: Date | null;
  readonly currentPeriodEnd: Date | null;
  readonly graceEndsAt: Date | null;
  readonly cancelledAt: Date | null;
  /**
   * The last IST day of the current access: trial (trialing), paid month (active), grace (grace).
   * `null` in read-only states.
   */
  readonly accessLastDay: BusinessDate | null;
  readonly autopay: AutopayState;
  /** Razorpay's status of the current subscription, if any. */
  readonly razorpayStatus: RazorpaySubscriptionStatus | null;
  readonly plan: SubscriptionPlanView;
  /** Skipped billing months waiting for the Owner (D-25), oldest first (`YYYY-MM-01`). */
  readonly missedRunPeriods: readonly string[];
  /** Show "Pay": there is no working autopay yet. */
  readonly canPay: boolean;
}

function planView(code: string | null): SubscriptionPlanView {
  const plan = planFor(code);
  return {
    code: plan.code,
    pricePaise: plan.pricePaise,
    gstPercent: plan.gstPercent,
    gstPaise: plan.gstPaise,
    totalPaise: plan.totalPaise,
  };
}

function accessEnd(state: SubscriptionState): Date | null {
  switch (state.status) {
    case "trialing":
      return state.trialEndsAt;
    case "active":
      return state.currentPeriodEnd;
    case "grace":
      return state.graceEndsAt;
    default:
      return null;
  }
}

export function subscriptionViewOf(
  operatorId: string,
  row: (SubscriptionState & { planCode: string | null }) | null,
  missed: readonly string[],
): SubscriptionView {
  if (!row) {
    return {
      operatorId,
      status: null,
      mode: tenantModeOf(null),
      trialEndsAt: null,
      currentPeriodEnd: null,
      graceEndsAt: null,
      cancelledAt: null,
      accessLastDay: null,
      autopay: "off",
      razorpayStatus: null,
      plan: planView(null),
      missedRunPeriods: missed,
      canPay: false,
    };
  }
  const end = accessEnd(row);
  const autopay = autopayOf(row.razorpaySubscriptionId ? row.razorpayStatus : null);
  return {
    operatorId,
    status: row.status,
    mode: tenantModeOf(row.status),
    trialEndsAt: row.trialEndsAt,
    currentPeriodEnd: row.currentPeriodEnd,
    graceEndsAt: row.graceEndsAt,
    cancelledAt: row.cancelledAt,
    accessLastDay: end ? lastDayBefore(end) : null,
    autopay,
    razorpayStatus: row.razorpaySubscriptionId ? row.razorpayStatus : null,
    plan: planView(row.planCode),
    missedRunPeriods: missed,
    canPay: autopay !== "on",
  };
}

export const SubscriptionOverviewInput = z.object({}).strict();

export const subscriptionOverview = defineService({
  name: "subscriptions.overview",
  capability: "subscription.manage",
  input: SubscriptionOverviewInput,
  async run({ ctx, tx, audit }) {
    audit.skip("no_change");
    const row = await readSubscription(tx);
    const missed = await missedRunPeriods(tx, ctx.operatorId);
    return ok(subscriptionViewOf(ctx.operatorId, row, missed));
  },
});

export const RecordCheckoutSubscriptionInput = z
  .object({
    razorpaySubscriptionId: z.string().regex(/^sub_[A-Za-z0-9]{1,40}$/),
    planCode: z
      .string()
      .refine((code) => code in SUBSCRIPTION_PLANS)
      .default(CURRENT_PLAN.code),
  })
  .strict();

/**
 * Makes the given Razorpay subscription the tenant's current one (status unchanged until Razorpay
 * reports a payment). Only called by `startSubscriptionCheckout` with an id Razorpay just returned
 * for this tenant; the id is unique across tenants (another tenant's id → CONFLICT).
 */
export const recordCheckoutSubscription = defineService({
  name: "subscriptions.record_checkout",
  capability: "subscription.manage",
  input: RecordCheckoutSubscriptionInput,
  async run({ ctx, input, tx, audit, now }) {
    const applied = await applySubscriptionChange(tx, {
      operatorId: ctx.operatorId,
      change: { kind: "checkout_created", subscriptionId: input.razorpaySubscriptionId },
      now,
      actor: { kind: "user", userId: ctx.userId, role: ctx.role },
      source: "checkout",
      planCode: input.planCode,
      recordAudit: (event) =>
        audit.record({
          action: "subscriptions.checkout_started",
          entityType: event.entityType,
          entityId: event.entityId,
          before: event.before,
          after: event.after,
        }),
    });
    if (!applied.changed) audit.skip("idempotent_replay");
    const row = await readSubscription(tx);
    return ok(subscriptionViewOf(ctx.operatorId, row, await missedRunPeriods(tx, ctx.operatorId)));
  },
});
