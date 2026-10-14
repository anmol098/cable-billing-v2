/**
 * Razorpay webhooks for our SaaS subscription (T-085, PLAN §13). Configure in Razorpay → Webhooks:
 * URL `<APP_BASE_URL>/api/webhooks/razorpay`, secret = `RAZORPAY_WEBHOOK_SECRET`, events
 * `subscription.authenticated`, `.activated`, `.charged`, `.pending`, `.halted`, `.cancelled`,
 * `.completed` and `payment.failed` (docs/runbooks/environments.md §4.7). See `_lib/handler.ts`.
 */
import { createLogger } from "@cb/core";
import { after } from "next/server";
import { serverEnv } from "@/env";
import { getServerRuntime } from "@/lib/auth/server";
import { subscriptionNotifier } from "@/lib/subscription/server";
import { razorpayWebhookHandler } from "./_lib/handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const POST = razorpayWebhookHandler(() => {
  const log = createLogger().child({ route: "webhooks.razorpay" });
  const secret = serverEnv.RAZORPAY_WEBHOOK_SECRET;
  return {
    // The database is only opened when the secret is set (an unconfigured route answers 503).
    get db() {
      return getServerRuntime().db;
    },
    log,
    now: () => new Date(),
    secret,
    notifier: subscriptionNotifier(log),
    afterResponse: (task) => after(task),
  };
});
