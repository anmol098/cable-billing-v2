/**
 * Billing (T-023, PLAN §7.2, §8.2, §8.3; FR-009 to FR-012; RULE-05, RULE-20; BR-13): monthly
 * billing runs and their per-customer items, invoices, invoice lines and adjustments.
 *
 * **`invoices`**: one consolidated invoice per customer and period (PRD §15 #3, T-040).
 * - `kind = 'regular'`: the monthly bill. **At most one per (operator, customer, period)**
 *   (RULE-05, PRD §15 #4): partial UNIQUE `invoices_one_regular_per_period`, the final guard
 *   against two concurrent runs (SQLSTATE 23505).
 * - `kind = 'opening_balance'`: old dues brought in by the migration (T-092). Its
 *   `charges_paise` is the opening amount (T-041: what the invoice adds to the ledger and what its
 *   allocations settle). Not limited per period/customer by the schema.
 * - `invoice_number`: UNIQUE per operator. New numbers come from the gap-free counter
 *   (`nextCounter(tx, op, "invoice")`, formatted `{prefix}-{YYMM}-{seq:05}`, PLAN §7.3) in the
 *   transaction that inserts the invoice; migrated invoices keep their legacy number.
 * - `opening_balance_paise` (signed) = the customer's ledger balance before this invoice;
 *   `charges_paise` (≥ 0) = Σ lines; `total_due_paise` = opening + charges (CHECK). `total_due` is a
 *   display snapshot, not a receivable (T-040): what an invoice still owes is
 *   `charges − Σ its allocations` (T-041 `invoiceOutstanding`).
 * - **Immutable once inserted** (invoices are inserted issued; there is no draft state): only
 *   `status` and the void metadata (`voided_at`, `voided_by`, `void_reason`) may change, only from
 *   `issued` to `void`, and a void invoice never changes again (PLAN §7.1). No row is ever deleted.
 *   No service voids invoices yet: what a void does to the ledger is an open question (T-023
 *   completion notes). A void invoice still occupies its period in the regular-invoice UNIQUE.
 *
 * **`invoice_lines`**: fully append-only. `type = 'rent'` (one per billed VC assignment and
 * invoice, `assignment_id` required, amount ≥ 0: a ₹0 rental gives a ₹0 line, T-040) or
 * `type = 'adjustment'` (one per invoiced **debit** adjustment, amount > 0). Lines carry structured
 * data; `description` is optional free text (the UI renders the line from its type, VC and period
 * through i18n; migrated lines may carry their legacy text).
 *
 * **`adjustments`** (PLAN §8.3, T-042 `AdjustmentDraft`): `direction` + `amount_paise > 0`.
 * - Debit adjustments are pending until a bill picks them up (`invoice_id` NULL), then
 *   `invoice_id` is set **once** and never changes. Credit adjustments are credit sources
 *   (T-041 `applyCredit`) and are never invoiced (CHECK).
 * - `plan_change` / `mid_month_start` adjustments always name the assignment and period they
 *   correct; `mid_month_start` is always a debit (T-042). `manual` needs a reason and an author.
 * - Append-only except that one-time `invoice_id`. Corrections are new adjustments.
 *
 * **`billing_runs`** / **`billing_run_items`** (PLAN §8.2, J-03): one logical run per operator and
 * period (UNIQUE, retries and manual re-runs reuse it), and one item per customer the run
 * looked at (UNIQUE per run). Mutable status rows (a retried `failed` item becomes `created`);
 * never deleted. `status = 'skipped'` records a run that did not bill (read-only tenant, D-13,
 * D-25) with its `skip_reason`.
 *
 * Every reference between tenant tables is a composite FK. Invoices, adjustments and run items
 * also reference each other with the **customer** in the key, so an adjustment can only be
 * invoiced on its own customer's invoice, and an item only points at its customer's invoice.
 * Database rules Drizzle can't express (triggers) are in the T-023 custom migration.
 */
import { ADJUSTMENT_DIRECTIONS, ADJUSTMENT_SOURCES } from "@cb/domain";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
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
import { vcAssignments } from "./connections";
import { customers } from "./customers";

/** `invoices.kind` (PLAN §7.2; the contract's `BillKind`). */
export const INVOICE_KINDS = ["regular", "opening_balance"] as const;
export type InvoiceKind = (typeof INVOICE_KINDS)[number];
export const invoiceKindEnum = pgEnum("invoice_kind", INVOICE_KINDS);

/** `invoices.status`: invoices are inserted `issued`; `void` is final (PLAN §7.1). */
export const INVOICE_STATUSES = ["issued", "void"] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const invoiceStatusEnum = pgEnum("invoice_status", INVOICE_STATUSES);

/** `invoice_lines.type` (PLAN §7.2, T-040 `InvoiceLine`). */
export const INVOICE_LINE_TYPES = ["rent", "adjustment"] as const;
export type InvoiceLineType = (typeof INVOICE_LINE_TYPES)[number];
export const invoiceLineTypeEnum = pgEnum("invoice_line_type", INVOICE_LINE_TYPES);

/** `adjustments.direction`: the values of `@cb/domain` `ADJUSTMENT_DIRECTIONS` (T-042). */
export const adjustmentDirectionEnum = pgEnum("adjustment_direction", ADJUSTMENT_DIRECTIONS);

/** `adjustments.source`: the values of `@cb/domain` `ADJUSTMENT_SOURCES` (T-042). */
export const adjustmentSourceEnum = pgEnum("adjustment_source", ADJUSTMENT_SOURCES);

/** `billing_runs.trigger` (PLAN §7.2, §14). */
export const BILLING_RUN_TRIGGERS = ["cron", "manual", "catch_up"] as const;
export type BillingRunTrigger = (typeof BILLING_RUN_TRIGGERS)[number];
export const billingRunTriggerEnum = pgEnum("billing_run_trigger", BILLING_RUN_TRIGGERS);

/**
 * `billing_runs.status` (PLAN §7.2) plus `skipped`: the run was recorded but did not bill
 * (PLAN §8.2 "read_only tenants → run recorded as skipped", D-13, D-25).
 */
export const BILLING_RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "completed_with_errors",
  "failed",
  "skipped",
] as const;
export type BillingRunStatus = (typeof BILLING_RUN_STATUSES)[number];
export const billingRunStatusEnum = pgEnum("billing_run_status", BILLING_RUN_STATUSES);

/** Why a run was `skipped`. */
export const BILLING_RUN_SKIP_REASONS = ["tenant_read_only"] as const;
export type BillingRunSkipReason = (typeof BILLING_RUN_SKIP_REASONS)[number];
export const billingRunSkipReasonEnum = pgEnum("billing_run_skip_reason", BILLING_RUN_SKIP_REASONS);

/** `billing_run_items.outcome` (PLAN §7.2; T-040: invoice → created, nothing_to_bill → skipped). */
export const BILLING_RUN_ITEM_OUTCOMES = [
  "created",
  "already_exists",
  "skipped",
  "failed",
] as const;
export type BillingRunItemOutcome = (typeof BILLING_RUN_ITEM_OUTCOMES)[number];
export const billingRunItemOutcomeEnum = pgEnum(
  "billing_run_item_outcome",
  BILLING_RUN_ITEM_OUTCOMES,
);

/** `CHECK (extract(day from period) = 1)`: a billing period is the 1st of its month (`Period`). */
export const periodFirstDay = (name: string, column: AnyPgColumn) =>
  check(name, sql`extract(day from ${column}) = 1`);

/**
 * `coalesce(btrim(x), '') <> ''`: a required, non-blank text inside a CHECK. A plain
 * `btrim(x) <> ''` is NULL for a NULL `x`, and a CHECK that evaluates to NULL passes.
 */
export const notBlank = (column: AnyPgColumn) => sql`coalesce(btrim(${column}), '') <> ''`;

export const billingRuns = pgTable(
  "billing_runs",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    /** The billing month (`Period`, the 1st). */
    period: date("period", { mode: "string" }).notNull(),
    trigger: billingRunTriggerEnum("trigger").notNull(),
    status: billingRunStatusEnum("status").notNull().default("pending"),
    /** Set when (and only when) `status = 'skipped'`. */
    skipReason: billingRunSkipReasonEnum("skip_reason"),
    /** Item counts, kept in step with `billing_run_items` by the run service (T-044). */
    customerCount: integer("customer_count").notNull().default(0),
    createdCount: integer("created_count").notNull().default(0),
    alreadyExistsCount: integer("already_exists_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /** Σ `charges_paise` of the invoices this run created. */
    totalChargesPaise: bigint("total_charges_paise", { mode: "number" }).notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** Who started a manual run (D-16: Owner). NULL for cron / catch-up runs. */
    actorId: uuid("actor_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    unique("billing_runs_operator_period_unique").on(t.operatorId, t.period),
    foreignKey({
      name: "billing_runs_actor_fk",
      columns: [t.operatorId, t.actorId],
      foreignColumns: [users.operatorId, users.id],
    }),
    periodFirstDay("billing_runs_period_first_day", t.period),
    check(
      "billing_runs_skip_reason_iff_skipped",
      sql`(${t.status} = 'skipped') = (${t.skipReason} IS NOT NULL)`,
    ),
    check(
      "billing_runs_finished_iff_done",
      sql`(${t.status} IN ('pending', 'running')) = (${t.finishedAt} IS NULL)`,
    ),
    check(
      "billing_runs_manual_has_actor",
      sql`${t.trigger} <> 'manual' OR ${t.actorId} IS NOT NULL`,
    ),
    check(
      "billing_runs_counts_not_negative",
      sql`${t.customerCount} >= 0 AND ${t.createdCount} >= 0 AND ${t.alreadyExistsCount} >= 0
        AND ${t.skippedCount} >= 0 AND ${t.failedCount} >= 0 AND ${t.totalChargesPaise} >= 0`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const invoices = pgTable(
  "invoices",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    customerId: uuid("customer_id").notNull(),
    /** The billing month (`Period`, the 1st). */
    period: date("period", { mode: "string" }).notNull(),
    /** Display number, never a key (BR-02). UNIQUE per operator. */
    invoiceNumber: text("invoice_number").notNull(),
    kind: invoiceKindEnum("kind").notNull().default("regular"),
    /** The customer's ledger balance before this invoice (signed: negative = advance). */
    openingBalancePaise: bigint("opening_balance_paise", { mode: "number" }).notNull(),
    /** What this invoice adds to the ledger: Σ lines (regular) or the old dues (opening_balance). */
    chargesPaise: bigint("charges_paise", { mode: "number" }).notNull(),
    /** opening + charges: the balance shown on the bill (display snapshot, T-040). */
    totalDuePaise: bigint("total_due_paise", { mode: "number" }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    status: invoiceStatusEnum("status").notNull().default("issued"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by"),
    voidReason: text("void_reason"),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    tenantKey(t),
    /** Target of the same-customer composite FKs (adjustments, allocations, ledger, run items). */
    unique("invoices_operator_customer_id_unique").on(t.operatorId, t.customerId, t.id),
    unique("invoices_operator_number_unique").on(t.operatorId, t.invoiceNumber),
    uniqueIndex("invoices_one_regular_per_period")
      .on(t.operatorId, t.customerId, t.period)
      .where(sql`${t.kind} = 'regular'`),
    uniqueIndex("invoices_operator_legacy_unique")
      .on(t.operatorId, t.legacySource, t.legacyId)
      .where(sql`${t.legacyId} IS NOT NULL`),
    foreignKey({
      name: "invoices_customer_fk",
      columns: [t.operatorId, t.customerId],
      foreignColumns: [customers.operatorId, customers.id],
    }),
    foreignKey({
      name: "invoices_voided_by_fk",
      columns: [t.operatorId, t.voidedBy],
      foreignColumns: [users.operatorId, users.id],
    }),
    // Open invoices of a customer, oldest first (T-041 order: period, id).
    index("invoices_customer_period_idx").on(t.operatorId, t.customerId, t.period, t.id),
    // Bill register by month (T-047).
    index("invoices_period_idx").on(t.operatorId, t.period),
    periodFirstDay("invoices_period_first_day", t.period),
    check("invoices_number_not_blank", sql`btrim(${t.invoiceNumber}) <> ''`),
    check("invoices_charges_not_negative", sql`${t.chargesPaise} >= 0`),
    check(
      "invoices_total_due_is_opening_plus_charges",
      sql`${t.totalDuePaise} = ${t.openingBalancePaise} + ${t.chargesPaise}`,
    ),
    check(
      "invoices_void_metadata",
      sql`CASE WHEN ${t.status} = 'void'
        THEN ${t.voidedAt} IS NOT NULL AND ${t.voidedBy} IS NOT NULL AND ${notBlank(t.voidReason)}
        ELSE ${t.voidedAt} IS NULL AND ${t.voidedBy} IS NULL AND ${t.voidReason} IS NULL
        END`,
    ),
    check(
      "invoices_legacy_both_or_neither",
      sql`(${t.legacySource} IS NULL) = (${t.legacyId} IS NULL)`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const adjustments = pgTable(
  "adjustments",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    customerId: uuid("customer_id").notNull(),
    /** The connection whose rent it corrects (required for plan_change / mid_month_start). */
    assignmentId: uuid("assignment_id"),
    /** The month whose rent it corrects (`Period`); required for plan_change / mid_month_start. */
    period: date("period", { mode: "string" }),
    direction: adjustmentDirectionEnum("direction").notNull(),
    /** Always > 0; the direction gives the sign. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    source: adjustmentSourceEnum("source").notNull(),
    /** Why (required for manual adjustments, PLAN §8.3 / T-045). */
    reason: text("reason"),
    /** The invoice that billed this debit adjustment; set once, never for credits. */
    invoiceId: uuid("invoice_id"),
    /** Who made it; NULL for system (plan-change hooks) and migration rows. */
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    tenantKey(t),
    unique("adjustments_operator_customer_id_unique").on(t.operatorId, t.customerId, t.id),
    /** Target of `invoice_lines_adjustment_fk`: a line must name the adjustment's own invoice. */
    unique("adjustments_operator_id_invoice_unique").on(t.operatorId, t.id, t.invoiceId),
    uniqueIndex("adjustments_operator_legacy_unique")
      .on(t.operatorId, t.legacySource, t.legacyId)
      .where(sql`${t.legacyId} IS NOT NULL`),
    foreignKey({
      name: "adjustments_customer_fk",
      columns: [t.operatorId, t.customerId],
      foreignColumns: [customers.operatorId, customers.id],
    }),
    foreignKey({
      name: "adjustments_assignment_fk",
      columns: [t.operatorId, t.assignmentId],
      foreignColumns: [vcAssignments.operatorId, vcAssignments.id],
    }),
    foreignKey({
      name: "adjustments_invoice_fk",
      columns: [t.operatorId, t.customerId, t.invoiceId],
      foreignColumns: [invoices.operatorId, invoices.customerId, invoices.id],
    }),
    foreignKey({
      name: "adjustments_created_by_fk",
      columns: [t.operatorId, t.createdBy],
      foreignColumns: [users.operatorId, users.id],
    }),
    // Pending debit adjustments of a customer (T-044 picks them up).
    index("adjustments_pending_idx")
      .on(t.operatorId, t.customerId)
      .where(sql`${t.invoiceId} IS NULL AND ${t.direction} = 'debit'`),
    // "Charged so far" records for an assignment and period (T-042).
    index("adjustments_assignment_period_idx").on(t.operatorId, t.assignmentId, t.period),
    index("adjustments_customer_idx").on(t.operatorId, t.customerId, t.createdAt),
    periodFirstDay("adjustments_period_first_day", t.period),
    check("adjustments_amount_positive", sql`${t.amountPaise} > 0`),
    check(
      "adjustments_only_debits_invoiced",
      sql`${t.invoiceId} IS NULL OR ${t.direction} = 'debit'`,
    ),
    check(
      "adjustments_rental_sources_name_connection",
      sql`${t.source} NOT IN ('plan_change', 'mid_month_start')
        OR (${t.assignmentId} IS NOT NULL AND ${t.period} IS NOT NULL)`,
    ),
    check(
      "adjustments_mid_month_start_is_debit",
      sql`${t.source} <> 'mid_month_start' OR ${t.direction} = 'debit'`,
    ),
    check(
      "adjustments_manual_has_reason_and_author",
      sql`${t.source} <> 'manual' OR (${notBlank(t.reason)} AND ${t.createdBy} IS NOT NULL)`,
    ),
    check(
      "adjustments_legacy_both_or_neither",
      sql`(${t.legacySource} IS NULL) = (${t.legacyId} IS NULL)`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    invoiceId: uuid("invoice_id").notNull(),
    type: invoiceLineTypeEnum("type").notNull(),
    /** The VC assignment the line is for (required for rent; kept for attribution, RULE-07). */
    assignmentId: uuid("assignment_id"),
    /** The debit adjustment this line bills (type 'adjustment' only). */
    adjustmentId: uuid("adjustment_id"),
    /** Optional free text; the UI renders lines from structured data through i18n. */
    description: text("description"),
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      name: "invoice_lines_invoice_fk",
      columns: [t.operatorId, t.invoiceId],
      foreignColumns: [invoices.operatorId, invoices.id],
    }),
    foreignKey({
      name: "invoice_lines_assignment_fk",
      columns: [t.operatorId, t.assignmentId],
      foreignColumns: [vcAssignments.operatorId, vcAssignments.id],
    }),
    // The adjustment must already be marked as billed by this very invoice (set
    // adjustments.invoice_id first, then insert the line).
    foreignKey({
      name: "invoice_lines_adjustment_fk",
      columns: [t.operatorId, t.adjustmentId, t.invoiceId],
      foreignColumns: [adjustments.operatorId, adjustments.id, adjustments.invoiceId],
    }),
    index("invoice_lines_invoice_idx").on(t.operatorId, t.invoiceId),
    index("invoice_lines_assignment_idx").on(t.operatorId, t.assignmentId),
    // An adjustment is billed once; a connection gets one rent line per invoice (T-042: one base charge).
    uniqueIndex("invoice_lines_adjustment_unique")
      .on(t.operatorId, t.adjustmentId)
      .where(sql`${t.adjustmentId} IS NOT NULL`),
    uniqueIndex("invoice_lines_one_rent_per_assignment")
      .on(t.operatorId, t.invoiceId, t.assignmentId)
      .where(sql`${t.type} = 'rent'`),
    check(
      "invoice_lines_shape",
      sql`CASE WHEN ${t.type} = 'rent'
        THEN ${t.assignmentId} IS NOT NULL AND ${t.adjustmentId} IS NULL AND ${t.amountPaise} >= 0
        ELSE ${t.adjustmentId} IS NOT NULL AND ${t.amountPaise} > 0
        END`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const billingRunItems = pgTable(
  "billing_run_items",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    runId: uuid("run_id").notNull(),
    customerId: uuid("customer_id").notNull(),
    outcome: billingRunItemOutcomeEnum("outcome").notNull(),
    /** The customer's invoice for the period (created now, or the one that already existed). */
    invoiceId: uuid("invoice_id"),
    /** Machine code for skipped / failed items (e.g. `nothing_to_bill`, T-040 `details.reason`). */
    reason: text("reason"),
    /** Ids and amounts only (T-040 error `details`); never names or phone numbers. */
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    /** How many times this customer was attempted in this run (retries add one). */
    attempts: integer("attempts").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    unique("billing_run_items_run_customer_unique").on(t.operatorId, t.runId, t.customerId),
    foreignKey({
      name: "billing_run_items_run_fk",
      columns: [t.operatorId, t.runId],
      foreignColumns: [billingRuns.operatorId, billingRuns.id],
    }),
    foreignKey({
      name: "billing_run_items_customer_fk",
      columns: [t.operatorId, t.customerId],
      foreignColumns: [customers.operatorId, customers.id],
    }),
    foreignKey({
      name: "billing_run_items_invoice_fk",
      columns: [t.operatorId, t.customerId, t.invoiceId],
      foreignColumns: [invoices.operatorId, invoices.customerId, invoices.id],
    }),
    // Exception queue / "Retry problems" (J-03).
    index("billing_run_items_outcome_idx").on(t.operatorId, t.runId, t.outcome),
    check(
      "billing_run_items_invoice_iff_billed",
      sql`(${t.outcome} IN ('created', 'already_exists')) = (${t.invoiceId} IS NOT NULL)`,
    ),
    check(
      "billing_run_items_reason_when_not_billed",
      sql`${t.outcome} IN ('created', 'already_exists') OR ${notBlank(t.reason)}`,
    ),
    check("billing_run_items_details_object", sql`jsonb_typeof(${t.details}) = 'object'`),
    check("billing_run_items_attempts_positive", sql`${t.attempts} >= 1`),
    ...tenantPolicies(t),
  ],
).enableRLS();
