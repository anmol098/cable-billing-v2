/**
 * Tenancy (T-021, PLAN §7.2): `operators` (the tenants) and `areas`.
 *
 * - `operators.id` is the tenant id (`operator_id` everywhere else). It is the immutable internal
 *   identity of a tenant (FR-002): names are not unique, so two operators called
 *   "ANMOL CABLE NETWORK" are two tenants. A trigger (custom migration) rejects changing the id and
 *   deleting an operator, for every role (tenant data is never deleted, FR-025).
 * - `operators` has no `operator_id` column, so its policies are written here: `app_rw` sees,
 *   creates and updates only the row whose `id` is the current tenant (provisioning runs inside
 *   `withTenant(newOperatorId)`), and `app_platform` may list all operators (jobs, admin console).
 * - `settings` is jsonb validated by {@link operatorSettingsSchema} (and partly by a CHECK).
 */

import { MID_MONTH_START_POLICIES } from "@cb/domain";
import { sql } from "drizzle-orm";
import {
  check,
  jsonb,
  pgEnum,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import * as z from "zod";
import { primaryId } from "../ids";
import {
  appPlatform,
  appRw,
  currentOperator,
  operatorIdColumn,
  tenantKey,
  tenantPolicies,
} from "../rls";

/** UI languages (D-06): Hindi is the Android default, English the web default. */
export const LANGUAGES = ["hi", "en"] as const;
export type Language = (typeof LANGUAGES)[number];
export const languageEnum = pgEnum("language", LANGUAGES);

/** `active`, or `suspended` by the platform admin (e.g. abuse). Not the subscription state. */
export const OPERATOR_STATUSES = ["active", "suspended"] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];
export const operatorStatusEnum = pgEnum("operator_status", OPERATOR_STATUSES);

/**
 * `operators.settings` (jsonb, snake_case keys). Parse every read with
 * {@link parseOperatorSettings}: missing keys get their defaults, unknown keys are dropped, so new
 * settings can be added with a default and no data migration. Limits match the mobile contract's
 * `OperatorInfo` (office_phone ≤ 20, digits with an optional leading +; receipt_footer ≤ 500).
 */
export const operatorSettingsSchema = z.object({
  /** D-18 (values from @cb/domain, T-042). Default: start billing from the next month. */
  mid_month_start_policy: z.enum(MID_MONTH_START_POLICIES).default("start_next_month"),
  /** Invoice number prefix: `{prefix}-{YYMM}-{seq:05}` (PLAN §7.3). Upper-case letters/digits. */
  invoice_prefix: z
    .string()
    .regex(/^[A-Z0-9]{1,8}$/)
    .default("INV"),
  /** Printed at the bottom of receipts. Null for none. */
  receipt_footer: z.string().max(500).nullable().default(null),
  /** "Call office" number in the lineman app and on receipts. Null: not set. */
  office_phone: z
    .string()
    .regex(/^\+?[0-9]{6,19}$/)
    .nullable()
    .default(null),
  /** Default language for the operator's receipts and new users. */
  default_language: z.enum(LANGUAGES).default("hi"),
});

export type OperatorSettings = z.output<typeof operatorSettingsSchema>;
export type OperatorSettingsInput = z.input<typeof operatorSettingsSchema>;

/** Validates settings (from the DB or from a form) and fills defaults. Throws a ZodError if invalid. */
export function parseOperatorSettings(value: unknown): OperatorSettings {
  return operatorSettingsSchema.parse(value ?? {});
}

/** The settings a new operator starts with. */
export const DEFAULT_OPERATOR_SETTINGS: OperatorSettings = Object.freeze(parseOperatorSettings({}));

export const operators = pgTable(
  "operators",
  {
    /** The tenant id. Generated in the app (`uuidv7()`), never changes. */
    id: primaryId(),
    /** Business name. Not unique (FR-002). */
    name: text("name").notNull(),
    phone: text("phone"),
    address: text("address"),
    settings: jsonb("settings")
      .$type<OperatorSettings>()
      .notNull()
      .default(DEFAULT_OPERATOR_SETTINGS),
    status: operatorStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    check("operators_name_not_blank", sql`btrim(${t.name}) <> ''`),
    check(
      "operators_settings_valid",
      sql`jsonb_typeof(${t.settings}) = 'object'
        AND (${t.settings} ->> 'mid_month_start_policy') IN ('charge_full_month', 'start_next_month')
        AND (${t.settings} ->> 'default_language') IN ('hi', 'en')`,
    ),
    // The tenant itself (provisioning inserts it inside withTenant(newId)). No DELETE policy.
    pgPolicy("operators_tenant_select", {
      for: "select",
      to: appRw,
      using: sql`${t.id} = ${currentOperator}`,
    }),
    pgPolicy("operators_tenant_insert", {
      for: "insert",
      to: appRw,
      withCheck: sql`${t.id} = ${currentOperator}`,
    }),
    pgPolicy("operators_tenant_update", {
      for: "update",
      to: appRw,
      using: sql`${t.id} = ${currentOperator}`,
      withCheck: sql`${t.id} = ${currentOperator}`,
    }),
    // Platform jobs and the admin console list tenants (README "What withPlatform may do").
    pgPolicy("operators_platform_select", { for: "select", to: appPlatform, using: sql`true` }),
  ],
).enableRLS();

export const areas = pgTable(
  "areas",
  {
    id: primaryId(),
    operatorId: operatorIdColumn().references(() => operators.id),
    name: text("name").notNull(),
    /** Archived areas stay attached to their customers but are hidden from pickers (T-030). */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    tenantKey(t),
    uniqueIndex("areas_operator_name_unique").on(t.operatorId, sql`lower(${t.name})`),
    check("areas_name_not_blank", sql`btrim(${t.name}) <> ''`),
    ...tenantPolicies(t),
  ],
).enableRLS();
