/**
 * `POST /api/webhooks/razorpay` (T-085, PLAN §13). Reads the **raw** body (the signature covers the
 * exact bytes), hands it to `handleRazorpayWebhook` in `@cb/core` and answers:
 *
 * | Case | Status |
 * |---|---|
 * | processed, duplicate, unmatched (stored) | 200 `{ ok: true, outcome }` |
 * | missing / wrong signature | 401 |
 * | no event id, not JSON | 400 |
 * | body over 256 KB | 413 |
 * | `RAZORPAY_WEBHOOK_SECRET` unset | 503 (nothing read; Razorpay retries later) |
 * | database error | 500 (Sentry; Razorpay retries, and nothing was stored) |
 *
 * A payment that ends read-only mode also emails the Owner ("working again" + missed bill runs),
 * after the response so Razorpay isn't kept waiting.
 */
import {
  handleRazorpayWebhook,
  type Logger,
  RAZORPAY_WEBHOOK_MAX_BYTES,
  reactivatedNotice,
  type SubscriptionNotifier,
  sendSubscriptionNotice,
} from "@cb/core";
import type { DbClient } from "@cb/db";
import * as Sentry from "@sentry/nextjs";

export interface RazorpayWebhookRouteDeps {
  readonly db: Pick<DbClient, "withTenant" | "withPlatform">;
  readonly log: Logger;
  readonly now: () => Date;
  /** `RAZORPAY_WEBHOOK_SECRET`; undefined = not configured. */
  readonly secret: string | undefined;
  readonly notifier: SubscriptionNotifier | null;
  /** Runs work after the response (Next's `after`); tests await it. */
  readonly afterResponse: (task: () => Promise<unknown>) => void;
}

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export function razorpayWebhookHandler(
  getDeps: () => RazorpayWebhookRouteDeps,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const deps = getDeps();
    const log = deps.log;
    if (!deps.secret) {
      log.error("razorpay.webhook_not_configured", {});
      return json({ error: "WEBHOOK_NOT_CONFIGURED" }, 503);
    }
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > RAZORPAY_WEBHOOK_MAX_BYTES) {
      return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
    }
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody, "utf8") > RAZORPAY_WEBHOOK_MAX_BYTES) {
      return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
    }
    try {
      const result = await handleRazorpayWebhook(
        { db: deps.db, log, now: deps.now, secret: deps.secret },
        {
          rawBody,
          signature: request.headers.get("x-razorpay-signature"),
          eventId: request.headers.get("x-razorpay-event-id"),
        },
      );
      if (result.httpStatus === 401) return json({ error: "INVALID_SIGNATURE" }, 401);
      if (result.httpStatus === 400) return json({ error: "BAD_REQUEST" }, 400);
      if (result.reactivated && result.operatorId && result.state && deps.notifier) {
        const { operatorId, state } = result;
        const notifier = deps.notifier;
        const missed = result.missedRunPeriods ?? [];
        deps.afterResponse(() =>
          sendSubscriptionNotice({
            db: deps.db,
            operatorId,
            notice: reactivatedNotice(state, deps.now()),
            missedRunPeriods: missed,
            notifier,
            log,
          }).catch((error: unknown) => {
            log.error("razorpay.webhook_notice_failed", {
              operator_id: operatorId,
              error_type: error instanceof Error ? error.name : "unknown",
            });
          }),
        );
      }
      return json({ ok: true, outcome: result.outcome }, 200);
    } catch (error) {
      log.error("razorpay.webhook_failed", {
        error_type: error instanceof Error ? error.name : "unknown",
      });
      Sentry.captureException(error, { tags: { webhook: "razorpay" } });
      return json({ error: "INTERNAL" }, 500);
    }
  };
}
