/**
 * Checkout for our SaaS fee (PLAN §13: Owner → Settings → Subscription → "Pay ₹472 / month" →
 * Razorpay Checkout with a **Subscription**, i.e. a UPI Autopay or card mandate).
 *
 * `startSubscriptionCheckout` (server action "Pay"):
 * 1. `subscriptions.overview` (Owner only; also how the caller's role is checked).
 * 2. When the tenant already has a Razorpay subscription, ask Razorpay about it: still `created`
 *    (checkout not finished) → reuse it; `authenticated`/`active` → autopay is already on, nothing
 *    to pay (the state is refreshed); `pending`/`halted`/`paused` → cancel it first (so the old
 *    mandate can never charge on top of the new one), then make a new one; finished → new one.
 * 3. Check the Razorpay plan charges exactly the configured amount (₹472, INR, monthly): a
 *    dashboard typo must never charge a different price from the one we show.
 * 4. Create the subscription (`notes.operator_id`; first charge at the end of the trial or of the
 *    paid month when that is still ahead, so nobody pays twice for the same days), then record it
 *    (`subscriptions.record_checkout`, audited).
 * 5. Return what the browser needs to open Razorpay Checkout (key id + subscription id).
 *
 * `confirmSubscriptionCheckout` (Checkout's success handler): checks Razorpay's signature over
 * `payment_id|subscription_id` with the key secret and that it is the tenant's current
 * subscription, then reads the subscription from Razorpay's API and applies it. The browser's word
 * alone never changes the state; webhooks would do the same a moment later.
 */
import { err, ok, type Result } from "@cb/domain";
import type { ServiceRuntime } from "../context/runtime";
import type { TenantContext } from "../context/tenant-context";
import { type CoreErrorCode, type ServiceError, serviceError } from "../errors/errors";
import { CURRENT_PLAN, type SubscriptionPlan } from "./plan";
import { RazorpayApiError, type RazorpayClient } from "./razorpay/client";
import { verifyCheckoutSignature } from "./razorpay/signature";
import { reconcileWithRazorpay } from "./reconcile";
import {
  recordCheckoutSubscription,
  type SubscriptionView,
  subscriptionOverview,
} from "./services";
import { readSubscription } from "./store";

/** Checkout must not start this close to the planned first charge (Razorpay needs `start_at` ahead). */
const MIN_START_AHEAD_MS = 15 * 60 * 1000;

export interface CheckoutConfig {
  readonly razorpay: RazorpayClient;
  /** `RAZORPAY_KEY_ID` (public; the browser needs it for Checkout). */
  readonly keyId: string;
  /** `RAZORPAY_PLAN_ID`. */
  readonly planId: string;
  readonly plan?: SubscriptionPlan;
}

export type CheckoutErrorCode =
  | CoreErrorCode
  /** The Razorpay plan doesn't match the configured price (H-01 setup mistake). */
  | "PLAN_MISMATCH"
  /** Razorpay didn't answer or refused (try again later). */
  | "PAYMENT_PROVIDER_ERROR"
  /** Checkout's signature didn't verify. */
  | "BAD_SIGNATURE";

export type CheckoutError = ServiceError<CheckoutErrorCode>;

export type StartCheckoutResult =
  | {
      readonly kind: "open_checkout";
      readonly keyId: string;
      readonly subscriptionId: string;
      /** First charge, when it is later than now (end of trial / paid month). */
      readonly firstChargeAt: Date | null;
      readonly totalPaise: number;
    }
  | { readonly kind: "autopay_on"; readonly view: SubscriptionView };

function providerError(error: unknown): CheckoutError {
  const code = error instanceof RazorpayApiError ? error.code : "unknown";
  const status = error instanceof RazorpayApiError ? error.status : 0;
  return serviceError("PAYMENT_PROVIDER_ERROR", "Razorpay request failed", {
    razorpayCode: code,
    httpStatus: status,
  });
}

/** The plan in Razorpay charges what we show: same amount, INR, every 1 month. */
export function planMatches(
  remote: { period: string; interval: number; item: { amount: number; currency: string } },
  plan: SubscriptionPlan,
): boolean {
  return (
    remote.item.amount === plan.totalPaise &&
    remote.item.currency === plan.currency &&
    remote.period === plan.period &&
    remote.interval === plan.intervalCount
  );
}

/** When the first charge should be: the end of time already given (trial / paid month), if ahead. */
export function firstChargeAt(view: SubscriptionView, now: Date): Date | null {
  const paidThrough =
    view.status === "trialing"
      ? view.trialEndsAt
      : view.status === "active"
        ? view.currentPeriodEnd
        : null;
  if (!paidThrough) return null;
  return paidThrough.getTime() - now.getTime() > MIN_START_AHEAD_MS ? paidThrough : null;
}

export async function startSubscriptionCheckout(
  runtime: ServiceRuntime,
  ctx: TenantContext,
  config: CheckoutConfig,
): Promise<Result<StartCheckoutResult, CheckoutError>> {
  const plan = config.plan ?? CURRENT_PLAN;
  const overview = await subscriptionOverview.call(runtime, ctx, {});
  if (!overview.ok) return overview;
  const view = overview.value;
  const log = runtime.logger.child({ operator_id: ctx.operatorId, request_id: ctx.requestId });
  if (view.status === null) {
    log.error("subscription.checkout_no_row", {});
    return err(serviceError("INTERNAL", "Tenant has no subscription row"));
  }

  const existingId = await currentRazorpayId(runtime, ctx);
  if (existingId) {
    let entity: Awaited<ReturnType<RazorpayClient["fetchSubscription"]>>;
    try {
      entity = await config.razorpay.fetchSubscription(existingId);
    } catch (error) {
      log.warn("subscription.checkout_fetch_failed", { reason: errorCode(error) });
      return err(providerError(error));
    }
    if (entity.status === "created") {
      log.info("subscription.checkout_reused", {});
      return ok({
        kind: "open_checkout",
        keyId: config.keyId,
        subscriptionId: entity.id,
        firstChargeAt: entity.start_at ? new Date(entity.start_at * 1000) : null,
        totalPaise: plan.totalPaise,
      });
    }
    if (entity.status === "authenticated" || entity.status === "active") {
      const refreshed = await refresh(runtime, ctx, config.razorpay, "checkout_autopay_on");
      if (!refreshed.ok) return refreshed;
      return ok({ kind: "autopay_on", view: refreshed.value });
    }
    if (entity.status === "pending" || entity.status === "halted" || entity.status === "paused") {
      try {
        await config.razorpay.cancelSubscription(entity.id, { atCycleEnd: false });
      } catch (error) {
        log.warn("subscription.checkout_cancel_old_failed", { reason: errorCode(error) });
        return err(providerError(error));
      }
    }
  }

  try {
    const remote = await config.razorpay.fetchPlan(config.planId);
    if (!planMatches(remote, plan)) {
      log.error("subscription.plan_mismatch", {
        razorpay_amount_paise: remote.item.amount,
        configured_amount_paise: plan.totalPaise,
        razorpay_period: remote.period,
        razorpay_interval: remote.interval,
      });
      return err(
        serviceError("PLAN_MISMATCH", "Razorpay plan does not match the configured price"),
      );
    }
  } catch (error) {
    log.warn("subscription.plan_fetch_failed", { reason: errorCode(error) });
    return err(providerError(error));
  }

  const startAt = firstChargeAt(view, runtime.now());
  let created: Awaited<ReturnType<RazorpayClient["createSubscription"]>>;
  try {
    created = await config.razorpay.createSubscription({
      planId: config.planId,
      totalCount: plan.totalCount,
      customerNotify: true,
      ...(startAt ? { startAt } : {}),
      notes: { operator_id: ctx.operatorId, plan_code: plan.code },
    });
  } catch (error) {
    log.warn("subscription.checkout_create_failed", { reason: errorCode(error) });
    return err(providerError(error));
  }
  const recorded = await recordCheckoutSubscription.call(runtime, ctx, {
    razorpaySubscriptionId: created.id,
    planCode: plan.code,
  });
  if (!recorded.ok) return recorded;
  log.info("subscription.checkout_created", { deferred_start: Boolean(startAt) });
  return ok({
    kind: "open_checkout",
    keyId: config.keyId,
    subscriptionId: created.id,
    firstChargeAt: startAt,
    totalPaise: plan.totalPaise,
  });
}

export interface ConfirmCheckoutInput {
  readonly paymentId: string;
  readonly subscriptionId: string;
  readonly signature: string;
}

export async function confirmSubscriptionCheckout(
  runtime: ServiceRuntime,
  ctx: TenantContext,
  config: { readonly razorpay: RazorpayClient; readonly keySecret: string },
  input: ConfirmCheckoutInput,
): Promise<Result<SubscriptionView, CheckoutError>> {
  const overview = await subscriptionOverview.call(runtime, ctx, {});
  if (!overview.ok) return overview;
  const log = runtime.logger.child({ operator_id: ctx.operatorId, request_id: ctx.requestId });
  if (!verifyCheckoutSignature(input, config.keySecret)) {
    log.warn("subscription.checkout_bad_signature", {});
    return err(serviceError("BAD_SIGNATURE", "Checkout signature did not verify"));
  }
  const currentId = await currentRazorpayId(runtime, ctx);
  if (!currentId || currentId !== input.subscriptionId) {
    log.warn("subscription.checkout_not_current", {});
    return err(serviceError("NOT_FOUND", "Not this tenant's current subscription"));
  }
  return refresh(runtime, ctx, config.razorpay, "checkout_confirmed");
}

async function refresh(
  runtime: ServiceRuntime,
  ctx: TenantContext,
  razorpay: RazorpayClient,
  source: string,
): Promise<Result<SubscriptionView, CheckoutError>> {
  try {
    await reconcileWithRazorpay({
      db: runtime.db,
      razorpay,
      operatorId: ctx.operatorId,
      now: runtime.now,
      actor: { kind: "user", userId: ctx.userId, role: ctx.role },
      source,
      requestId: ctx.requestId,
    });
  } catch (error) {
    runtime.logger.warn("subscription.refresh_failed", {
      operator_id: ctx.operatorId,
      reason: errorCode(error),
    });
    return err(providerError(error));
  }
  return subscriptionOverview.call(runtime, ctx, {});
}

/** The tenant's stored Razorpay subscription id (read in the tenant's own transaction). */
async function currentRazorpayId(
  runtime: ServiceRuntime,
  ctx: TenantContext,
): Promise<string | null> {
  const row = await runtime.db.withTenant(ctx.operatorId, (tx) => readSubscription(tx), {
    accessMode: "read only",
  });
  return row?.razorpaySubscriptionId ?? null;
}

function errorCode(error: unknown): string {
  if (error instanceof RazorpayApiError) return `${error.status}:${error.code}`;
  return error instanceof Error ? error.name : "unknown";
}
