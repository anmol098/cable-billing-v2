/**
 * Rental plans (T-022, PLAN §7.2, FR-007, BR-05).
 *
 * A plan is an operator-defined monthly amount. A connection (`vc_assignments`, connections.ts)
 * copies the amount into its own `rental_amount_paise` when the plan is assigned, and invoices copy
 * it again into their lines, so **editing a plan never changes an issued invoice** or an existing
 * connection's rental (FR-007). Applying a new amount to existing connections is an explicit plan
 * change per connection (T-045), never a side effect of editing the plan.
 *
 * - `status`: `active` plans can be given to new connections; `retired` plans stay attached to the
 *   connections that have them but are hidden from pickers (T-031). Plans are never deleted
 *   (trigger in the custom migration): retire them instead.
 * - Names are unique per operator among **active** plans (case- and space-insensitive), so a
 *   low-literacy operator never sees two "Basic" plans to choose from. A retired plan may share a
 *   name with an active one (retire "Basic ₹300", create a new "Basic ₹350").
 * - `monthly_amount_paise` may be 0 (free connections exist; T-040 bills a ₹0 line).
 */
import { sql } from "drizzle-orm";
import { bigint, check, pgEnum, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { operators } from "./tenancy";

/** `active` (can be assigned) or `retired` (kept for history, hidden from pickers). */
export const PLAN_STATUSES = ["active", "retired"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const planStatusEnum = pgEnum("plan_status", PLAN_STATUSES);

export const plans = pgTable(
  "plans",
  {
    id: primaryId(),
    operatorId: operatorIdColumn().references(() => operators.id),
    name: text("name").notNull(),
    /** Monthly rental in integer paise (D-17: the UI shows whole rupees). */
    monthlyAmountPaise: bigint("monthly_amount_paise", { mode: "number" }).notNull(),
    status: planStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    tenantKey(t),
    uniqueIndex("plans_operator_active_name_unique")
      .on(t.operatorId, sql`lower(btrim(${t.name}))`)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("plans_operator_legacy_unique")
      .on(t.operatorId, t.legacySource, t.legacyId)
      .where(sql`${t.legacyId} IS NOT NULL`),
    check("plans_name_not_blank", sql`btrim(${t.name}) <> ''`),
    check("plans_amount_not_negative", sql`${t.monthlyAmountPaise} >= 0`),
    check(
      "plans_legacy_both_or_neither",
      sql`(${t.legacySource} IS NULL) = (${t.legacyId} IS NULL)`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();
