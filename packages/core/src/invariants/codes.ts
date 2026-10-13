/**
 * What the nightly invariants job checks (T-052, PLAN §14 `invariants`, PLAN §8.4 invariants 1–4).
 *
 * The ledger codes are T-041's `checkLedger` codes (`@cb/domain`): the domain function is the
 * specification for one customer, and `checkTenantInvariants` computes the same rules for a whole
 * tenant in one set-based SQL statement (the equivalence is tested). `checkLedger`'s remaining
 * codes can't occur in the database, because constraints already make them impossible:
 * `UNKNOWN_INVOICE` / `UNKNOWN_SOURCE` (composite foreign keys), `DUPLICATE_ID` (primary keys) and
 * `INVALID_AMOUNT` (`bigint` columns, `CHECK amount_paise > 0` on payments and adjustments).
 *
 * Two more rules from PLAN §14 that are about the tenant, not one customer's money:
 * `OVERLAPPING_ASSIGNMENTS` (RULE-06 / BR-03: a VC never has two assignments whose dates overlap)
 * and `DUPLICATE_REGULAR_INVOICE` (RULE-05: one regular invoice per customer and period). Both are
 * also enforced by constraints (`vc_assignments_no_overlap`, `invoices_one_regular_per_period`);
 * the nightly job checks them anyway, so a dropped or bypassed constraint is noticed.
 */
import type { LedgerViolationCode } from "@cb/domain";

/** T-041 `checkLedger` codes that the SQL checks compute (the PLAN §8.4 invariant in brackets). */
export const LEDGER_INVARIANT_CODES = [
  "ALLOCATIONS_EXCEED_PAYMENT", // [1] Σ allocations of a payment ≤ payment amount
  "CREDIT_MISMATCH", // [2] unallocated remainder = credit
  "LEDGER_MISMATCH", // [3] Σ ledger = charges − payments − credit adj + reversals
  "NEGATIVE_OUTSTANDING", // [4] Σ allocations of an invoice ≤ its charges
  "ALLOCATIONS_EXCEED_CREDIT_ADJUSTMENT", // Σ allocations of a credit adjustment ≤ its amount
  "NEGATIVE_SOURCE_ALLOCATIONS", // Σ allocations of a source ≥ 0
  "REVERSED_PAYMENT_STILL_ALLOCATED", // a reversed payment's rows net to 0
  "NEGATIVE_ALLOCATION_WITHOUT_REVERSAL", // negative rows only from reversals
  "OUTSTANDING_EXCEEDS_CHARGES", // Σ allocations of an invoice ≥ 0
  "BALANCE_MISMATCH", // customer_balances.balance_paise = Σ ledger
] as const satisfies readonly LedgerViolationCode[];

/** Every code the job reports, in report order. Stable: stored in `invariant_checks.counts`. */
export const INVARIANT_CODES = [
  ...LEDGER_INVARIANT_CODES,
  "OVERLAPPING_ASSIGNMENTS",
  "DUPLICATE_REGULAR_INVOICE",
] as const;

export type InvariantCode = (typeof INVARIANT_CODES)[number];

/** What a violation row points at. */
export type InvariantEntityType =
  | "customer"
  | "payment"
  | "adjustment"
  | "invoice"
  | "allocation"
  | "vc_assignment";

/** One violating row: ids and paise amounts only (no names, phones or free text). */
export interface InvariantViolation {
  readonly code: InvariantCode;
  readonly entityType: InvariantEntityType;
  readonly entityId: string;
  /** The customer the row belongs to. */
  readonly customerId: string | null;
  /** Amounts (paise) and ids that show the breach, e.g. `{ ledgerPaise, storedPaise }`. */
  readonly details: Readonly<Record<string, string | number>>;
}

/** The result of checking one tenant. */
export interface TenantInvariantReport {
  readonly operatorId: string;
  /** Total violating rows over all codes. */
  readonly violationCount: number;
  /** Code → number of violating rows (codes with none are left out). */
  readonly counts: Readonly<Partial<Record<InvariantCode, number>>>;
  /** Up to `sampleLimit` rows per code, in {@link INVARIANT_CODES} order. */
  readonly samples: readonly InvariantViolation[];
}

export function isInvariantCode(value: unknown): value is InvariantCode {
  return typeof value === "string" && (INVARIANT_CODES as readonly string[]).includes(value);
}
