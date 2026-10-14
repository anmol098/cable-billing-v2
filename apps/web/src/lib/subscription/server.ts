/**
 * Server only. Razorpay and email wiring for our SaaS subscription (T-085), from the environment:
 *
 * - `razorpaySetup()`: the API client + key id/secret + plan id, or `null` while the keys are not
 *   set (local, CI, previews before H-01): the subscription page then says online payment is not
 *   set up yet instead of failing. `RAZORPAY_API_BASE_URL` (local e2e only, refused on Vercel)
 *   points the client at the Playwright mock server.
 * - `subscriptionNotifier(log)`: reminder emails through Resend when configured; locally the
 *   e2e outbox (`EMAIL_OUTBOX_DIR`) or a log line ("not sent").
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createLogOnlyEmailTransport,
  createRazorpayClient,
  createResendEmailTransport,
  type EmailTransport,
  type Logger,
  type RazorpayClient,
  type SubscriptionNotifier,
} from "@cb/core";
import { deploymentTarget, serverEnv } from "@/env";
import { renderSubscriptionNotice } from "./notice-email";

export interface RazorpaySetup {
  readonly client: RazorpayClient;
  /** Public; Checkout in the browser needs it. */
  readonly keyId: string;
  readonly keySecret: string;
  /** Unset → checkout can't start (the page says so). */
  readonly planId: string | null;
}

/** `null` while `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` are not set. */
export function razorpaySetup(): RazorpaySetup | null {
  const keyId = serverEnv.RAZORPAY_KEY_ID;
  const keySecret = serverEnv.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  const local = deploymentTarget(serverEnv) === "local";
  const baseUrl = local ? serverEnv.RAZORPAY_API_BASE_URL : undefined;
  return {
    client: createRazorpayClient({ keyId, keySecret, ...(baseUrl ? { baseUrl } : {}) }),
    keyId,
    keySecret,
    planId: serverEnv.RAZORPAY_PLAN_ID ?? null,
  };
}

/** Writes each email as a JSON file (local e2e only), like T-027's sign-up outbox. */
function outboxTransport(dir: string): EmailTransport {
  return {
    name: "outbox",
    async send(message) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, `${Date.now()}-${randomUUID()}.json`),
        JSON.stringify({ to: message.to, subject: message.subject, text: message.text }),
      );
    },
  };
}

export function subscriptionEmailTransport(log: Logger): EmailTransport {
  const { RESEND_API_KEY, EMAIL_FROM } = serverEnv;
  if (RESEND_API_KEY && EMAIL_FROM) {
    return createResendEmailTransport({ apiKey: RESEND_API_KEY, from: EMAIL_FROM });
  }
  const outbox = deploymentTarget(serverEnv) === "local" ? serverEnv.EMAIL_OUTBOX_DIR : undefined;
  return outbox ? outboxTransport(outbox) : createLogOnlyEmailTransport(log);
}

export function subscriptionNotifier(log: Logger): SubscriptionNotifier {
  return { transport: subscriptionEmailTransport(log), render: renderSubscriptionNotice };
}
