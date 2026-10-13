/**
 * Payments and their reversals (T-023, PLAN §7.2, §8.4, §8.6, §10.4; FR-013 to FR-016;
 * BR-10, BR-11, BR-13; RULE-20).
 *
 * **`payments`**: one row per posted payment, from every source (Android, web counter, migration).
 * - **`id` is the client's idempotency key** (FR-015): the phone (or the web form) makes a UUIDv7
 *   before saving. The primary key is `(operator_id, id)`, so a replay of the same id within the
 *   tenant hits the key (23505 on `payments_pkey`) and can never become a second payment
 *   (T-046 then compares the payload: same → `duplicate`, different →
 *   `ID_REUSED_WITH_DIFFERENT_DATA`). Keying on the tenant too means one tenant's ids can never
 *   collide with, or reveal, another tenant's payments.
 * - `amount_paise > 0` (CHECK). `method` `cash | upi`; `upi_reference` only with UPI;
 *   `upi_verification` is `unverified` (BR-10: a UPI reference is not proof of payment).
 * - `collector_id` (the user who took it; NULL only for migrated payments), `device_id` (Android
 *   only), `source`, `recorded_at` (device clock; for web the server time), `posted_at` (server),
 *   `business_date` (the IST date of `recorded_at`, PLAN §8.7: the collection session it counts
 *   for; computed by the service).
 * - `balance_after_paise` / `credit_after_paise`: the customer's balance and credit right after
 *   posting (T-051 decision 5: receipts print them and a replay must return the same values).
 *   Required except for migrated payments.
 * - **Immutable** (PLAN §7.1, FR-013): a posted payment never changes and is never deleted;
 *   corrections are reversals. The only exception is the review workflow: while
 *   `review_status = 'needs_review'`, the office may set `review_status = 'resolved'` with
 *   `reviewed_by`, `reviewed_at` and `review_note`. A `none` or `resolved` payment never changes.
 *   `review_reason` (the contract's `ReviewReason`) is set at posting and is required exactly
 *   when the payment was flagged.
 *
 * **`payment_reversals`** (PLAN §8.6, Owner only): at most one per payment (UNIQUE
 * `(operator_id, payment_id)`), with a reason and the actor. Fully append-only. The reversal's
 * ledger entry and negative allocation rows reference it (ledger.ts).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId, uuidv7 } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { devices, users } from "./auth";
import { notBlank } from "./billing";
import { customers } from "./customers";

/** `payments.method` (the contract's `PaymentMethod`). */
export const PAYMENT_METHODS = ["cash", "upi"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const paymentMethodEnum = pgEnum("payment_method", PAYMENT_METHODS);

/**
 * `payments.upi_verification` (BR-10). Only `unverified` exists: nothing in the MVP verifies a UPI
 * payment. A verification flow would add a value (`ALTER TYPE … ADD VALUE`) and allow the column
 * in the payments trigger.
 */
export const UPI_VERIFICATIONS = ["unverified"] as const;
export type UpiVerification = (typeof UPI_VERIFICATIONS)[number];
export const upiVerificationEnum = pgEnum("upi_verification", UPI_VERIFICATIONS);

/** `payments.source` (PLAN §7.2). */
export const PAYMENT_SOURCES = ["android", "web", "migration"] as const;
export type PaymentSource = (typeof PAYMENT_SOURCES)[number];
export const paymentSourceEnum = pgEnum("payment_source", PAYMENT_SOURCES);

/** `payments.review_status` (PLAN §7.2, §10.4 `posted_needs_review`). */
export const PAYMENT_REVIEW_STATUSES = ["none", "needs_review", "resolved"] as const;
export type PaymentReviewStatus = (typeof PAYMENT_REVIEW_STATUSES)[number];
export const paymentReviewStatusEnum = pgEnum("payment_review_status", PAYMENT_REVIEW_STATUSES);

/** `payments.review_reason`: the values of the mobile contract's `ReviewReason` (T-051). */
export const PAYMENT_REVIEW_REASONS = [
  "customer_inactive",
  "collector_inactive",
  "collector_mismatch",
  "device_mismatch",
  "recorded_at_out_of_range",
  "other",
] as const;
export type PaymentReviewReason = (typeof PAYMENT_REVIEW_REASONS)[number];
export const paymentReviewReasonEnum = pgEnum("payment_review_reason", PAYMENT_REVIEW_REASONS);

/** The provisional receipt reference format `P-{device_code}-{seq}` (PLAN §7.3, contract). */
export const PROVISIONAL_REF_PATTERN = "^P-[A-Z0-9]{3}-[0-9]{4,9}$";

export const payments = pgTable(
  "payments",
  {
    /** The client-made idempotency key (FR-015). Unique per operator (the primary key). */
    id: uuid("id").notNull().$defaultFn(uuidv7),
    operatorId: operatorIdColumn(),
    customerId: uuid("customer_id").notNull(),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    method: paymentMethodEnum("method").notNull(),
    /** The UPI reference the collector typed (UPI only; not proof, BR-10). */
    upiReference: text("upi_reference"),
    upiVerification: upiVerificationEnum("upi_verification").notNull().default("unverified"),
    notes: text("notes"),
    /** The user who took the payment. NULL only for migrated payments. */
    collectorId: uuid("collector_id"),
    /** The phone it was taken on (Android only). */
    deviceId: uuid("device_id"),
    source: paymentSourceEnum("source").notNull(),
    /** When it was taken, by the device's clock (UTC). */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
    /** When the server posted it (UTC). */
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    /** IST business date of `recorded_at` (`BusinessDate`): its collection session. */
    businessDate: date("business_date", { mode: "string" }).notNull(),
    /** Customer balance right after posting (signed; the receipt's "balance after payment"). */
    balanceAfterPaise: bigint("balance_after_paise", { mode: "number" }),
    /** Customer credit right after posting (≥ 0). */
    creditAfterPaise: bigint("credit_after_paise", { mode: "number" }),
    reviewStatus: paymentReviewStatusEnum("review_status").notNull().default("none"),
    reviewReason: paymentReviewReasonEnum("review_reason"),
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    // The idempotency key, per tenant (also the target of composite FKs `(operator_id, payment_id)`).
    primaryKey({ name: "payments_pkey", columns: [t.operatorId, t.id] }),
    /** Target of the same-customer composite FKs (allocations, ledger, reversals). */
    unique("payments_operator_customer_id_unique").on(t.operatorId, t.customerId, t.id),
    uniqueIndex("payments_operator_legacy_unique")
      .on(t.operatorId, t.legacySource, t.legacyId)
      .where(sql`${t.legacyId} IS NOT NULL`),
    foreignKey({
      name: "payments_customer_fk",
      columns: [t.operatorId, t.customerId],
      foreignColumns: [customers.operatorId, customers.id],
    }),
    foreignKey({
      name: "payments_collector_fk",
      columns: [t.operatorId, t.collectorId],
      foreignColumns: [users.operatorId, users.id],
    }),
    foreignKey({
      name: "payments_device_fk",
      columns: [t.operatorId, t.deviceId],
      foreignColumns: [devices.operatorId, devices.id],
    }),
    foreignKey({
      name: "payments_reviewed_by_fk",
      columns: [t.operatorId, t.reviewedBy],
      foreignColumns: [users.operatorId, users.id],
    }),
    index("payments_customer_idx").on(t.operatorId, t.customerId, t.postedAt),
    // Collection sessions and the lineman's day (PLAN §8.7, T-062).
    index("payments_collector_day_idx").on(t.operatorId, t.collectorId, t.businessDate),
    // Payment register by day (T-048, T-081).
    index("payments_business_date_idx").on(t.operatorId, t.businessDate),
    index("payments_needs_review_idx")
      .on(t.operatorId, t.postedAt)
      .where(sql`${t.reviewStatus} = 'needs_review'`),
    check("payments_amount_positive", sql`${t.amountPaise} > 0`),
    check(
      "payments_upi_reference_only_upi",
      sql`${t.upiReference} IS NULL OR (${t.method} = 'upi' AND ${notBlank(t.upiReference)})`,
    ),
    check(
      "payments_collector_required",
      sql`${t.source} = 'migration' OR ${t.collectorId} IS NOT NULL`,
    ),
    check(
      "payments_device_only_android",
      sql`(${t.source} = 'android') = (${t.deviceId} IS NOT NULL)`,
    ),
    check(
      "payments_snapshots_required",
      sql`${t.source} = 'migration'
        OR (${t.balanceAfterPaise} IS NOT NULL AND ${t.creditAfterPaise} IS NOT NULL)`,
    ),
    check("payments_credit_after_not_negative", sql`${t.creditAfterPaise} >= 0`),
    check(
      "payments_review_reason_iff_flagged",
      sql`(${t.reviewStatus} = 'none') = (${t.reviewReason} IS NULL)`,
    ),
    check(
      "payments_review_resolution",
      sql`CASE WHEN ${t.reviewStatus} = 'resolved'
        THEN ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL
        ELSE ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.reviewNote} IS NULL
        END`,
    ),
    check(
      "payments_legacy_both_or_neither",
      sql`(${t.legacySource} IS NULL) = (${t.legacyId} IS NULL)`,
    ),
    check(
      "payments_legacy_only_migration",
      sql`${t.legacyId} IS NULL OR ${t.source} = 'migration'`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const paymentReversals = pgTable(
  "payment_reversals",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    /** The payment's customer (lets ledger rows reference the reversal with the customer). */
    customerId: uuid("customer_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
    reason: text("reason").notNull(),
    /** The Owner who reversed it (D-16). */
    actorId: uuid("actor_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    /** One reversal per payment (PLAN §7.2). */
    unique("payment_reversals_payment_unique").on(t.operatorId, t.paymentId),
    /** Targets of the ledger (with customer) and allocation (with payment) composite FKs. */
    unique("payment_reversals_operator_customer_id_unique").on(t.operatorId, t.customerId, t.id),
    unique("payment_reversals_operator_payment_id_unique").on(t.operatorId, t.paymentId, t.id),
    foreignKey({
      name: "payment_reversals_payment_fk",
      columns: [t.operatorId, t.customerId, t.paymentId],
      foreignColumns: [payments.operatorId, payments.customerId, payments.id],
    }),
    foreignKey({
      name: "payment_reversals_actor_fk",
      columns: [t.operatorId, t.actorId],
      foreignColumns: [users.operatorId, users.id],
    }),
    check("payment_reversals_reason_not_blank", notBlank(t.reason)),
    ...tenantPolicies(t),
  ],
).enableRLS();
