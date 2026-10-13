/**
 * Audit trail (T-021, FR-024, PLAN §7.2): who did what to which entity, with before/after values.
 *
 * - Append-only for every role, owner included (custom migration with `appendOnlyTriggerSql`).
 * - Tenant events have `operator_id`; platform events (admin console, sign-up abuse handling)
 *   have none. `app_rw` sees only its tenant's events (T-035 viewer); `app_platform` may write and
 *   read only events without a tenant, never a tenant's diffs.
 * - Writers (T-025 `defineService`) redact sensitive fields (passwords, tokens, full KYC) before
 *   they reach `before`/`after`; the table stores what it is given.
 * - `action` is dotted snake_case (`payment.reverse`), `entity_type` snake_case (`customer`).
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  inet,
  jsonb,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { appPlatform, tenantPolicies } from "../rls";
import { userRoleEnum, users } from "./auth";
import { operators } from "./tenancy";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: primaryId(),
    /** The tenant the event belongs to; NULL for platform-level events. */
    operatorId: uuid("operator_id").references(() => operators.id),
    /** Who did it; NULL for the system (jobs, webhooks). */
    actorId: uuid("actor_id").references(() => users.id),
    /** The actor's role at the time (roles can change later). NULL for the system. */
    actorRole: userRoleEnum("actor_role"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Keyset pagination, newest first (T-035), and the viewer's filters.
    index("audit_events_operator_at_idx").on(t.operatorId, t.at.desc(), t.id.desc()),
    index("audit_events_operator_entity_idx").on(t.operatorId, t.entityType, t.entityId, t.at),
    index("audit_events_operator_actor_idx").on(t.operatorId, t.actorId, t.at),
    check("audit_events_actor_consistent", sql`(${t.actorId} IS NULL) = (${t.actorRole} IS NULL)`),
    check(
      "audit_events_action_format",
      sql`${t.action} ~ '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$'`,
    ),
    check("audit_events_entity_type_format", sql`${t.entityType} ~ '^[a-z][a-z0-9_]*$'`),
    ...tenantPolicies(t),
    pgPolicy("audit_events_platform_select", {
      for: "select",
      to: appPlatform,
      using: sql`${t.operatorId} IS NULL`,
    }),
    pgPolicy("audit_events_platform_insert", {
      for: "insert",
      to: appPlatform,
      withCheck: sql`${t.operatorId} IS NULL`,
    }),
  ],
).enableRLS();
