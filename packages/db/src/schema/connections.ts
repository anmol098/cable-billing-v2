/**
 * Connections (T-022, PLAN §7.2, FR-005, FR-006, BR-03 to BR-05, RULE-06, RULE-07): VC assets, the
 * time-bounded assignment of a VC to a customer, and each assignment's status/plan timeline.
 *
 * **`vc_assets`**: the physical/logical VC (viewing card) number, reusable after disconnection.
 * `UNIQUE (operator_id, vc_number_norm)`: one asset per number per operator; the same number may
 * exist at another operator. `vc_number_norm` is a stored generated column; {@link normalizeVcNumber}
 * is the same function in TypeScript (look-ups, friendly errors):
 * 1. every ASCII whitespace character and every `-` is removed (printed cards group digits:
 *    "0001 2345-6789" is the card "000123456789");
 * 2. ASCII `a`–`z` become upper case. Leading zeros and everything else are kept.
 * `lifecycle_status`: `in_service` (can be assigned) or `retired` (lost/damaged/returned; kept for
 * history). Whether a VC is *in use* is not stored here: it follows from its assignments.
 *
 * **`vc_assignments`**: one row per period a VC belongs to a customer. Reusing a VC creates a new
 * row (new identity) for the new customer; the old row, its invoice lines and payments stay with the
 * old customer (RULE-07, PRD §15 #6). Dates are IST business dates:
 * - `start_date`: the first day of service (active from the start of that day).
 * - `end_date`: the **last day of service, inclusive**, i.e. the disconnection's effective date
 *   (T-040 `AssignmentTimeline.endDate`); NULL while not disconnected. It is set exactly when
 *   `status = 'disconnected'`.
 * - No overlap (RULE-06, BR-03): the custom migration adds
 *   `EXCLUDE USING gist (operator_id WITH =, vc_asset_id WITH =, daterange(start_date, end_date, '[]') WITH &&)`
 *   (`vc_assignments_no_overlap`, SQLSTATE 23P01). A NULL end is unbounded. Because both ends are
 *   inclusive, a VC disconnected effective D can start its next assignment on D + 1 at the
 *   earliest; starting it on D itself (the old customer is still served that day) is rejected.
 * - `status` is the status after the latest recorded event (`active | suspended | disconnected`);
 *   which status applied on a given date is computed from the events (T-040 `assignmentStatusOn`).
 * - `plan_id` / `rental_amount_paise`: the current plan (NULL for a custom amount) and the current
 *   monthly rental, copied from the plan when assigned, so plan edits never change it (FR-007).
 *   `plan_changed` events keep the history.
 * - `history_limited`: set by the legacy migration on the one known current assignment it imports
 *   (RULE-21: earlier assignment history is unknown and is not invented).
 * - Only `status`, `end_date`, `plan_id`, `rental_amount_paise`, `history_limited`, `updated_at`
 *   and the legacy columns may change; the VC, the customer, the start date, the id and the tenant
 *   never do, and rows are never deleted (trigger in the custom migration).
 *
 * **`assignment_events`**: append-only timeline (FR-006), one row per change, mapping one to one to
 * T-040's `AssignmentEvent`: `type`, `effective_date` (IST business date), and for `plan_changed`
 * the from/to plan and rental (`to_rental_paise` = `rentalPaise`; the first event's
 * `from_rental_paise` = `initialRentalPaise`). Recorded order is `(at, id)`. At most one
 * `activated` (on the start date) and one `disconnected` event per assignment (partial unique
 * indexes). Transition rules (no reactivate after disconnect, …) are validated by T-040/T-034.
 */
import { ASSIGNMENT_EVENT_TYPES } from "@cb/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { users } from "./auth";
import { asciiUpper, customers, MAX_CODE_LENGTH, SQL_ASCII_UPPER_ARGS } from "./customers";
import { plans } from "./plans";
import { operators } from "./tenancy";

/** `in_service`: may be assigned. `retired`: removed from service, kept for history. */
export const VC_LIFECYCLE_STATUSES = ["in_service", "retired"] as const;
export type VcLifecycleStatus = (typeof VC_LIFECYCLE_STATUSES)[number];
export const vcLifecycleStatusEnum = pgEnum("vc_lifecycle_status", VC_LIFECYCLE_STATUSES);

/** The status of a VC assignment after its latest event (FR-006). */
export const ASSIGNMENT_STATUSES = ["active", "suspended", "disconnected"] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const assignmentStatusEnum = pgEnum("assignment_status", ASSIGNMENT_STATUSES);

/** `assignment_events.type`: the values of `@cb/domain`'s `ASSIGNMENT_EVENT_TYPES` (T-040). */
export const assignmentEventTypeEnum = pgEnum("assignment_event_type", ASSIGNMENT_EVENT_TYPES);

/**
 * The VC number as the database stores it in `vc_number_norm` (see the module comment). Kept
 * identical to the generated column's expression; `connections.test.ts` checks both agree.
 */
export function normalizeVcNumber(vcNumber: string): string {
  return asciiUpper(vcNumber.replace(/[- \t\n\r\f\v]+/g, ""));
}

export const vcAssets = pgTable(
  "vc_assets",
  {
    id: primaryId(),
    operatorId: operatorIdColumn().references(() => operators.id),
    /** As entered (shown to users). */
    vcNumber: text("vc_number").notNull(),
    /** {@link normalizeVcNumber}(vc_number), generated by the database. */
    vcNumberNorm: text("vc_number_norm")
      .notNull()
      .generatedAlwaysAs(
        sql.raw(
          `translate(regexp_replace("vc_number", '[- \\t\\n\\r\\f\\v]+', '', 'g'), ${SQL_ASCII_UPPER_ARGS})`,
        ),
      ),
    lifecycleStatus: vcLifecycleStatusEnum("lifecycle_status").notNull().default("in_service"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    tenantKey(t),
    unique("vc_assets_operator_number_unique").on(t.operatorId, t.vcNumberNorm),
    uniqueIndex("vc_assets_operator_legacy_unique")
      .on(t.operatorId, t.legacySource, t.legacyId)
      .where(sql`${t.legacyId} IS NOT NULL`),
    // Search by VC number prefix (equality uses the unique constraint's index).
    index("vc_assets_number_prefix_idx").on(t.operatorId, t.vcNumberNorm.op("text_pattern_ops")),
    check(
      "vc_assets_number_valid",
      sql`${t.vcNumberNorm} <> '' AND char_length(${t.vcNumberNorm}) <= ${sql.raw(String(MAX_CODE_LENGTH))}`,
    ),
    check(
      "vc_assets_legacy_both_or_neither",
      sql`(${t.legacySource} IS NULL) = (${t.legacyId} IS NULL)`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const vcAssignments = pgTable(
  "vc_assignments",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    vcAssetId: uuid("vc_asset_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    /** First day of service (IST business date, `BusinessDate`). */
    startDate: date("start_date", { mode: "string" }).notNull(),
    /** Last day of service, inclusive (the disconnection's effective date). NULL while open. */
    endDate: date("end_date", { mode: "string" }),
    status: assignmentStatusEnum("status").notNull().default("active"),
    /** The current plan; NULL when the rental is a custom amount. */
    planId: uuid("plan_id"),
    /** The current monthly rental in paise (a copy, so plan edits never change it). */
    rentalAmountPaise: bigint("rental_amount_paise", { mode: "number" }).notNull(),
    /** Imported current assignment whose earlier history is unknown (RULE-21, T-092). */
    historyLimited: boolean("history_limited").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    tenantKey(t),
    uniqueIndex("vc_assignments_operator_legacy_unique")
      .on(t.operatorId, t.legacySource, t.legacyId)
      .where(sql`${t.legacyId} IS NOT NULL`),
    foreignKey({
      name: "vc_assignments_vc_asset_fk",
      columns: [t.operatorId, t.vcAssetId],
      foreignColumns: [vcAssets.operatorId, vcAssets.id],
    }),
    foreignKey({
      name: "vc_assignments_customer_fk",
      columns: [t.operatorId, t.customerId],
      foreignColumns: [customers.operatorId, customers.id],
    }),
    foreignKey({
      name: "vc_assignments_plan_fk",
      columns: [t.operatorId, t.planId],
      foreignColumns: [plans.operatorId, plans.id],
    }),
    index("vc_assignments_customer_idx").on(t.operatorId, t.customerId),
    index("vc_assignments_vc_asset_idx").on(t.operatorId, t.vcAssetId, t.startDate),
    index("vc_assignments_plan_idx").on(t.operatorId, t.planId),
    check(
      "vc_assignments_end_not_before_start",
      sql`${t.endDate} IS NULL OR ${t.endDate} >= ${t.startDate}`,
    ),
    check(
      "vc_assignments_end_iff_disconnected",
      sql`(${t.status} = 'disconnected') = (${t.endDate} IS NOT NULL)`,
    ),
    check("vc_assignments_rental_not_negative", sql`${t.rentalAmountPaise} >= 0`),
    check(
      "vc_assignments_legacy_both_or_neither",
      sql`(${t.legacySource} IS NULL) = (${t.legacyId} IS NULL)`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const assignmentEvents = pgTable(
  "assignment_events",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    assignmentId: uuid("assignment_id").notNull(),
    type: assignmentEventTypeEnum("type").notNull(),
    /** IST business date the change takes effect (`BusinessDate`). */
    effectiveDate: date("effective_date", { mode: "string" }).notNull(),
    /** `plan_changed` only: the plan before / after (NULL = custom amount). */
    fromPlanId: uuid("from_plan_id"),
    toPlanId: uuid("to_plan_id"),
    /** `plan_changed` only (required there): the monthly rental before / after, in paise. */
    fromRentalPaise: bigint("from_rental_paise", { mode: "number" }),
    toRentalPaise: bigint("to_rental_paise", { mode: "number" }),
    /** Why (e.g. the disconnection reason). Free text, optional. */
    reason: text("reason"),
    /** Who recorded it; NULL for system/migration rows. */
    actorId: uuid("actor_id"),
    /** When it was recorded (the recorded order is `at, id`). */
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      name: "assignment_events_assignment_fk",
      columns: [t.operatorId, t.assignmentId],
      foreignColumns: [vcAssignments.operatorId, vcAssignments.id],
    }),
    foreignKey({
      name: "assignment_events_from_plan_fk",
      columns: [t.operatorId, t.fromPlanId],
      foreignColumns: [plans.operatorId, plans.id],
    }),
    foreignKey({
      name: "assignment_events_to_plan_fk",
      columns: [t.operatorId, t.toPlanId],
      foreignColumns: [plans.operatorId, plans.id],
    }),
    foreignKey({
      name: "assignment_events_actor_fk",
      columns: [t.operatorId, t.actorId],
      foreignColumns: [users.operatorId, users.id],
    }),
    index("assignment_events_assignment_idx").on(t.operatorId, t.assignmentId, t.at, t.id),
    uniqueIndex("assignment_events_one_activation")
      .on(t.operatorId, t.assignmentId)
      .where(sql`${t.type} = 'activated'`),
    uniqueIndex("assignment_events_one_disconnection")
      .on(t.operatorId, t.assignmentId)
      .where(sql`${t.type} = 'disconnected'`),
    check(
      "assignment_events_plan_values",
      sql`CASE WHEN ${t.type} = 'plan_changed'
        THEN ${t.fromRentalPaise} IS NOT NULL AND ${t.toRentalPaise} IS NOT NULL
        ELSE ${t.fromPlanId} IS NULL AND ${t.toPlanId} IS NULL
          AND ${t.fromRentalPaise} IS NULL AND ${t.toRentalPaise} IS NULL
        END`,
    ),
    check(
      "assignment_events_rental_not_negative",
      sql`${t.fromRentalPaise} >= 0 AND ${t.toRentalPaise} >= 0`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();
