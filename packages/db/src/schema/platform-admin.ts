/**
 * Platform admin console (T-086, PLAN §9.4, §12.4, §13; PRD §3, §16; FR-025).
 *
 * The rule (PRD §3): the platform admin sees **platform metadata**, and tenant data only through
 * **explicitly authorized, time-boxed support access**; there is no routine access to a tenant's
 * financial data. This module holds everything the database adds for that, in one reviewed place:
 *
 * **`support_access_grants`**: one row per support access an admin opened on one tenant, with the
 * reason (required) and a hard expiry at most {@link SUPPORT_ACCESS_MAX_MINUTES} after the grant
 * (CHECK). Written in the **tenant's** transaction together with a tenant audit event, so the Owner
 * sees every grant in their audit log (T-035). Append-only except ending it early (`ended_at`,
 * `ended_by`): the expiry can never be moved, and ending is final
 * ({@link SUPPORT_GRANT_END_FINAL_SQL}): once `ended_at` is set, neither it nor `ended_by` changes
 * again, so an ended grant can't be reopened (set back to NULL) or its end moved. The support view
 * checks the grant (not ended, not expired at the server's clock) on every request, inside the
 * same tenant transaction it reads in.
 *
 * **`subscription_offline_payments`**: our SaaS fee paid outside Razorpay (bank transfer, cash,
 * UPI to our account, cheque), recorded by an admin (PLAN §13 "The admin can record an offline
 * payment"). A money record, so fully append-only; a mistake is corrected by recording what really
 * happened in a note on a new row and telling the reviewer (no reversal flow yet). The row and the
 * subscription extension it causes are written in one tenant transaction.
 *
 * **Platform read policies** (`app_platform` SELECT, see {@link PLATFORM_READ_COLUMNS}): the
 * console's lists and PRD §16 metrics are aggregates over a few tenant tables. Each gets a
 * `USING (true)` SELECT policy for `app_platform` **and** a column-level grant: the migration
 * revokes the table-wide SELECT the default privileges gave `app_platform` and grants SELECT on
 * the listed columns only. So the platform role can count customers by status, but `SELECT *`,
 * names, phones, amounts and free text are refused by the database itself (`permission denied`),
 * whatever the application code does. `src/schema/platform-admin.test.ts` checks the catalog
 * matches {@link PLATFORM_READ_COLUMNS} exactly.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { appPlatform, operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { users } from "./auth";
import { billingRunItems, billingRuns, notBlank } from "./billing";
import { collectionSessions } from "./collections";
import { customers } from "./customers";
import { invariantChecks } from "./invariants";
import { receiptActions } from "./receipts";
import { paymentSyncBatches } from "./sync-metrics";
import { operators } from "./tenancy";

/** Longest support access, in minutes (PLAN §9.4: "time-boxed, e.g. 2 h"). Enforced by CHECK. */
export const SUPPORT_ACCESS_MAX_MINUTES = 120;
/** Shortest and longest reason, in characters (trimmed). */
export const SUPPORT_REASON_MIN_LENGTH = 10;
export const SUPPORT_REASON_MAX_LENGTH = 500;

export const supportAccessGrants = pgTable(
  "support_access_grants",
  {
    id: primaryId(),
    operatorId: operatorIdColumn().references(() => operators.id),
    /** The platform admin who opened it (users.operator_id IS NULL). */
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => users.id),
    /** Why (shown to the Owner in their audit log). */
    reason: text("reason").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull(),
    /** Hard end. Never moved (append-only). */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Ended early by an admin. Final once set (never cleared or moved). */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    endedBy: uuid("ended_by").references(() => users.id),
  },
  (t) => [
    tenantKey(t),
    index("support_access_grants_lookup_idx").on(t.operatorId, t.adminUserId, t.expiresAt),
    index("support_access_grants_expires_idx").on(t.expiresAt),
    check(
      "support_access_grants_reason_length",
      sql`${notBlank(t.reason)} AND char_length(btrim(${t.reason})) BETWEEN ${sql.raw(
        String(SUPPORT_REASON_MIN_LENGTH),
      )} AND ${sql.raw(String(SUPPORT_REASON_MAX_LENGTH))}`,
    ),
    check(
      "support_access_grants_time_box",
      sql`${t.expiresAt} > ${t.grantedAt}
        AND ${t.expiresAt} <= ${t.grantedAt} + interval '${sql.raw(String(SUPPORT_ACCESS_MAX_MINUTES))} minutes'`,
    ),
    check(
      "support_access_grants_ended_together",
      sql`(${t.endedAt} IS NULL) = (${t.endedBy} IS NULL)`,
    ),
    check(
      "support_access_grants_ended_after_grant",
      sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.grantedAt}`,
    ),
    ...tenantPolicies(t),
    // The console lists grants (who has access where, until when). Writes happen in the tenant's
    // transaction (with the tenant audit event), so the platform role only reads.
    pgPolicy("support_access_grants_platform_select", {
      for: "select",
      to: appPlatform,
      using: sql`true`,
    }),
  ],
).enableRLS();

/**
 * The custom-migration trigger that makes ending a grant final (the `receipt_links` "revocation
 * final" pattern of migration 0007): `app.forbid_update_delete('ended_at', 'ended_by')` lets those
 * two columns change, so without it `app_rw` could set them back to NULL (reopening the grant) or
 * move the end. `platform-admin.test.ts` checks migration 0017 holds this exact SQL.
 */
export const SUPPORT_GRANT_END_FINAL_SQL = `CREATE TRIGGER "support_access_grants_end_final"
  BEFORE UPDATE OF ended_at, ended_by ON "public"."support_access_grants"
  FOR EACH ROW
  WHEN (OLD.ended_at IS NOT NULL
    AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.ended_by IS DISTINCT FROM OLD.ended_by))
  EXECUTE FUNCTION app.forbid_update_delete();`;

/** How an offline fee payment reached us. */
export const OFFLINE_PAYMENT_METHODS = ["bank_transfer", "upi", "cash", "cheque"] as const;
export type OfflinePaymentMethod = (typeof OFFLINE_PAYMENT_METHODS)[number];
/** At most this many months per offline payment. */
export const OFFLINE_PAYMENT_MAX_MONTHS = 12;

export const subscriptionOfflinePayments = pgTable(
  "subscription_offline_payments",
  {
    id: primaryId(),
    operatorId: operatorIdColumn().references(() => operators.id),
    /** What we received, integer paise (> 0). */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    method: text("method").$type<OfflinePaymentMethod>().notNull(),
    /** Bank / UPI reference or cheque number, as written on the slip. */
    reference: text("reference"),
    /** The IST day the money arrived. */
    receivedOn: date("received_on", { mode: "string" }).notNull(),
    /** Months of access it pays for. */
    months: integer("months").notNull(),
    /** The paid-until the subscription was extended to by this payment. */
    paidUntil: timestamp("paid_until", { withTimezone: true }).notNull(),
    note: text("note"),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    tenantKey(t),
    index("subscription_offline_payments_operator_idx").on(t.operatorId, t.recordedAt),
    check("subscription_offline_payments_amount_positive", sql`${t.amountPaise} > 0`),
    check(
      "subscription_offline_payments_method_known",
      sql`${t.method} IN (${sql.raw(OFFLINE_PAYMENT_METHODS.map((m) => `'${m}'`).join(", "))})`,
    ),
    check(
      "subscription_offline_payments_months_range",
      sql`${t.months} BETWEEN 1 AND ${sql.raw(String(OFFLINE_PAYMENT_MAX_MONTHS))}`,
    ),
    check(
      "subscription_offline_payments_reference_length",
      sql`${t.reference} IS NULL OR char_length(${t.reference}) <= 100`,
    ),
    check(
      "subscription_offline_payments_note_length",
      sql`${t.note} IS NULL OR char_length(${t.note}) <= 500`,
    ),
    ...tenantPolicies(t),
    pgPolicy("subscription_offline_payments_platform_select", {
      for: "select",
      to: appPlatform,
      using: sql`true`,
    }),
  ],
).enableRLS();

/**
 * The only columns of tenant tables (besides the two tables above, which the platform may read
 * whole) that `app_platform` may SELECT, and why. Ids, codes, statuses, counts and times: no
 * names, phones, addresses, amounts, notes or per-customer ids. The custom migration
 * (`platformReadGrantsSql()`) revokes the table-wide SELECT and grants exactly these.
 */
export const PLATFORM_READ_COLUMNS = {
  /** Customer count per tenant and status (tenants list). */
  customers: ["operator_id", "status"],
  /** Billing runs across tenants (job monitor) and billing success rate (PRD §16). No money. */
  billing_runs: [
    "id",
    "operator_id",
    "period",
    "trigger",
    "status",
    "skip_reason",
    "customer_count",
    "created_count",
    "already_exists_count",
    "skipped_count",
    "failed_count",
    "started_at",
    "finished_at",
    "created_at",
    "updated_at",
  ],
  /** Billing exception rate by reason (PRD §16). No customer, invoice or details. */
  billing_run_items: ["operator_id", "run_id", "outcome", "reason"],
  /** Nightly invariant results (T-052): status and counts per code, never the samples. */
  invariant_checks: [
    "id",
    "operator_id",
    "run_id",
    "checked_at",
    "status",
    "violation_count",
    "counts",
    "created_at",
  ],
  /** Receipt action usage (PRD §16: print / WhatsApp / SMS launches). */
  receipt_actions: ["operator_id", "action", "at"],
  /** Reconciliation discrepancy rate (PRD §16). The reason only, never the amounts. */
  collection_sessions: ["operator_id", "status", "business_date", "discrepancy_reason"],
  /**
   * Payment sync success rate and duplicate prevention count (PRD §16, T-086a): per-batch answer
   * counts by IST day. Counts only (the table has nothing else); not the row id or the time.
   */
  payment_sync_batches: [
    "operator_id",
    "business_date",
    "items",
    "posted",
    "posted_needs_review",
    "duplicate",
    "rejected_validation",
    "rejected_customer_not_found",
    "rejected_id_reused",
    "rejected_without_id",
    "rejected_new_ids",
    "accepted_after_rejection",
    "retry_later_conflict",
    "retry_later_internal",
    "retry_later_rate_limited",
  ],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type PlatformReadTable = keyof typeof PLATFORM_READ_COLUMNS;

const platformSelect = (name: string) =>
  pgPolicy(name, { for: "select", to: appPlatform, using: sql`true` });

/** The `app_platform` SELECT policies for {@link PLATFORM_READ_COLUMNS} (rows; columns are grants). */
export const customersPlatformSelect = platformSelect("customers_platform_select").link(customers);
export const billingRunsPlatformSelect = platformSelect("billing_runs_platform_select").link(
  billingRuns,
);
export const billingRunItemsPlatformSelect = platformSelect(
  "billing_run_items_platform_select",
).link(billingRunItems);
export const invariantChecksPlatformSelect = platformSelect(
  "invariant_checks_platform_select",
).link(invariantChecks);
export const receiptActionsPlatformSelect = platformSelect("receipt_actions_platform_select").link(
  receiptActions,
);
export const collectionSessionsPlatformSelect = platformSelect(
  "collection_sessions_platform_select",
).link(collectionSessions);
export const paymentSyncBatchesPlatformSelect = platformSelect(
  "payment_sync_batches_platform_select",
).link(paymentSyncBatches);

/**
 * SQL for the custom migration: for each table in {@link PLATFORM_READ_COLUMNS} (or only `tables`,
 * for a later migration that adds one), revoke the table-wide SELECT from `app_platform` and grant
 * the listed columns.
 */
export function platformReadGrantsSql(tables?: readonly PlatformReadTable[]): string {
  return Object.entries(PLATFORM_READ_COLUMNS)
    .filter(([table]) => !tables || tables.includes(table as PlatformReadTable))
    .flatMap(([table, columns]) => [
      `REVOKE SELECT ON TABLE "public"."${table}" FROM app_platform;`,
      `GRANT SELECT (${columns.map((c) => `"${c}"`).join(", ")}) ON TABLE "public"."${table}" TO app_platform;`,
    ])
    .join("\n--> statement-breakpoint\n");
}
