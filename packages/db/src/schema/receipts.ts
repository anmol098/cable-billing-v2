/**
 * Receipts, their public preview links and what was done with them (T-023, PLAN §7.2, §7.3,
 * §11.7; FR-016 to FR-021; RULE-17 to RULE-19; BR-12; D-14).
 *
 * **`receipts`**: one per payment (UNIQUE `(operator_id, payment_id)`), created when the server
 * posts the payment (PLAN §8.4). `receipt_number` is UNIQUE per operator: new numbers come from
 * the gap-free counter (`nextCounter(tx, op, "receipt")`, `R-{YYMM}-{seq:05}`), migrated receipts
 * keep their legacy number. `provisional_ref` (`P-{device_code}-{seq}`, the phone's offline
 * reference) is kept forever as an alias (FR-016, RULE-17) and indexed for look-ups. It is **not**
 * unique: a collision (e.g. a phone that lost its local sequence) must never stop a payment from
 * posting. Fully append-only; a reversed payment's receipt shows "Cancelled" from
 * `payment_reversals` (nothing on the receipt changes).
 *
 * **`receipt_links`** (FR-021, T-050): only the SHA-256 of the token is stored (64 lower-case hex,
 * CHECK; globally UNIQUE because the public page looks the token up before it knows the tenant:
 * `app_platform` may SELECT, nothing else). 90-day expiry (D-14), revocation, access count.
 * After insert only `revoked_at`/`revoked_by` (once: a revoked link stays revoked) and
 * `access_count`/`last_access_at` may change. Rows may be deleted (the weekly purge of
 * long-expired links, PLAN §14); the receipt stays.
 *
 * **`receipt_actions`** (PLAN §11.7): what the lineman (or office) observably did with a receipt.
 * The action enum has **no "sent" or "delivered" value** (RULE-19, BR-12, CLAUDE.md honest
 * states). `id` is the phone's idempotency key (the contract's `ReceiptActionItem.id`), so the
 * primary key is `(operator_id, id)`, as for payments. Fully append-only.
 */
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgPolicy,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { primaryId, uuidv7 } from "../ids";
import { appPlatform, operatorIdColumn, tenantKey, tenantPolicies } from "../rls";
import { devices, users } from "./auth";
import { notBlank } from "./billing";
import { PROVISIONAL_REF_PATTERN, payments } from "./payments";

/** `receipt_actions.action` (the contract's `ReceiptActionType`). Observable states only. */
export const RECEIPT_ACTIONS = [
  "printed",
  "print_failed",
  "whatsapp_opened",
  "sms_opened",
  "pdf_shared",
] as const;
export type ReceiptAction = (typeof RECEIPT_ACTIONS)[number];
export const receiptActionEnum = pgEnum("receipt_action", RECEIPT_ACTIONS);

/** A hex SHA-256 digest (the only form a receipt-link token is stored in). */
export const TOKEN_HASH_PATTERN = "^[0-9a-f]{64}$";

export const receipts = pgTable(
  "receipts",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    paymentId: uuid("payment_id").notNull(),
    /** Permanent number (display only, never a key, BR-02). UNIQUE per operator. */
    receiptNumber: text("receipt_number").notNull(),
    /** The phone's provisional reference (FR-016); NULL for payments not taken on a phone. */
    provisionalRef: text("provisional_ref"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    legacySource: text("legacy_source"),
    legacyId: text("legacy_id"),
  },
  (t) => [
    tenantKey(t),
    unique("receipts_payment_unique").on(t.operatorId, t.paymentId),
    unique("receipts_operator_number_unique").on(t.operatorId, t.receiptNumber),
    uniqueIndex("receipts_operator_legacy_unique")
      .on(t.operatorId, t.legacySource, t.legacyId)
      .where(sql`${t.legacyId} IS NOT NULL`),
    foreignKey({
      name: "receipts_payment_fk",
      columns: [t.operatorId, t.paymentId],
      foreignColumns: [payments.operatorId, payments.id],
    }),
    index("receipts_provisional_ref_idx")
      .on(t.operatorId, t.provisionalRef)
      .where(sql`${t.provisionalRef} IS NOT NULL`),
    check("receipts_number_not_blank", notBlank(t.receiptNumber)),
    check(
      "receipts_provisional_ref_format",
      sql`${t.provisionalRef} ~ ${sql.raw(`'${PROVISIONAL_REF_PATTERN}'`)}`,
    ),
    check(
      "receipts_legacy_both_or_neither",
      sql`(${t.legacySource} IS NULL) = (${t.legacyId} IS NULL)`,
    ),
    ...tenantPolicies(t),
  ],
).enableRLS();

export const receiptLinks = pgTable(
  "receipt_links",
  {
    id: primaryId(),
    operatorId: operatorIdColumn(),
    receiptId: uuid("receipt_id").notNull(),
    /** SHA-256 of the 32-byte token, lower-case hex. The raw token is never stored. */
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Who asked for the link (the lineman or office user). */
    createdBy: uuid("created_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
    accessCount: integer("access_count").notNull().default(0),
    lastAccessAt: timestamp("last_access_at", { withTimezone: true }),
  },
  (t) => [
    tenantKey(t),
    unique("receipt_links_token_hash_unique").on(t.tokenHash),
    foreignKey({
      name: "receipt_links_receipt_fk",
      columns: [t.operatorId, t.receiptId],
      foreignColumns: [receipts.operatorId, receipts.id],
    }),
    foreignKey({
      name: "receipt_links_created_by_fk",
      columns: [t.operatorId, t.createdBy],
      foreignColumns: [users.operatorId, users.id],
    }),
    foreignKey({
      name: "receipt_links_revoked_by_fk",
      columns: [t.operatorId, t.revokedBy],
      foreignColumns: [users.operatorId, users.id],
    }),
    // "Create or reuse": the receipt's live link (T-050).
    index("receipt_links_receipt_idx").on(t.operatorId, t.receiptId, t.expiresAt),
    check(
      "receipt_links_token_hash_format",
      sql`${t.tokenHash} ~ ${sql.raw(`'${TOKEN_HASH_PATTERN}'`)}`,
    ),
    check("receipt_links_expires_after_created", sql`${t.expiresAt} > ${t.createdAt}`),
    check(
      "receipt_links_revoked_by_needs_revoked_at",
      sql`${t.revokedBy} IS NULL OR ${t.revokedAt} IS NOT NULL`,
    ),
    check("receipt_links_access_count_not_negative", sql`${t.accessCount} >= 0`),
    ...tenantPolicies(t),
    // The public page finds the link by token hash before the tenant is known (then works in
    // withTenant). Read only: counting accesses and revoking happen in the tenant's transaction.
    pgPolicy("receipt_links_platform_select", { for: "select", to: appPlatform, using: sql`true` }),
  ],
).enableRLS();

export const receiptActions = pgTable(
  "receipt_actions",
  {
    /** The phone's idempotency key for this action (unique per operator: the primary key). */
    id: uuid("id").notNull().$defaultFn(uuidv7),
    operatorId: operatorIdColumn(),
    receiptId: uuid("receipt_id").notNull(),
    action: receiptActionEnum("action").notNull(),
    /** The phone it happened on (NULL for web actions such as printing an A5 receipt). */
    deviceId: uuid("device_id"),
    /** Who did it. */
    actorId: uuid("actor_id"),
    /** When it happened, by the device's clock (UTC). */
    at: timestamp("at", { withTimezone: true }).notNull(),
    /** When the server stored it. */
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "receipt_actions_pkey", columns: [t.operatorId, t.id] }),
    foreignKey({
      name: "receipt_actions_receipt_fk",
      columns: [t.operatorId, t.receiptId],
      foreignColumns: [receipts.operatorId, receipts.id],
    }),
    foreignKey({
      name: "receipt_actions_device_fk",
      columns: [t.operatorId, t.deviceId],
      foreignColumns: [devices.operatorId, devices.id],
    }),
    foreignKey({
      name: "receipt_actions_actor_fk",
      columns: [t.operatorId, t.actorId],
      foreignColumns: [users.operatorId, users.id],
    }),
    index("receipt_actions_receipt_idx").on(t.operatorId, t.receiptId, t.at),
    ...tenantPolicies(t),
  ],
).enableRLS();
