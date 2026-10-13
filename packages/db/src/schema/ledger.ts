/**
 * Allocations, the customer ledger and the balance read model (T-023, PLAN §7.2, §8.4 to §8.6;
 * FR-011, FR-012, FR-014; RULE-11 to RULE-13, RULE-20; BR-13). The rows map one to one onto
 * T-041's `AllocationRow`, `LedgerEntry` and `LedgerState` (see `ledger.test.ts`).
 *
 * **`allocations`**: which invoice a payment or credit adjustment paid. Fully append-only.
 * - `source_type` `payment | credit_adjustment` with exactly one of `payment_id` /
 *   `credit_adjustment_id` set (each a real composite FK, with the customer in the key, so the
 *   invoice and the source always belong to the row's customer). `source_id` is a generated column
 *   (= whichever is set), T-041's `sourceId`.
 * - `kind`: `posting` (a payment's own allocation when posted, PLAN §8.4), `credit_application`
 *   (credit applied later, PLAN §8.5), `reversal` (PLAN §8.6). A replay of a payment returns the
 *   `posting` rows only.
 * - Signs: `amount_paise <> 0`; **negative exactly on `reversal` rows**, which carry `reversal_id`
 *   (the payment's own `payment_reversals` row: FK includes the payment) and
 *   `reverses_allocation_id` (the row they cancel: same invoice and payment, UNIQUE so a row is
 *   cancelled at most once). A trigger (`app.check_allocation_reversal`) checks that a reversal
 *   row cancels a positive row exactly (amount = −original). Only payments are reversed (T-041 Q-E).
 * - `outstanding_after_paise` (≥ 0): the invoice's outstanding right after this row (receipts:
 *   "Oct bill paid, Nov ₹50 left"; a replay returns the same values, T-051 decision 5).
 * - "Σ allocations per source ≤ source amount" and "outstanding never below 0" (PLAN §7.2, §8.4
 *   invariants 1 and 4) span rows, so they are kept by the posting transaction (under the
 *   customer's `customer_balances` row lock) and checked nightly by T-052 with T-041 `checkLedger`.
 *
 * **`ledger_entries`**: the customer's account, append-only. `amount_paise` is signed (+ increases
 * what the customer owes). Each entry names the document it posts through one typed reference,
 * required by `type`, with a sign fixed by `type`:
 *
 * | type | reference | sign |
 * |---|---|---|
 * | `invoice` | `invoice_id` (a regular invoice's charges) | ≥ 0 |
 * | `opening_balance` | `invoice_id` (an opening_balance invoice) | ≥ 0 |
 * | `debit_adjustment` | `adjustment_id` | > 0 |
 * | `credit_adjustment` | `adjustment_id` | < 0 |
 * | `payment` | `payment_id` | < 0 |
 * | `payment_reversal` | `payment_reversal_id` | > 0 |
 *
 * At most one entry per document and type (partial UNIQUEs), so a retry can't post a document
 * twice. Whether debit adjustments get their own entry or reach the ledger only through the next
 * invoice's charges is T-041 Q-A (open): the schema allows either, but at most one entry per
 * adjustment. `seq` (identity) is the posting order: the running balance of a statement is
 * Σ amount ORDER BY seq. Customer balance = Σ amount (PLAN §7.2).
 *
 * **`customer_balances`**: the read model (lists, sync, receipts), one row per customer, updated
 * in the same transaction as the ledger. Its row lock (`SELECT … FOR UPDATE`) serialises every
 * money change of a customer (PLAN §8.4). Create it lazily (`INSERT … ON CONFLICT DO NOTHING`, then
 * lock). Never deleted; its customer and tenant never change.
 */
import { ALLOCATION_SOURCE_TYPES, type LedgerEntryType } from "@cb/domain";
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId } from "../ids";
import { operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { adjustments, invoices, periodFirstDay } from "./billing";
import { customers } from "./customers";
import { paymentReversals, payments } from "./payments";

/** `allocations.source_type`: the values of `@cb/domain` `ALLOCATION_SOURCE_TYPES` (T-041). */
export const allocationSourceTypeEnum = pgEnum("allocation_source_type", ALLOCATION_SOURCE_TYPES);

/** Why an allocation row exists (see the module comment). */
export const ALLOCATION_KINDS = ["posting", "credit_application", "reversal"] as const;
export type AllocationKind = (typeof ALLOCATION_KINDS)[number];
export const allocationKindEnum = pgEnum("allocation_kind", ALLOCATION_KINDS);

/** `ledger_entries.type`: every T-041 `LedgerEntryType`, nothing else. */
export const LEDGER_ENTRY_TYPES = [
  "invoice",
  "opening_balance",
  "debit_adjustment",
  "credit_adjustment",
  "payment",
  "payment_reversal",
] as const satisfies readonly LedgerEntryType[];
// Compile-time check that no domain type is missing from the list.
type MissingLedgerEntryType = Exclude<LedgerEntryType, (typeof LEDGER_ENTRY_TYPES)[number]>;
const ledgerEntryTypesComplete: [MissingLedgerEntryType] extends [never] ? true : never = true;
void ledgerEntryTypesComplete;
export const ledgerEntryTypeEnum = pgEnum("ledger_entry_type", LEDGER_ENTRY_TYPES);

export const allocations = pgTable(
  "allocations",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    customerId: uuid("customer_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    sourceType: allocationSourceTypeEnum("source_type").notNull(),
    paymentId: uuid("payment_id"),
    creditAdjustmentId: uuid("credit_adjustment_id"),
    /** = payment_id or credit_adjustment_id (T-041 `sourceId`), generated by the database. */
    sourceId: uuid("source_id")
      .notNull()
      .generatedAlwaysAs(sql.raw(`coalesce("payment_id", "credit_adjustment_id")`)),
    kind: allocationKindEnum("kind").notNull(),
    /** Signed: negative only on reversal rows. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    /** The invoice's outstanding right after this row (≥ 0). */
    outstandingAfterPaise: bigint("outstanding_after_paise", { mode: "number" }).notNull(),
    /** Reversal rows: the payment's reversal. */
    reversalId: uuid("reversal_id"),
    /** Reversal rows: the row this one cancels. */
    reversesAllocationId: uuid("reverses_allocation_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    /** Target of `allocations_reverses_fk`: a reversal row cancels a row of its invoice and payment. */
    unique("allocations_operator_invoice_payment_id_unique").on(
      t.operatorId,
      t.invoiceId,
      t.paymentId,
      t.id,
    ),
    /** A row is cancelled at most once. */
    uniqueIndex("allocations_reverses_unique")
      .on(t.operatorId, t.reversesAllocationId)
      .where(sql`${t.reversesAllocationId} IS NOT NULL`),
    foreignKey({
      name: "allocations_invoice_fk",
      columns: [t.operatorId, t.customerId, t.invoiceId],
      foreignColumns: [invoices.operatorId, invoices.customerId, invoices.id],
    }),
    foreignKey({
      name: "allocations_payment_fk",
      columns: [t.operatorId, t.customerId, t.paymentId],
      foreignColumns: [payments.operatorId, payments.customerId, payments.id],
    }),
    foreignKey({
      name: "allocations_credit_adjustment_fk",
      columns: [t.operatorId, t.customerId, t.creditAdjustmentId],
      foreignColumns: [adjustments.operatorId, adjustments.customerId, adjustments.id],
    }),
    foreignKey({
      name: "allocations_reversal_fk",
      columns: [t.operatorId, t.paymentId, t.reversalId],
      foreignColumns: [
        paymentReversals.operatorId,
        paymentReversals.paymentId,
        paymentReversals.id,
      ],
    }),
    foreignKey({
      name: "allocations_reverses_fk",
      columns: [t.operatorId, t.invoiceId, t.paymentId, t.reversesAllocationId],
      foreignColumns: [t.operatorId, t.invoiceId, t.paymentId, t.id],
    }),
    index("allocations_invoice_idx").on(t.operatorId, t.invoiceId),
    index("allocations_customer_idx").on(t.operatorId, t.customerId),
    index("allocations_payment_idx")
      .on(t.operatorId, t.paymentId)
      .where(sql`${t.paymentId} IS NOT NULL`),
    index("allocations_credit_adjustment_idx")
      .on(t.operatorId, t.creditAdjustmentId)
      .where(sql`${t.creditAdjustmentId} IS NOT NULL`),
    check(
      "allocations_one_source",
      sql`CASE WHEN ${t.sourceType} = 'payment'
        THEN ${t.paymentId} IS NOT NULL AND ${t.creditAdjustmentId} IS NULL
        ELSE ${t.creditAdjustmentId} IS NOT NULL AND ${t.paymentId} IS NULL
        END`,
    ),
    check("allocations_amount_not_zero", sql`${t.amountPaise} <> 0`),
    check(
      "allocations_reversal_shape",
      sql`CASE WHEN ${t.kind} = 'reversal'
        THEN ${t.amountPaise} < 0 AND ${t.sourceType} = 'payment'
          AND ${t.reversalId} IS NOT NULL AND ${t.reversesAllocationId} IS NOT NULL
        ELSE ${t.amountPaise} > 0 AND ${t.reversalId} IS NULL AND ${t.reversesAllocationId} IS NULL
        END`,
    ),
    check(
      "allocations_posting_is_payment",
      sql`${t.kind} <> 'posting' OR ${t.sourceType} = 'payment'`,
    ),
    check("allocations_outstanding_after_not_negative", sql`${t.outstandingAfterPaise} >= 0`),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    customerId: uuid("customer_id").notNull(),
    /** Posting order (a global identity; per customer it follows the balance row lock). */
    seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
    type: ledgerEntryTypeEnum("type").notNull(),
    /** Signed: + increases what the customer owes. */
    amountPaise: bigint("amount_paise", { mode: "number" }).notNull(),
    invoiceId: uuid("invoice_id"),
    adjustmentId: uuid("adjustment_id"),
    paymentId: uuid("payment_id"),
    paymentReversalId: uuid("payment_reversal_id"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    tenantKey(t),
    foreignKey({
      name: "ledger_entries_customer_fk",
      columns: [t.operatorId, t.customerId],
      foreignColumns: [customers.operatorId, customers.id],
    }),
    foreignKey({
      name: "ledger_entries_invoice_fk",
      columns: [t.operatorId, t.customerId, t.invoiceId],
      foreignColumns: [invoices.operatorId, invoices.customerId, invoices.id],
    }),
    foreignKey({
      name: "ledger_entries_adjustment_fk",
      columns: [t.operatorId, t.customerId, t.adjustmentId],
      foreignColumns: [adjustments.operatorId, adjustments.customerId, adjustments.id],
    }),
    foreignKey({
      name: "ledger_entries_payment_fk",
      columns: [t.operatorId, t.customerId, t.paymentId],
      foreignColumns: [payments.operatorId, payments.customerId, payments.id],
    }),
    foreignKey({
      name: "ledger_entries_payment_reversal_fk",
      columns: [t.operatorId, t.customerId, t.paymentReversalId],
      foreignColumns: [
        paymentReversals.operatorId,
        paymentReversals.customerId,
        paymentReversals.id,
      ],
    }),
    // Statement / running balance (T-049) and Σ per customer (T-052).
    index("ledger_entries_customer_seq_idx").on(t.operatorId, t.customerId, t.seq),
    // One entry per document (and type): a retry can't post the same document twice.
    uniqueIndex("ledger_entries_one_per_invoice")
      .on(t.operatorId, t.invoiceId)
      .where(sql`${t.invoiceId} IS NOT NULL`),
    uniqueIndex("ledger_entries_one_per_adjustment")
      .on(t.operatorId, t.adjustmentId)
      .where(sql`${t.adjustmentId} IS NOT NULL`),
    uniqueIndex("ledger_entries_one_per_payment")
      .on(t.operatorId, t.paymentId)
      .where(sql`${t.paymentId} IS NOT NULL`),
    uniqueIndex("ledger_entries_one_per_reversal")
      .on(t.operatorId, t.paymentReversalId)
      .where(sql`${t.paymentReversalId} IS NOT NULL`),
    check(
      "ledger_entries_reference_and_sign",
      sql`CASE ${t.type}
        WHEN 'invoice' THEN ${t.invoiceId} IS NOT NULL AND ${t.amountPaise} >= 0
        WHEN 'opening_balance' THEN ${t.invoiceId} IS NOT NULL AND ${t.amountPaise} >= 0
        WHEN 'debit_adjustment' THEN ${t.adjustmentId} IS NOT NULL AND ${t.amountPaise} > 0
        WHEN 'credit_adjustment' THEN ${t.adjustmentId} IS NOT NULL AND ${t.amountPaise} < 0
        WHEN 'payment' THEN ${t.paymentId} IS NOT NULL AND ${t.amountPaise} < 0
        WHEN 'payment_reversal' THEN ${t.paymentReversalId} IS NOT NULL AND ${t.amountPaise} > 0
        END`,
    ),
    check(
      "ledger_entries_one_reference",
      sql`num_nonnulls(${t.invoiceId}, ${t.adjustmentId}, ${t.paymentId}, ${t.paymentReversalId}) = 1`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const customerBalances = pgTable(
  "customer_balances",
  {
    customerId: uuid("customer_id").primaryKey(),
    operatorId: operatorIdColumn(),
    /** Σ ledger_entries.amount_paise (signed; > 0 = owes). */
    balancePaise: bigint("balance_paise", { mode: "number" }).notNull().default(0),
    /** Unallocated credit (payment remainders + credit adjustments not yet applied), ≥ 0. */
    creditPaise: bigint("credit_paise", { mode: "number" }).notNull().default(0),
    /** The oldest period with an outstanding invoice (`Period`), NULL when nothing is owed. */
    oldestDuePeriod: date("oldest_due_period", { mode: "string" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("customer_balances_operator_customer_unique").on(t.operatorId, t.customerId),
    foreignKey({
      name: "customer_balances_customer_fk",
      columns: [t.operatorId, t.customerId],
      foreignColumns: [customers.operatorId, customers.id],
    }),
    check("customer_balances_credit_not_negative", sql`${t.creditPaise} >= 0`),
    periodFirstDay("customer_balances_oldest_due_first_day", t.oldestDuePeriod),
    ...tenantPolicies(t),
  ],
).enableRLS();
