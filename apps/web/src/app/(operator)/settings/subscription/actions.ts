"use server";

/**
 * Subscription Server Actions (T-085). Next.js checks every Server Action's Origin (CSRF); the
 * session gives the TenantContext (never an operator id from the browser); `@cb/core` checks the
 * Owner role, talks to Razorpay and applies only what Razorpay's API says.
 *
 * - `startCheckoutAction()`: makes (or reuses) the Razorpay subscription and returns what Checkout
 *   needs in the browser: the public key id and the subscription id. Nothing secret.
 * - `confirmCheckoutAction(response)`: Checkout's success handler. Verifies Razorpay's signature,
 *   then reads the subscription from Razorpay and applies it.
 */
import {
  type CheckoutError,
  confirmSubscriptionCheckout,
  type SubscriptionView,
  startSubscriptionCheckout,
} from "@cb/core";
import { businessDateOf } from "@cb/domain";
import { revalidatePath } from "next/cache";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { razorpaySetup } from "@/lib/subscription/server";

/** What the Pay button shows after an action (words are looked up by the client). */
export type CheckoutFailure = "not_set_up" | "provider" | "plan_mismatch" | "unexpected";

export type StartCheckoutState =
  | {
      kind: "open";
      keyId: string;
      subscriptionId: string;
      /** ISO; the first charge is later (end of trial or paid month). */
      firstChargeAt: string | null;
    }
  | { kind: "autopay_on" }
  | { kind: "error"; reason: CheckoutFailure };

export type ConfirmCheckoutState =
  | { kind: "paid"; paidTill: string | null }
  /** Autopay authorised during the trial: the first charge is when the trial ends. */
  | { kind: "autopay_set"; firstChargeOn: string | null }
  | { kind: "waiting" }
  | { kind: "error"; reason: CheckoutFailure };

const SUBSCRIPTION_PATH = "/settings/subscription";

function failureOf(error: CheckoutError): CheckoutFailure {
  if (error.code === "PAYMENT_PROVIDER_ERROR") return "provider";
  if (error.code === "PLAN_MISMATCH") return "plan_mismatch";
  return "unexpected";
}

export async function startCheckoutAction(): Promise<StartCheckoutState> {
  const ctx = await getTenantContext();
  const setup = razorpaySetup();
  if (!setup?.planId) return { kind: "error", reason: "not_set_up" };
  try {
    const result = await startSubscriptionCheckout(getServerRuntime(), ctx, {
      razorpay: setup.client,
      keyId: setup.keyId,
      planId: setup.planId,
    });
    if (!result.ok) return { kind: "error", reason: failureOf(result.error) };
    if (result.value.kind === "autopay_on") {
      revalidatePath(SUBSCRIPTION_PATH);
      return { kind: "autopay_on" };
    }
    return {
      kind: "open",
      keyId: result.value.keyId,
      subscriptionId: result.value.subscriptionId,
      firstChargeAt: result.value.firstChargeAt?.toISOString() ?? null,
    };
  } catch (error) {
    console.error("subscription.checkout_failed", error instanceof Error ? error.name : "unknown");
    return { kind: "error", reason: "unexpected" };
  }
}

/** Checkout's handler fields (`razorpay_payment_id`, `razorpay_subscription_id`, `razorpay_signature`). */
export async function confirmCheckoutAction(response: {
  paymentId: unknown;
  subscriptionId: unknown;
  signature: unknown;
}): Promise<ConfirmCheckoutState> {
  const ctx = await getTenantContext();
  const setup = razorpaySetup();
  if (!setup) return { kind: "error", reason: "not_set_up" };
  const text = (value: unknown) => (typeof value === "string" ? value.slice(0, 100) : "");
  try {
    const result = await confirmSubscriptionCheckout(
      getServerRuntime(),
      ctx,
      { razorpay: setup.client, keySecret: setup.keySecret },
      {
        paymentId: text(response.paymentId),
        subscriptionId: text(response.subscriptionId),
        signature: text(response.signature),
      },
    );
    if (!result.ok) return { kind: "error", reason: failureOf(result.error) };
    // The banner and every page's buttons depend on the state.
    revalidatePath("/", "layout");
    return paidState(result.value);
  } catch (error) {
    console.error("subscription.confirm_failed", error instanceof Error ? error.name : "unknown");
    return { kind: "error", reason: "unexpected" };
  }
}

function paidState(view: SubscriptionView): ConfirmCheckoutState {
  if (view.status === "active") return { kind: "paid", paidTill: view.accessLastDay };
  if (view.autopay === "on") {
    return {
      kind: "autopay_set",
      firstChargeOn: view.trialEndsAt ? businessDateOf(view.trialEndsAt) : null,
    };
  }
  return { kind: "waiting" };
}
