/**
 * Payment sync metrics (T-086a; PRD §16 "Payment sync success rate" and "Duplicate prevention
 * count"; PLAN §10.4). Counts only: no amounts, names, phone numbers, notes or customer ids.
 *
 * **`payment_sync_batches`**: one row per `/payments:batch` request the server answered (T-061),
 * in the tenant, with how many items got each answer. Written once, after the batch, in the
 * tenant's transaction (`@cb/core` `recordPaymentSyncBatch`), so a batch is counted once however
 * its items were answered. The platform reads the counts (and only the counts) for the admin
 * console, through the column grant in `PLATFORM_READ_COLUMNS` (`./platform-admin.ts`).
 * - Every answer by kind: `posted`, `posted_needs_review`, `duplicate` (an idempotent replay of a
 *   payment already saved: the duplicate prevention count), `rejected_*` by error code, and
 *   `retry_later_*` by error code. They add up to `items` (CHECK).
 * - Deduplicated by payment id (PRD §16): a payment id is posted once (T-046 idempotency), so
 *   `posted + posted_needs_review` counts each accepted id once. `rejected_new_ids` counts the
 *   rejected ids never answered before (a first refusal, recorded in `payment_sync_rejections`),
 *   and `accepted_after_rejection` the accepted ids that had been rejected earlier, with
 *   `accepted_after_rejection_by_day` splitting them by the IST day of that earlier refusal. Over
 *   a window of days, accepted ids ÷ (accepted ids + rejected_new_ids − the accepted-after-
 *   rejection ids whose refusal day is inside the window) is the rate over distinct payment ids
 *   that got a final answer in the window (a refusal older than the window is not in
 *   `rejected_new_ids` there, so it must not be subtracted either). A replay of a rejected id (the
 *   phone lost the answer and sent the batch again) is in `rejected_*` but not in
 *   `rejected_new_ids`. `rejected_without_id` items had no usable id, so they can't be
 *   deduplicated.
 *
 * **`payment_sync_rejections`**: the dedupe key for refusals: one row per rejected payment id per
 * tenant (the first refusal's code and time). Tenant-only: the platform has no access to it. It is
 * in effect a per-payment-id log of refusals (no amount, name, phone or customer): keeping it, and
 * for how long, is a product call (follow-up T-086f).
 *
 * Both tables are **append-only** (custom migration): a count, once recorded, is never edited.
 */
import { sql } from "drizzle-orm";
import {
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { operators } from "./tenancy";

/** Item error codes that make a payment `rejected` (T-061; the phone stops sending it). */
export const PAYMENT_SYNC_REJECT_CODES = [
  "VALIDATION",
  "CUSTOMER_NOT_FOUND",
  "ID_REUSED_WITH_DIFFERENT_DATA",
] as const;
export type PaymentSyncRejectCode = (typeof PAYMENT_SYNC_REJECT_CODES)[number];

/** Item error codes that make a payment `retry_later` (T-061; the phone sends it again). */
export const PAYMENT_SYNC_RETRY_CODES = ["CONFLICT", "INTERNAL", "RATE_LIMITED"] as const;
export type PaymentSyncRetryCode = (typeof PAYMENT_SYNC_RETRY_CODES)[number];

/** Most items in one batch (the contract's `PAYMENT_BATCH_MAX`). */
export const PAYMENT_SYNC_BATCH_MAX = 50;

const count = (name: string) => integer(name).notNull().default(0);

export const paymentSyncBatches = pgTable(
  "payment_sync_batches",
  {
    id: primaryId(),
    operatorId: operatorIdColumn().references(() => operators.id),
    /** The IST business day the server answered the batch. */
    businessDate: date("business_date", { mode: "string" }).notNull(),
    /** When the server answered it (runtime clock). */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    /** Items in the batch (1–50). */
    items: integer("items").notNull(),
    posted: count("posted"),
    postedNeedsReview: count("posted_needs_review"),
    /** Idempotent replays of a payment already saved (PRD §16 duplicate prevention). */
    duplicate: count("duplicate"),
    rejectedValidation: count("rejected_validation"),
    rejectedCustomerNotFound: count("rejected_customer_not_found"),
    rejectedIdReused: count("rejected_id_reused"),
    /** Rejected items without a usable payment id (never deduplicated). */
    rejectedWithoutId: count("rejected_without_id"),
    /** Rejected payment ids answered for the first time (not a replay, not a saved payment). */
    rejectedNewIds: count("rejected_new_ids"),
    /** Accepted payment ids that had been rejected before. */
    acceptedAfterRejection: count("accepted_after_rejection"),
    /**
     * `accepted_after_rejection` by the IST day of the earlier refusal (`YYYY-MM-DD` → count), so
     * a window only subtracts refusals it also counts.
     */
    acceptedAfterRejectionByDay: jsonb("accepted_after_rejection_by_day")
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    retryLaterConflict: count("retry_later_conflict"),
    retryLaterInternal: count("retry_later_internal"),
    retryLaterRateLimited: count("retry_later_rate_limited"),
  },
  (t) => [
    tenantKey(t),
    index("payment_sync_batches_date_idx").on(t.businessDate),
    index("payment_sync_batches_operator_date_idx").on(t.operatorId, t.businessDate),
    check(
      "payment_sync_batches_items_range",
      sql`${t.items} BETWEEN 1 AND ${sql.raw(String(PAYMENT_SYNC_BATCH_MAX))}`,
    ),
    check(
      "payment_sync_batches_counts_not_negative",
      sql`LEAST(${t.posted}, ${t.postedNeedsReview}, ${t.duplicate}, ${t.rejectedValidation},
        ${t.rejectedCustomerNotFound}, ${t.rejectedIdReused}, ${t.rejectedWithoutId},
        ${t.rejectedNewIds}, ${t.acceptedAfterRejection}, ${t.retryLaterConflict},
        ${t.retryLaterInternal}, ${t.retryLaterRateLimited}) >= 0`,
    ),
    check(
      "payment_sync_batches_counts_add_up",
      sql`${t.items} = ${t.posted} + ${t.postedNeedsReview} + ${t.duplicate}
        + ${t.rejectedValidation} + ${t.rejectedCustomerNotFound} + ${t.rejectedIdReused}
        + ${t.rejectedWithoutId} + ${t.retryLaterConflict} + ${t.retryLaterInternal}
        + ${t.retryLaterRateLimited}`,
    ),
    check(
      "payment_sync_batches_new_ids_within_rejected",
      sql`${t.rejectedNewIds} <= ${t.rejectedValidation} + ${t.rejectedCustomerNotFound} + ${t.rejectedIdReused}`,
    ),
    check(
      "payment_sync_batches_after_rejection_within_accepted",
      sql`${t.acceptedAfterRejection} <= ${t.posted} + ${t.postedNeedsReview}`,
    ),
    check(
      "payment_sync_batches_after_rejection_by_day_object",
      sql`jsonb_typeof(${t.acceptedAfterRejectionByDay}) = 'object'`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const paymentSyncRejections = pgTable(
  "payment_sync_rejections",
  {
    /** The rejected payment's id (the phone's idempotency key; unique per operator). */
    id: uuid("id").notNull(),
    operatorId: operatorIdColumn().references(() => operators.id),
    /** The first refusal's code. */
    code: text("code").$type<PaymentSyncRejectCode>().notNull(),
    /** When it was first refused (runtime clock). */
    firstRejectedAt: timestamp("first_rejected_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: "payment_sync_rejections_pkey", columns: [t.operatorId, t.id] }),
    check(
      "payment_sync_rejections_code_known",
      sql`${t.code} IN (${sql.raw(PAYMENT_SYNC_REJECT_CODES.map((c) => `'${c}'`).join(", "))})`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();
