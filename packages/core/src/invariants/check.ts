/**
 * The tenant-wide invariant check (T-052): one read-only, set-based SQL statement per tenant.
 *
 * It computes, for every customer, payment, credit adjustment, invoice, allocation and VC
 * assignment of the tenant at once, the rules of `codes.ts`, exactly as T-041's `checkLedger`
 * defines the ledger ones for one customer (same sums, same reading of reversals; tested for
 * equivalence). Being one statement, it sees one snapshot of the tables: a payment or bill posted
 * while it runs is either wholly in it or wholly out, so a concurrent writer can't cause a false
 * alarm. It reads and never writes.
 *
 * Cost: each table of the tenant is scanned once through its `operator_id` index (allocations are
 * grouped once per source and once per invoice), so it is linear in the tenant's rows, with no
 * per-customer round trips. The overlap check is a self-join per VC (GiST index of the EXCLUDE
 * constraint).
 */
import type { Tx } from "@cb/db";
import { sql } from "drizzle-orm";
import {
  INVARIANT_CODES,
  type InvariantCode,
  type InvariantEntityType,
  type InvariantViolation,
  isInvariantCode,
  type TenantInvariantReport,
} from "./codes";

/** Violating rows kept per code (the count is always exact). */
export const DEFAULT_INVARIANT_SAMPLE_LIMIT = 20;
/** Per-tenant statement timeout, so one huge or locked-up tenant can't stall the nightly run. */
export const DEFAULT_INVARIANT_STATEMENT_TIMEOUT_MS = 60_000;

export interface CheckTenantInvariantsOptions {
  readonly sampleLimit?: number;
  readonly statementTimeoutMs?: number;
}

interface ViolationRow extends Record<string, unknown> {
  code: string;
  entity_type: InvariantEntityType;
  entity_id: string;
  customer_id: string | null;
  details: Record<string, string | number>;
  total: number;
}

/**
 * Checks one tenant. Call it inside `withTenant(operatorId, …)` (RLS limits every table to the
 * tenant; the explicit `operator_id` filters let Postgres use the tenant indexes). A read-only
 * transaction is enough.
 */
export async function checkTenantInvariants(
  tx: Tx,
  operatorId: string,
  options: CheckTenantInvariantsOptions = {},
): Promise<TenantInvariantReport> {
  const sampleLimit = options.sampleLimit ?? DEFAULT_INVARIANT_SAMPLE_LIMIT;
  const timeoutMs = options.statementTimeoutMs ?? DEFAULT_INVARIANT_STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(sampleLimit) || sampleLimit < 0) {
    throw new TypeError("checkTenantInvariants: sampleLimit must be a non-negative integer");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("checkTenantInvariants: statementTimeoutMs must be a positive integer");
  }
  await tx.execute(sql`SELECT set_config('statement_timeout', ${String(timeoutMs)}, true)`);
  const op = sql`${operatorId}::uuid`;
  const result = await tx.execute<ViolationRow>(sql`
    WITH
    alloc_by_source AS (
      SELECT source_type, source_id, sum(amount_paise) AS allocated
        FROM allocations WHERE operator_id = ${op}
       GROUP BY source_type, source_id),
    alloc_by_invoice AS (
      SELECT invoice_id, sum(amount_paise) AS allocated
        FROM allocations WHERE operator_id = ${op}
       GROUP BY invoice_id),
    pay AS (
      SELECT p.id, p.customer_id, p.amount_paise::numeric AS amount,
             (r.id IS NOT NULL) AS reversed, coalesce(a.allocated, 0) AS allocated
        FROM payments p
        LEFT JOIN payment_reversals r ON r.operator_id = p.operator_id AND r.payment_id = p.id
        LEFT JOIN alloc_by_source a ON a.source_type = 'payment' AND a.source_id = p.id
       WHERE p.operator_id = ${op}),
    cadj AS (
      SELECT ad.id, ad.customer_id, ad.amount_paise::numeric AS amount,
             coalesce(a.allocated, 0) AS allocated
        FROM adjustments ad
        LEFT JOIN alloc_by_source a
          ON a.source_type = 'credit_adjustment' AND a.source_id = ad.id
       WHERE ad.operator_id = ${op} AND ad.direction = 'credit'),
    inv AS (
      SELECT i.id, i.customer_id, i.charges_paise::numeric AS charges,
             coalesce(a.allocated, 0) AS allocated
        FROM invoices i
        LEFT JOIN alloc_by_invoice a ON a.invoice_id = i.id
       WHERE i.operator_id = ${op}),
    led AS (
      SELECT customer_id, sum(amount_paise) AS total
        FROM ledger_entries WHERE operator_id = ${op}
       GROUP BY customer_id),
    bal AS (
      SELECT customer_id, balance_paise::numeric AS balance, credit_paise::numeric AS credit
        FROM customer_balances WHERE operator_id = ${op}),
    pay_sum AS (
      SELECT customer_id,
             sum(amount) AS paid,
             coalesce(sum(amount) FILTER (WHERE reversed), 0) AS reversed,
             coalesce(sum(amount - allocated) FILTER (WHERE NOT reversed), 0) AS remainder
        FROM pay GROUP BY customer_id),
    cadj_sum AS (
      SELECT customer_id, sum(amount) AS credited, sum(amount - allocated) AS remainder
        FROM cadj GROUP BY customer_id),
    inv_sum AS (
      SELECT customer_id, sum(charges) AS charges FROM inv GROUP BY customer_id),
    cust AS (
      SELECT c.customer_id,
             coalesce(b.balance, 0) AS stored_balance,
             coalesce(b.credit, 0) AS stored_credit,
             coalesce(l.total, 0) AS ledger,
             coalesce(i.charges, 0) - coalesce(p.paid, 0) - coalesce(ca.credited, 0)
               + coalesce(p.reversed, 0) AS expected_ledger,
             coalesce(p.remainder, 0) + coalesce(ca.remainder, 0) AS expected_credit
        FROM (SELECT customer_id FROM bal
              UNION SELECT customer_id FROM led
              UNION SELECT customer_id FROM inv
              UNION SELECT customer_id FROM pay
              UNION SELECT customer_id FROM cadj) c
        LEFT JOIN bal b ON b.customer_id = c.customer_id
        LEFT JOIN led l ON l.customer_id = c.customer_id
        LEFT JOIN inv_sum i ON i.customer_id = c.customer_id
        LEFT JOIN pay_sum p ON p.customer_id = c.customer_id
        LEFT JOIN cadj_sum ca ON ca.customer_id = c.customer_id),
    violations (code, entity_type, entity_id, customer_id, details) AS (
      -- [1] Σ allocations of a payment ≤ payment amount.
      SELECT 'ALLOCATIONS_EXCEED_PAYMENT'::text, 'payment'::text, id, customer_id,
             jsonb_build_object('allocatedPaise', allocated, 'amountPaise', amount)
        FROM pay WHERE allocated > amount
      UNION ALL
      -- [2] Unallocated remainder (non-reversed payments + credit adjustments) = stored credit.
      SELECT 'CREDIT_MISMATCH', 'customer', customer_id, customer_id,
             jsonb_build_object('expectedPaise', expected_credit, 'storedPaise', stored_credit)
        FROM cust WHERE stored_credit <> expected_credit
      UNION ALL
      -- [3] Σ ledger = Σ invoice charges − Σ payments − Σ credit adj + Σ reversed payments.
      SELECT 'LEDGER_MISMATCH', 'customer', customer_id, customer_id,
             jsonb_build_object('ledgerPaise', ledger, 'expectedPaise', expected_ledger)
        FROM cust WHERE ledger <> expected_ledger
      UNION ALL
      -- [4] Invoice outstanding (charges − Σ allocations) never below 0.
      SELECT 'NEGATIVE_OUTSTANDING', 'invoice', id, customer_id,
             jsonb_build_object('outstandingPaise', charges - allocated, 'chargesPaise', charges)
        FROM inv WHERE allocated > charges
      UNION ALL
      SELECT 'ALLOCATIONS_EXCEED_CREDIT_ADJUSTMENT', 'adjustment', id, customer_id,
             jsonb_build_object('allocatedPaise', allocated, 'amountPaise', amount)
        FROM cadj WHERE allocated > amount
      UNION ALL
      SELECT 'NEGATIVE_SOURCE_ALLOCATIONS', 'payment', id, customer_id,
             jsonb_build_object('allocatedPaise', allocated)
        FROM pay WHERE allocated < 0
      UNION ALL
      SELECT 'NEGATIVE_SOURCE_ALLOCATIONS', 'adjustment', id, customer_id,
             jsonb_build_object('allocatedPaise', allocated)
        FROM cadj WHERE allocated < 0
      UNION ALL
      SELECT 'REVERSED_PAYMENT_STILL_ALLOCATED', 'payment', id, customer_id,
             jsonb_build_object('allocatedPaise', allocated)
        FROM pay WHERE reversed AND allocated <> 0
      UNION ALL
      SELECT 'NEGATIVE_ALLOCATION_WITHOUT_REVERSAL', 'allocation', al.id, al.customer_id,
             jsonb_build_object('amountPaise', al.amount_paise, 'sourceId', al.source_id)
        FROM allocations al
       WHERE al.operator_id = ${op} AND al.amount_paise < 0
         AND NOT (al.reversal_id IS NOT NULL AND al.source_type = 'payment'
                  AND EXISTS (SELECT 1 FROM payment_reversals r
                               WHERE r.operator_id = al.operator_id
                                 AND r.payment_id = al.payment_id))
      UNION ALL
      SELECT 'OUTSTANDING_EXCEEDS_CHARGES', 'invoice', id, customer_id,
             jsonb_build_object('outstandingPaise', charges - allocated, 'chargesPaise', charges)
        FROM inv WHERE allocated < 0
      UNION ALL
      -- The read model agrees with the ledger.
      SELECT 'BALANCE_MISMATCH', 'customer', customer_id, customer_id,
             jsonb_build_object('ledgerPaise', ledger, 'storedPaise', stored_balance)
        FROM cust WHERE stored_balance <> ledger
      UNION ALL
      -- RULE-06 / BR-03: no two assignments of one VC overlap (both ends inclusive, NULL end open).
      SELECT 'OVERLAPPING_ASSIGNMENTS', 'vc_assignment', b.id, b.customer_id,
             jsonb_build_object('vcAssetId', b.vc_asset_id, 'overlapsAssignmentId', a.id)
        FROM vc_assignments a
        JOIN vc_assignments b
          ON b.operator_id = a.operator_id AND b.vc_asset_id = a.vc_asset_id AND a.id < b.id
         AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]')
       WHERE a.operator_id = ${op}
      UNION ALL
      -- RULE-05: one regular invoice per customer and period.
      SELECT 'DUPLICATE_REGULAR_INVOICE', 'customer', customer_id, customer_id,
             jsonb_build_object('period', period::text, 'invoiceCount', count(*))
        FROM invoices
       WHERE operator_id = ${op} AND kind = 'regular'
       GROUP BY customer_id, period
      HAVING count(*) > 1)
    SELECT code, entity_type, entity_id::text AS entity_id, customer_id::text AS customer_id,
           details, total::int AS total
      FROM (SELECT v.*,
                   count(*) OVER (PARTITION BY code) AS total,
                   row_number() OVER (PARTITION BY code ORDER BY entity_id, details::text) AS rn
              FROM violations v) ranked
     WHERE rn <= ${sampleLimit} OR rn = 1
     ORDER BY code, rn`);

  const counts: Partial<Record<InvariantCode, number>> = {};
  const samples: InvariantViolation[] = [];
  const sampled = new Map<InvariantCode, number>();
  for (const row of result.rows) {
    if (!isInvariantCode(row.code)) throw new Error(`unknown invariant code ${row.code}`);
    counts[row.code] = Number(row.total);
    const taken = sampled.get(row.code) ?? 0;
    if (taken < sampleLimit) {
      sampled.set(row.code, taken + 1);
      samples.push({
        code: row.code,
        entityType: row.entity_type,
        entityId: row.entity_id,
        customerId: row.customer_id,
        details: row.details,
      });
    }
  }
  const rank = (code: InvariantCode) => INVARIANT_CODES.indexOf(code);
  samples.sort((a, b) => rank(a.code) - rank(b.code));
  const violationCount = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
  return { operatorId, violationCount, counts: sortedCounts(counts), samples };
}

function sortedCounts(
  counts: Partial<Record<InvariantCode, number>>,
): Partial<Record<InvariantCode, number>> {
  const out: Partial<Record<InvariantCode, number>> = {};
  for (const code of INVARIANT_CODES) {
    const n = counts[code];
    if (n !== undefined) out[code] = n;
  }
  return out;
}
