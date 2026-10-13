/**
 * The operator's SaaS subscription (T-021 state columns; the state machine is T-085). PLAN §13,
 * FR-025, D-12, D-13, D-20, D-22.
 *
 * - `subscriptions`: one row per operator (created with the tenant, `trialing`). The tenant reads
 *   its own row (read-only guard, banners); `app_platform` may read and update every row (daily
 *   state cron, Razorpay webhooks, admin "extend"), but not create or delete one.
 * - `subscription_events`: Razorpay webhook deliveries, stored once per `razorpay_event_id`
 *   (`INSERT … ON CONFLICT DO NOTHING` makes duplicates harmless). Append-only except the
 *   processing columns. `operator_id` is NULL when the event could not be matched to a tenant.
 */
import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { appPlatform, operatorIdColumn, tenantPolicies } from "../rls";
import { operators } from "./tenancy";

/** PLAN §13. `read_only` and `cancelled` both mean read-only mode (collections still allowed). */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "grace",
  "read_only",
  "cancelled",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const subscriptionStatusEnum = pgEnum("subscription_status", SUBSCRIPTION_STATUSES);

export const subscriptions = pgTable(
  "subscriptions",
  {
    operatorId: operatorIdColumn()
      .primaryKey()
      .references(() => operators.id),
    status: subscriptionStatusEnum("status").notNull().default("trialing"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    graceEndsAt: timestamp("grace_ends_at", { withTimezone: true }),
    razorpayCustomerId: text("razorpay_customer_id"),
    razorpaySubscriptionId: text("razorpay_subscription_id"),
    /** Which configured price plan (PLAN §13: amounts live in config, not here). */
    planCode: text("plan_code"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("subscriptions_razorpay_subscription_unique").on(t.razorpaySubscriptionId),
    check(
      "subscriptions_trial_has_end",
      sql`${t.status} <> 'trialing' OR ${t.trialEndsAt} IS NOT NULL`,
    ),
    check(
      "subscriptions_grace_has_end",
      sql`${t.status} <> 'grace' OR ${t.graceEndsAt} IS NOT NULL`,
    ),
    ...tenantPolicies(t),
    pgPolicy("subscriptions_platform_select", { for: "select", to: appPlatform, using: sql`true` }),
    pgPolicy("subscriptions_platform_update", {
      for: "update",
      to: appPlatform,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();

export const subscriptionEvents = pgTable(
  "subscription_events",
  {
    id: primaryId(),
    /** The tenant, when the event could be matched to one. */
    operatorId: uuid("operator_id").references(() => operators.id),
    /** Razorpay's event id (`x-razorpay-event-id`): the idempotency key. */
    razorpayEventId: text("razorpay_event_id").notNull(),
    /** e.g. `subscription.charged`. */
    type: text("type").notNull(),
    /** The verified webhook body. */
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    /** Why processing failed (no secrets, no card data). */
    processingError: text("processing_error"),
  },
  (t) => [
    unique("subscription_events_razorpay_event_unique").on(t.razorpayEventId),
    ...tenantPolicies(t),
    pgPolicy("subscription_events_platform_select", {
      for: "select",
      to: appPlatform,
      using: sql`true`,
    }),
    pgPolicy("subscription_events_platform_insert", {
      for: "insert",
      to: appPlatform,
      withCheck: sql`true`,
    }),
    pgPolicy("subscription_events_platform_update", {
      for: "update",
      to: appPlatform,
      using: sql`true`,
      withCheck: sql`true`,
    }),
  ],
).enableRLS();
