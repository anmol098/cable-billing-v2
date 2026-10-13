/**
 * Collection sessions and the cash handover (T-023, PLAN §7.2, §8.7; FR-022; J-05; the mobile
 * contract's `CollectionDay` / `Handover`, T-051).
 *
 * One row per lineman (collector) per IST business date: UNIQUE
 * `(operator_id, collector_id, business_date)`. The first payment of the day creates it
 * (`INSERT … ON CONFLICT DO NOTHING`), and every posting / reversal updates the running totals
 * (PLAN §8.4) in the same transaction:
 * - `cash_expected_paise` (cash only, not reversed), `upi_total_paise`, `payment_count`.
 *
 * The handover (PLAN §8.7): the lineman submits the cash handed over; the server stores a snapshot
 * of the expected cash at that moment (`handover_cash_expected_paise`; later syncs still move the
 * running total) and **`discrepancy_paise = cash_handed_over_paise − handover_cash_expected_paise`
 * (CHECK)**. A non-zero discrepancy needs a reason (`short | extra | pending_sync | other`, CHECK).
 * `handover_submission_id` is the phone's idempotency key for the latest submission.
 *
 * Status: `open` (no handover) → `submitted` → `accepted` (final) or `returned` (with the office's
 * note; the lineman submits again → `submitted`). The office's decision is `reviewed_by` /
 * `reviewed_at` / `review_note`.
 *
 * Triggers (custom migration): never deleted; the collector, date and tenant never change; once
 * `accepted`, only the running totals (late-synced or reversed payments) and `updated_at` change.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { users } from "./auth";
import { notBlank } from "./billing";

/** `collection_sessions.status` (PLAN §7.2; the contract's `HandoverStatus`). */
export const COLLECTION_SESSION_STATUSES = ["open", "submitted", "accepted", "returned"] as const;
export type CollectionSessionStatus = (typeof COLLECTION_SESSION_STATUSES)[number];
export const collectionSessionStatusEnum = pgEnum(
  "collection_session_status",
  COLLECTION_SESSION_STATUSES,
);

/** Why the handed-over cash differs (PLAN §8.7; the contract's `DiscrepancyReason`). */
export const DISCREPANCY_REASONS = ["short", "extra", "pending_sync", "other"] as const;
export type DiscrepancyReason = (typeof DISCREPANCY_REASONS)[number];
export const discrepancyReasonEnum = pgEnum("discrepancy_reason", DISCREPANCY_REASONS);

export const collectionSessions = pgTable(
  "collection_sessions",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    collectorId: uuid("collector_id").notNull(),
    /** IST business date (`BusinessDate`). */
    businessDate: date("business_date", { mode: "string" }).notNull(),
    /** Running server totals of the day's payments that are not reversed. */
    cashExpectedPaise: bigint("cash_expected_paise", { mode: "number" }).notNull().default(0),
    upiTotalPaise: bigint("upi_total_paise", { mode: "number" }).notNull().default(0),
    paymentCount: integer("payment_count").notNull().default(0),
    status: collectionSessionStatusEnum("status").notNull().default("open"),
    /** The latest handover (all NULL while `open`). */
    handoverSubmissionId: uuid("handover_submission_id"),
    handoverCashExpectedPaise: bigint("handover_cash_expected_paise", { mode: "number" }),
    cashHandedOverPaise: bigint("cash_handed_over_paise", { mode: "number" }),
    discrepancyPaise: bigint("discrepancy_paise", { mode: "number" }),
    discrepancyReason: discrepancyReasonEnum("discrepancy_reason"),
    /** The lineman's note. */
    handoverNote: text("handover_note"),
    /** Payments still on the phone at submission, as the phone reported them (office warning). */
    unsyncedPaymentCount: integer("unsynced_payment_count"),
    unsyncedCashPaise: bigint("unsynced_cash_paise", { mode: "number" }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    /** The office's decision (accepted / returned). */
    reviewedBy: uuid("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    unique("collection_sessions_collector_day_unique").on(
      t.operatorId,
      t.collectorId,
      t.businessDate,
    ),
    foreignKey({
      name: "collection_sessions_collector_fk",
      columns: [t.operatorId, t.collectorId],
      foreignColumns: [users.operatorId, users.id],
    }),
    foreignKey({
      name: "collection_sessions_reviewed_by_fk",
      columns: [t.operatorId, t.reviewedBy],
      foreignColumns: [users.operatorId, users.id],
    }),
    // The office's day view (T-062).
    index("collection_sessions_day_idx").on(t.operatorId, t.businessDate, t.status),
    check(
      "collection_sessions_totals_not_negative",
      sql`${t.cashExpectedPaise} >= 0 AND ${t.upiTotalPaise} >= 0 AND ${t.paymentCount} >= 0`,
    ),
    check(
      "collection_sessions_handover_iff_submitted",
      sql`CASE WHEN ${t.status} = 'open'
        THEN ${t.handoverSubmissionId} IS NULL AND ${t.handoverCashExpectedPaise} IS NULL
          AND ${t.cashHandedOverPaise} IS NULL AND ${t.discrepancyPaise} IS NULL
          AND ${t.discrepancyReason} IS NULL AND ${t.handoverNote} IS NULL
          AND ${t.unsyncedPaymentCount} IS NULL AND ${t.unsyncedCashPaise} IS NULL
          AND ${t.submittedAt} IS NULL
        ELSE ${t.handoverSubmissionId} IS NOT NULL AND ${t.handoverCashExpectedPaise} IS NOT NULL
          AND ${t.cashHandedOverPaise} IS NOT NULL AND ${t.discrepancyPaise} IS NOT NULL
          AND ${t.unsyncedPaymentCount} IS NOT NULL AND ${t.unsyncedCashPaise} IS NOT NULL
          AND ${t.submittedAt} IS NOT NULL
        END`,
    ),
    check(
      "collection_sessions_handover_amounts",
      sql`${t.handoverCashExpectedPaise} >= 0 AND ${t.cashHandedOverPaise} >= 0
        AND ${t.unsyncedPaymentCount} >= 0 AND ${t.unsyncedCashPaise} >= 0`,
    ),
    check(
      "collection_sessions_discrepancy_computed",
      sql`${t.discrepancyPaise} = ${t.cashHandedOverPaise} - ${t.handoverCashExpectedPaise}`,
    ),
    check(
      "collection_sessions_discrepancy_needs_reason",
      sql`${t.discrepancyPaise} IS NULL OR ${t.discrepancyPaise} = 0 OR ${t.discrepancyReason} IS NOT NULL`,
    ),
    check(
      "collection_sessions_review",
      sql`CASE WHEN ${t.status} IN ('accepted', 'returned')
        THEN ${t.reviewedBy} IS NOT NULL AND ${t.reviewedAt} IS NOT NULL
          AND (${t.status} = 'accepted' OR ${notBlank(t.reviewNote)})
        ELSE ${t.reviewedBy} IS NULL AND ${t.reviewedAt} IS NULL AND ${t.reviewNote} IS NULL
        END`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();
