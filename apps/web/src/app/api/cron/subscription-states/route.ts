/**
 * `subscription-states` cron (PLAN §14, `30 0 * * *` = 06:00 IST daily; T-085): moves subscriptions
 * trialing/active → grace → read_only (or cancelled) by date, reconciles with Razorpay's API in case
 * a webhook was missed, and emails the Owner the reminders that are due (T-7, T-1, grace start,
 * grace T-7/T-1) and "working again" after a reconciled payment. Idempotent. Rules:
 * `runSubscriptionStates` in `@cb/core` (subscriptions/daily.ts).
 *
 * Without Razorpay keys the dates still apply (nothing is reconciled); without Resend the emails
 * are logged as not sent. One tenant's database failure → the others continue, then 500 + Sentry.
 */
import { runSubscriptionStates, SubscriptionStatesError } from "@cb/core";
import { razorpaySetup, subscriptionNotifier } from "@/lib/subscription/server";
import { cronRoute } from "../_lib/cron";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export const GET = cronRoute("subscription_states", async ({ db, log, requestId }) => {
  try {
    const report = await runSubscriptionStates({
      db: db(),
      now: () => new Date(),
      log,
      requestId,
      razorpay: razorpaySetup()?.client ?? null,
      notifier: subscriptionNotifier(log),
    });
    return { ...report };
  } catch (error) {
    // Keep the counts in the log line `cron.failed` comes with (cronRoute reports the error).
    if (error instanceof SubscriptionStatesError) {
      log.error("subscription_states.report", { failed: error.report.failed });
    }
    throw error;
  }
});
