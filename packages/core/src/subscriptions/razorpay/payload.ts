/**
 * The parts of Razorpay's documented JSON we read (Subscriptions API and webhook bodies). Schemas
 * are loose: Razorpay adds fields, and we keep the whole verified body in `subscription_events`.
 * Timestamps are Unix seconds. Empty `notes` arrive as `[]` (Razorpay's PHP heritage).
 */
import { z } from "zod";
import { RAZORPAY_SUBSCRIPTION_STATUSES, type RazorpaySnapshot } from "../state";

const unixSeconds = z.number().int().nonnegative();
const notes = z
  .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
  .nullable()
  .optional();

export const RazorpaySubscriptionEntity = z
  .object({
    id: z.string().regex(/^sub_[A-Za-z0-9]{1,40}$/),
    entity: z.literal("subscription").optional(),
    plan_id: z.string().optional(),
    customer_id: z.string().nullable().optional(),
    status: z.enum(RAZORPAY_SUBSCRIPTION_STATUSES),
    current_start: unixSeconds.nullable().optional(),
    current_end: unixSeconds.nullable().optional(),
    charge_at: unixSeconds.nullable().optional(),
    start_at: unixSeconds.nullable().optional(),
    end_at: unixSeconds.nullable().optional(),
    paid_count: z.number().int().optional(),
    total_count: z.number().int().optional(),
    short_url: z.string().nullable().optional(),
    notes,
    created_at: unixSeconds.optional(),
  })
  .loose();
export type RazorpaySubscriptionEntity = z.infer<typeof RazorpaySubscriptionEntity>;

export const RazorpayPlanEntity = z
  .object({
    id: z.string(),
    period: z.string(),
    interval: z.number().int(),
    item: z
      .object({
        amount: z.number().int(),
        currency: z.string(),
      })
      .loose(),
  })
  .loose();
export type RazorpayPlanEntity = z.infer<typeof RazorpayPlanEntity>;

export const RazorpayPaymentEntity = z
  .object({
    id: z.string(),
    amount: z.number().int().optional(),
    currency: z.string().optional(),
    status: z.string().optional(),
    invoice_id: z.string().nullable().optional(),
  })
  .loose();

/** A webhook body (`entity: "event"`). */
export const RazorpayWebhookBody = z
  .object({
    entity: z.literal("event"),
    account_id: z.string().optional(),
    event: z.string().regex(/^[a-z_]+(\.[a-z_]+)+$/),
    contains: z.array(z.string()).optional(),
    payload: z
      .object({
        subscription: z.object({ entity: RazorpaySubscriptionEntity }).loose().optional(),
        payment: z.object({ entity: RazorpayPaymentEntity }).loose().optional(),
      })
      .loose(),
    created_at: unixSeconds,
  })
  .loose();
export type RazorpayWebhookBody = z.infer<typeof RazorpayWebhookBody>;

/** Unix seconds → Date (null stays null). */
export function fromUnix(seconds: number | null | undefined): Date | null {
  return seconds === null || seconds === undefined ? null : new Date(seconds * 1000);
}

/** The state-machine view of a subscription entity seen at `at`. */
export function snapshotOf(entity: RazorpaySubscriptionEntity, at: Date): RazorpaySnapshot {
  return {
    subscriptionId: entity.id,
    status: entity.status,
    currentEnd: fromUnix(entity.current_end),
    at,
  };
}

/** `notes.operator_id`, when Razorpay echoes the note we set at creation. */
export function operatorNoteOf(entity: RazorpaySubscriptionEntity): string | null {
  const value = entity.notes && !Array.isArray(entity.notes) ? entity.notes.operator_id : undefined;
  return typeof value === "string" ? value : null;
}
