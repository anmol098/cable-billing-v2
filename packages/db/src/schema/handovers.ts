/**
 * Cash handover history (T-062, PLAN §8.7, FR-022, J-05, B-016; PRD §9 "Collection session …
 * reconciliation and sign-off history").
 *
 * `collection_sessions` (T-023) holds the **latest** handover of a lineman's day: a resubmission
 * after "Return" overwrites it. **`handover_events`** keeps every step, append-only:
 * - `submitted`: one row per submission, with the snapshot the server computed at that moment
 *   (`cash_expected_paise`, `cash_handed_over_paise`, **`discrepancy_paise` = handed − expected
 *   (CHECK)**, `discrepancy_reason` (required when the discrepancy ≠ 0), the unsynced counts the
 *   phone reported and the lineman's `note`). `submission_id` is the phone's idempotency key:
 *   **UNIQUE per tenant among `submitted` rows**, so a retried or stale submission is recognised
 *   even after a newer one replaced it on the session.
 * - `accepted` / `returned`: the office's decision on one submission (`submission_id` = the
 *   submission reviewed; at most one decision per submission, partial UNIQUE). `note` is the
 *   office's note, required for `returned`. No amounts.
 *
 * `actor_id` is the lineman (submitted) or the owner/staff member (accepted/returned); `at` is the
 * server time of the step. Written by `packages/core/src/collections` in the same transaction as
 * the session change and the audit event. Never updated, deleted or truncated (custom migration,
 * `app.forbid_update_delete`, SQLSTATE CB001).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { users } from "./auth";
import { notBlank } from "./billing";
import { collectionSessions, discrepancyReasonEnum } from "./collections";

/** `handover_events.type`. */
export const HANDOVER_EVENT_TYPES = ["submitted", "accepted", "returned"] as const;
export type HandoverEventType = (typeof HANDOVER_EVENT_TYPES)[number];
export const handoverEventTypeEnum = pgEnum("handover_event_type", HANDOVER_EVENT_TYPES);

export const handoverEvents = pgTable(
  "handover_events",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    sessionId: uuid("session_id").notNull(),
    type: handoverEventTypeEnum("type").notNull(),
    /** The submission this row is (submitted) or decides on (accepted / returned). */
    submissionId: uuid("submission_id").notNull(),
    /** The lineman (submitted) or the office user (accepted / returned). */
    actorId: uuid("actor_id").notNull(),
    /** Submitted only: the server's snapshot at submission. */
    cashExpectedPaise: bigint("cash_expected_paise", { mode: "number" }),
    cashHandedOverPaise: bigint("cash_handed_over_paise", { mode: "number" }),
    discrepancyPaise: bigint("discrepancy_paise", { mode: "number" }),
    discrepancyReason: discrepancyReasonEnum("discrepancy_reason"),
    unsyncedPaymentCount: integer("unsynced_payment_count"),
    unsyncedCashPaise: bigint("unsynced_cash_paise", { mode: "number" }),
    /** The lineman's note (submitted) or the office's note (accepted / returned). */
    note: text("note"),
    /** Server time of the step. */
    at: timestamp("at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      name: "handover_events_session_fk",
      columns: [t.operatorId, t.sessionId],
      foreignColumns: [collectionSessions.operatorId, collectionSessions.id],
    }),
    foreignKey({
      name: "handover_events_actor_fk",
      columns: [t.operatorId, t.actorId],
      foreignColumns: [users.operatorId, users.id],
    }),
    // The phone's idempotency key: one submitted row per submission id in the tenant.
    uniqueIndex("handover_events_submission_unique")
      .on(t.operatorId, t.submissionId)
      .where(sql`${t.type} = 'submitted'`),
    // One office decision per submission (double "Accept" can't record twice).
    uniqueIndex("handover_events_one_decision")
      .on(t.operatorId, t.submissionId)
      .where(sql`${t.type} <> 'submitted'`),
    // A session's history in order (the review screen, T-081's handover report).
    index("handover_events_session_idx").on(t.operatorId, t.sessionId, t.at),
    check(
      "handover_events_snapshot_iff_submitted",
      sql`CASE WHEN ${t.type} = 'submitted'
        THEN ${t.cashExpectedPaise} IS NOT NULL AND ${t.cashHandedOverPaise} IS NOT NULL
          AND ${t.discrepancyPaise} IS NOT NULL AND ${t.unsyncedPaymentCount} IS NOT NULL
          AND ${t.unsyncedCashPaise} IS NOT NULL
        ELSE ${t.cashExpectedPaise} IS NULL AND ${t.cashHandedOverPaise} IS NULL
          AND ${t.discrepancyPaise} IS NULL AND ${t.discrepancyReason} IS NULL
          AND ${t.unsyncedPaymentCount} IS NULL AND ${t.unsyncedCashPaise} IS NULL
        END`,
    ),
    check(
      "handover_events_amounts_not_negative",
      sql`${t.cashExpectedPaise} >= 0 AND ${t.cashHandedOverPaise} >= 0
        AND ${t.unsyncedPaymentCount} >= 0 AND ${t.unsyncedCashPaise} >= 0`,
    ),
    check(
      "handover_events_discrepancy_computed",
      sql`${t.discrepancyPaise} = ${t.cashHandedOverPaise} - ${t.cashExpectedPaise}`,
    ),
    check(
      "handover_events_discrepancy_needs_reason",
      sql`${t.discrepancyPaise} IS NULL OR ${t.discrepancyPaise} = 0 OR ${t.discrepancyReason} IS NOT NULL`,
    ),
    check(
      "handover_events_returned_needs_note",
      sql`${t.type} <> 'returned' OR ${notBlank(t.note)}`,
    ),
    check("handover_events_note_not_blank", sql`${t.note} IS NULL OR ${notBlank(t.note)}`),
    ...tenantPolicies(t),
  ],
).enableRLS();
