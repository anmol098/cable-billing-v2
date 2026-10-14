/**
 * Test helpers for the subscription tests (Vitest only): Razorpay test-mode webhook fixtures
 * (`./fixtures/*.json`, shaped like Razorpay's documented sample payloads, with test-mode ids),
 * signed deliveries, and direct row setup through the admin pool.
 */
import { readFileSync } from "node:fs";
import type { SubscriptionStatus } from "@cb/db";
import type { TestDatabase } from "@cb/db/testing";
import { razorpayHmac } from "./razorpay/signature";

export const WEBHOOK_SECRET = "whsec-test-0123456789abcdef";
export const KEY_SECRET = "key-secret-test-0123456789";

export type FixtureName =
  | "subscription.authenticated"
  | "subscription.activated"
  | "subscription.charged"
  | "subscription.pending"
  | "subscription.halted"
  | "subscription.cancelled"
  | "payment.failed";

const unix = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * A Razorpay fixture with the subscription id (and optionally its times and notes) replaced, so
 * each test can bind it to its own tenant.
 */
export function razorpayFixture(
  name: FixtureName,
  overrides: {
    subscriptionId?: string;
    operatorId?: string | null;
    createdAt?: Date;
    currentEnd?: Date | null;
  } = {},
): Record<string, unknown> {
  const body = JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as {
    created_at: number;
    payload: { subscription?: { entity: Record<string, unknown> } };
  };
  if (overrides.createdAt) body.created_at = unix(overrides.createdAt);
  const entity = body.payload.subscription?.entity;
  if (entity) {
    if (overrides.subscriptionId) entity.id = overrides.subscriptionId;
    if (overrides.operatorId === null) entity.notes = [];
    else if (overrides.operatorId) {
      entity.notes = { operator_id: overrides.operatorId, plan_code: "monthly_400_gst18" };
    }
    if (overrides.currentEnd !== undefined) {
      entity.current_end = overrides.currentEnd ? unix(overrides.currentEnd) : null;
    }
  }
  return body;
}

/** The raw body and headers Razorpay would send. */
export function signedDelivery(
  body: unknown,
  eventId: string,
  secret: string = WEBHOOK_SECRET,
): { rawBody: string; signature: string; eventId: string } {
  const rawBody = JSON.stringify(body);
  return { rawBody, signature: razorpayHmac(rawBody, secret), eventId };
}

let eventSequence = 0;
/** A fresh Razorpay-style event id (`evt_…`). */
export function newEventId(): string {
  eventSequence += 1;
  return `evt_Test${Date.now().toString(36)}${eventSequence}`;
}

let subSequence = 0;
/** A fresh Razorpay-style subscription id (`sub_…`). */
export function newSubscriptionId(): string {
  subSequence += 1;
  return `sub_T${Date.now().toString(36)}${subSequence}`;
}

/** Sets the tenant's subscription columns directly (admin pool, bypasses RLS). */
export async function setSubscriptionRow(
  database: Pick<TestDatabase, "admin">,
  operatorId: string,
  fields: {
    status: SubscriptionStatus;
    trialEndsAt?: Date | null;
    currentPeriodEnd?: Date | null;
    graceEndsAt?: Date | null;
    cancelledAt?: Date | null;
    razorpaySubscriptionId?: string | null;
    razorpayStatus?: string | null;
    razorpayStatusAt?: Date | null;
  },
): Promise<void> {
  await database.admin.query(
    `UPDATE subscriptions SET status = $2, trial_ends_at = $3, current_period_end = $4,
       grace_ends_at = $5, cancelled_at = $6, razorpay_subscription_id = $7,
       razorpay_status = $8, razorpay_status_at = $9
     WHERE operator_id = $1`,
    [
      operatorId,
      fields.status,
      fields.trialEndsAt ?? null,
      fields.currentPeriodEnd ?? null,
      fields.graceEndsAt ?? null,
      fields.cancelledAt ?? null,
      fields.razorpaySubscriptionId ?? null,
      fields.razorpayStatus ?? null,
      fields.razorpayStatusAt ?? null,
    ],
  );
}

/** Gives the tenant's owner an email address (test users have none by default). */
export async function giveOwnerEmail(
  database: Pick<TestDatabase, "admin">,
  ownerUserId: string,
  email: string,
  language: "en" | "hi" = "en",
): Promise<void> {
  await database.admin.query("UPDATE users SET email = $2, language = $3 WHERE id = $1", [
    ownerUserId,
    email,
    language,
  ]);
}

export interface SubscriptionRowView {
  status: SubscriptionStatus;
  trial_ends_at: Date | null;
  current_period_end: Date | null;
  grace_ends_at: Date | null;
  cancelled_at: Date | null;
  razorpay_subscription_id: string | null;
  razorpay_status: string | null;
  razorpay_status_at: Date | null;
  plan_code: string | null;
}

export async function subscriptionRow(
  database: Pick<TestDatabase, "admin">,
  operatorId: string,
): Promise<SubscriptionRowView> {
  const result = await database.admin.query<SubscriptionRowView>(
    `SELECT status, trial_ends_at, current_period_end, grace_ends_at, cancelled_at,
            razorpay_subscription_id, razorpay_status, razorpay_status_at, plan_code
       FROM subscriptions WHERE operator_id = $1`,
    [operatorId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("no subscription row");
  return row;
}
