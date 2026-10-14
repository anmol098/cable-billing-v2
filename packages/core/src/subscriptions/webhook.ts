/**
 * Razorpay webhooks (PLAN §13): `POST /api/webhooks/razorpay` hands the raw body and two headers
 * to {@link handleRazorpayWebhook}.
 *
 * 1. **Signature first**: HMAC-SHA256 of the raw body with `RAZORPAY_WEBHOOK_SECRET`, compared in
 *    constant time. Missing or wrong → 401, nothing parsed, nothing stored.
 * 2. **Stored once**: `subscription_events` has one row per `x-razorpay-event-id`
 *    (`INSERT … ON CONFLICT DO NOTHING`, append-only). A second delivery of the same event finds
 *    the row and changes nothing (`duplicate`). The insert and the state change share one
 *    transaction, so an event whose processing failed is not stored and Razorpay's retry
 *    processes it again.
 * 3. **Matched by subscription id**: the tenant is the one whose `razorpay_subscription_id` is the
 *    event's subscription (set when the Owner opened checkout). `notes.operator_id` must agree when
 *    present. Unmatched events are stored with `operator_id` NULL and a `processing_error` so the
 *    admin console (T-086) can see them; they change nothing.
 * 4. **Applied** through the state machine (`applySubscriptionChange`), which is idempotent and
 *    ignores older snapshots. So a body replayed under a new event id changes nothing either.
 *
 * Answers: 200 for every stored or recognised event (Razorpay stops retrying), 401 bad signature,
 * 400 unreadable request; a thrown error (database down) becomes 500 in the route and Razorpay
 * retries later.
 */
import { type DbClient, subscriptionEvents, subscriptions } from "@cb/db";
import { eq } from "drizzle-orm";
import type { Logger } from "../logging/logger";
import {
  fromUnix,
  operatorNoteOf,
  RazorpayWebhookBody,
  type RazorpayWebhookBody as RazorpayWebhookBodyType,
  snapshotOf,
} from "./razorpay/payload";
import { verifyWebhookSignature } from "./razorpay/signature";
import type { SubscriptionState } from "./state";
import { applySubscriptionChange } from "./store";

/** Largest body we read (Razorpay events are a few KB). */
export const RAZORPAY_WEBHOOK_MAX_BYTES = 256 * 1024;

const EVENT_ID = /^[A-Za-z0-9_]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RazorpayWebhookDeps {
  readonly db: Pick<DbClient, "withTenant" | "withPlatform">;
  readonly log: Logger;
  readonly now: () => Date;
  /** `RAZORPAY_WEBHOOK_SECRET`. */
  readonly secret: string;
}

export interface RazorpayWebhookRequest {
  readonly rawBody: string;
  /** `X-Razorpay-Signature`. */
  readonly signature: string | null;
  /** `X-Razorpay-Event-Id`. */
  readonly eventId: string | null;
}

export type RazorpayWebhookOutcome =
  | "applied"
  | "no_change"
  | "duplicate"
  | "unmatched"
  | "invalid_signature"
  | "bad_request";

export interface RazorpayWebhookResult {
  readonly httpStatus: 200 | 400 | 401;
  readonly outcome: RazorpayWebhookOutcome;
  readonly eventType?: string;
  readonly operatorId?: string;
  /** The tenant left read-only mode with this event (send the "working again" email). */
  readonly reactivated?: boolean;
  readonly state?: SubscriptionState;
  /** Skipped billing months to show after a reactivation (D-25). */
  readonly missedRunPeriods?: readonly string[];
}

/** Why a stored event changed nothing (`subscription_events.processing_error`). */
export type WebhookProcessingError =
  | "unreadable_payload"
  | "no_subscription"
  | "unmatched_subscription"
  | "operator_mismatch";

async function storeUnmatched(
  deps: RazorpayWebhookDeps,
  eventId: string,
  type: string,
  payload: unknown,
  error: WebhookProcessingError,
): Promise<boolean> {
  const now = deps.now();
  const inserted = await deps.db.withPlatform((tx) =>
    tx
      .insert(subscriptionEvents)
      .values({
        operatorId: null,
        razorpayEventId: eventId,
        type,
        payload,
        receivedAt: now,
        processedAt: now,
        processingError: error,
      })
      .onConflictDoNothing({ target: subscriptionEvents.razorpayEventId })
      .returning({ id: subscriptionEvents.id }),
  );
  return inserted.length > 0;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export async function handleRazorpayWebhook(
  deps: RazorpayWebhookDeps,
  request: RazorpayWebhookRequest,
): Promise<RazorpayWebhookResult> {
  const log = deps.log;
  if (!verifyWebhookSignature(request.rawBody, request.signature, deps.secret)) {
    log.warn("razorpay.webhook_bad_signature", { has_signature: Boolean(request.signature) });
    return { httpStatus: 401, outcome: "invalid_signature" };
  }
  const eventId = request.eventId?.trim() ?? "";
  if (!EVENT_ID.test(eventId)) {
    log.warn("razorpay.webhook_bad_request", { reason: "event_id" });
    return { httpStatus: 400, outcome: "bad_request" };
  }
  const json = parseJson(request.rawBody);
  if (json === undefined || typeof json !== "object" || json === null) {
    log.warn("razorpay.webhook_bad_request", { reason: "json", event_id: eventId });
    return { httpStatus: 400, outcome: "bad_request" };
  }
  const parsed = RazorpayWebhookBody.safeParse(json);
  if (!parsed.success) {
    // Signed by Razorpay but not a shape we know: keep it for the admin, stop the retries.
    const type =
      "event" in json && typeof (json as { event?: unknown }).event === "string"
        ? String((json as { event: string }).event).slice(0, 80)
        : "unknown";
    const stored = await storeUnmatched(deps, eventId, type, json, "unreadable_payload");
    log.warn("razorpay.webhook_unreadable", { event_id: eventId, stored });
    return { httpStatus: 200, outcome: stored ? "unmatched" : "duplicate", eventType: type };
  }
  const body: RazorpayWebhookBodyType = parsed.data;
  const entity = body.payload.subscription?.entity;
  if (!entity) {
    const stored = await storeUnmatched(deps, eventId, body.event, json, "no_subscription");
    log.info("razorpay.webhook_recorded", {
      event_id: eventId,
      event_type: body.event,
      outcome: stored ? "no_subscription" : "duplicate",
    });
    return { httpStatus: 200, outcome: stored ? "unmatched" : "duplicate", eventType: body.event };
  }

  const owner = await deps.db.withPlatform(
    (tx) =>
      tx
        .select({ operatorId: subscriptions.operatorId })
        .from(subscriptions)
        .where(eq(subscriptions.razorpaySubscriptionId, entity.id))
        .limit(1),
    { accessMode: "read only" },
  );
  const operatorId = owner[0]?.operatorId;
  const note = operatorNoteOf(entity);
  const mismatch = operatorId && note && UUID.test(note) && note.toLowerCase() !== operatorId;
  if (!operatorId || mismatch) {
    const error = mismatch ? "operator_mismatch" : "unmatched_subscription";
    const stored = await storeUnmatched(deps, eventId, body.event, json, error);
    log.warn("razorpay.webhook_unmatched", {
      event_id: eventId,
      event_type: body.event,
      reason: error,
      stored,
    });
    return { httpStatus: 200, outcome: stored ? "unmatched" : "duplicate", eventType: body.event };
  }

  const at = fromUnix(body.created_at) ?? deps.now();
  const result = await deps.db.withTenant(operatorId, async (tx) => {
    const now = deps.now();
    const inserted = await tx
      .insert(subscriptionEvents)
      .values({
        operatorId,
        razorpayEventId: eventId,
        type: body.event,
        payload: json,
        receivedAt: now,
      })
      .onConflictDoNothing({ target: subscriptionEvents.razorpayEventId })
      .returning({ id: subscriptionEvents.id });
    const row = inserted[0];
    if (!row) return null;
    const applied = await applySubscriptionChange(tx, {
      operatorId,
      change: { kind: "razorpay", snapshot: snapshotOf(entity, at) },
      now,
      actor: { kind: "system" },
      source: `webhook:${body.event}`,
      requestId: eventId,
    });
    await tx
      .update(subscriptionEvents)
      .set({ processedAt: now })
      .where(eq(subscriptionEvents.id, row.id));
    return applied;
  });

  if (!result) {
    log.info("razorpay.webhook_duplicate", { event_id: eventId, event_type: body.event });
    return { httpStatus: 200, outcome: "duplicate", eventType: body.event, operatorId };
  }
  const outcome = result.changed ? "applied" : "no_change";
  log.info("razorpay.webhook_processed", {
    event_id: eventId,
    event_type: body.event,
    operator_id: operatorId,
    outcome,
    status_before: result.before?.status ?? null,
    status_after: result.step?.state.status ?? null,
    ignored: result.step?.ignored ?? null,
  });
  return {
    httpStatus: 200,
    outcome,
    eventType: body.event,
    operatorId,
    reactivated: result.step?.reactivated ?? false,
    ...(result.step ? { state: result.step.state } : {}),
    missedRunPeriods: result.missedRunPeriods,
  };
}
