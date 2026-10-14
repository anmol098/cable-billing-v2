/**
 * Builds roster rows, open bills and recent payments from the database (T-060). Internal to the
 * mobile sync services: always called inside their tenant transaction (RLS on), and every query
 * also names `operator_id` so the `(operator_id, …)` indexes are used.
 *
 * Values are clipped to the contract's limits (`@cb/contracts` `RosterCustomer`): the server
 * validates every response before sending it, and one over-long legacy value must not fail a whole
 * roster page. Today's write paths stay well inside the limits (T-033 `CUSTOMER_FIELD_LIMITS`).
 */
import type { InvoiceKind, PaymentMethod, Tx } from "@cb/db";
import { type Paise, period, toPaise } from "@cb/domain";
import { sql } from "drizzle-orm";
import type { RosterConnection, RosterOpenBill, RosterRecentPayment, RosterRow } from "./types";
import { RECENT_PAYMENTS_LIMIT } from "./types";

/** The contract's string limits (`@cb/contracts` customers.ts). */
export const WIRE_LIMITS = Object.freeze({
  code: 64,
  name: 200,
  phone: 20,
  address: 500,
  areaName: 200,
  vcNumber: 64,
  documentNumber: 64,
  personName: 200,
});

/** The contract's provisional reference format (`P-{device_code}-{seq}`). */
const PROVISIONAL_REF = /^P-[A-Z0-9]{3}-[0-9]{4,9}$/;

/** At most `max` UTF-16 units (the contract's `maxLength`), never splitting a character. */
export function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  let out = "";
  for (const ch of value) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

const clipOrNull = (value: string | null, max: number) =>
  value === null || value === "" ? null : clip(value, max);

/** `to_char` pattern for an ISO-8601 UTC instant with milliseconds. */
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const iso = (column: string) => sql.raw(`to_char(${column} AT TIME ZONE 'UTC', ${ISO})`);

/** A Postgres array literal of uuids (ids come from the database or a validated input). */
export function uuidArray(ids: readonly string[]): string {
  return `{${ids.join(",")}}`;
}

interface CustomerSqlRow extends Record<string, unknown> {
  id: string;
  customer_code: string;
  customer_code_norm: string;
  name: string;
  phone: string | null;
  alt_phone: string | null;
  address: string | null;
  status: "active" | "inactive";
  area_id: string | null;
  area_name: string | null;
  balance_paise: string;
  credit_paise: string;
  updated_at: string;
}

interface ConnectionSqlRow extends Record<string, unknown> {
  customer_id: string;
  vc_number: string;
  vc_number_norm: string;
  status: "active" | "suspended";
}

interface BillsSummarySqlRow extends Record<string, unknown> {
  customer_id: string;
  count: number;
  outstanding: string;
  oldest: string;
}

/**
 * The roster rows of `ids` (any status), keyed by id. Ids that are not the tenant's are simply
 * missing (RLS and the operator filter).
 */
export async function loadRosterRows(
  tx: Tx,
  operatorId: string,
  ids: readonly string[],
): Promise<Map<string, RosterRow>> {
  const result = new Map<string, RosterRow>();
  if (ids.length === 0) return result;
  const list = uuidArray(ids);

  const customers = await tx.execute<CustomerSqlRow>(sql`
    SELECT c.id, c.customer_code, c.customer_code_norm, c.name, c.phone, c.alt_phone, c.address,
      c.status, a.id AS area_id, a.name AS area_name,
      coalesce(b.balance_paise, 0)::text AS balance_paise,
      coalesce(b.credit_paise, 0)::text AS credit_paise,
      ${iso("coalesce(v.changed_at, greatest(c.updated_at, b.updated_at))")} AS updated_at
    FROM customers c
    LEFT JOIN areas a ON a.operator_id = c.operator_id AND a.id = c.area_id
    LEFT JOIN customer_balances b ON b.operator_id = c.operator_id AND b.customer_id = c.id
    LEFT JOIN roster_versions v ON v.operator_id = c.operator_id AND v.customer_id = c.id
    WHERE c.operator_id = ${operatorId}::uuid AND c.id = ANY(${list}::uuid[])`);

  const connections = await tx.execute<ConnectionSqlRow>(sql`
    SELECT s.customer_id, a.vc_number, a.vc_number_norm, s.status
    FROM vc_assignments s
    JOIN vc_assets a ON a.operator_id = s.operator_id AND a.id = s.vc_asset_id
    WHERE s.operator_id = ${operatorId}::uuid AND s.customer_id = ANY(${list}::uuid[])
      AND s.status <> 'disconnected'
    ORDER BY s.customer_id, s.start_date, s.id`);

  // An open bill: an issued invoice with outstanding = charges − Σ its allocation rows > 0
  // (T-041 invoiceOutstanding). Moves with customer_balances in the same transaction.
  const bills = await tx.execute<BillsSummarySqlRow>(sql`
    SELECT o.customer_id, count(*)::int AS count, sum(o.outstanding)::text AS outstanding,
      min(o.period)::text AS oldest
    FROM (
      SELECT i.customer_id, i.period,
        i.charges_paise - coalesce((SELECT sum(al.amount_paise) FROM allocations al
          WHERE al.operator_id = i.operator_id AND al.invoice_id = i.id), 0) AS outstanding
      FROM invoices i
      WHERE i.operator_id = ${operatorId}::uuid AND i.customer_id = ANY(${list}::uuid[])
        AND i.status = 'issued'
    ) o
    WHERE o.outstanding > 0
    GROUP BY o.customer_id`);

  const connectionsOf = new Map<string, RosterConnection[]>();
  for (const row of connections.rows) {
    const vc = row.vc_number.length <= WIRE_LIMITS.vcNumber ? row.vc_number : row.vc_number_norm;
    const list = connectionsOf.get(row.customer_id) ?? [];
    list.push({ vcNumber: clip(vc, WIRE_LIMITS.vcNumber), status: row.status });
    connectionsOf.set(row.customer_id, list);
  }
  const billsOf = new Map(bills.rows.map((row) => [row.customer_id, row]));

  for (const row of customers.rows) {
    const code = row.customer_code.trim();
    const summary = billsOf.get(row.id);
    result.set(row.id, {
      id: row.id,
      code: code.length >= 1 && code.length <= WIRE_LIMITS.code ? code : row.customer_code_norm,
      name: clip(row.name, WIRE_LIMITS.name),
      phone: clipOrNull(row.phone, WIRE_LIMITS.phone),
      altPhone: clipOrNull(row.alt_phone, WIRE_LIMITS.phone),
      address: clipOrNull(row.address, WIRE_LIMITS.address),
      area:
        row.area_id === null || row.area_name === null
          ? null
          : { id: row.area_id, name: clip(row.area_name, WIRE_LIMITS.areaName) },
      active: row.status === "active",
      connections: connectionsOf.get(row.id) ?? [],
      balancePaise: toPaise(row.balance_paise),
      creditPaise: toPaise(row.credit_paise),
      openBills: summary
        ? {
            count: summary.count,
            outstandingPaise: toPaise(summary.outstanding),
            oldestPeriod: period(summary.oldest),
          }
        : { count: 0, outstandingPaise: toPaise(0), oldestPeriod: null },
      updatedAt: new Date(row.updated_at),
    });
  }
  return result;
}

interface OpenBillSqlRow extends Record<string, unknown> {
  id: string;
  invoice_number: string;
  kind: InvoiceKind;
  period: string;
  charges_paise: string;
  outstanding: string;
}

/** The customer's unpaid bills, oldest first (period, then id: the allocation order, T-041). */
export async function loadOpenBills(
  tx: Tx,
  operatorId: string,
  customerId: string,
): Promise<RosterOpenBill[]> {
  const rows = await tx.execute<OpenBillSqlRow>(sql`
    SELECT i.id, i.invoice_number, i.kind, i.period::text AS period,
      i.charges_paise::text AS charges_paise,
      (i.charges_paise - coalesce(sum(al.amount_paise), 0))::text AS outstanding
    FROM invoices i
    LEFT JOIN allocations al ON al.operator_id = i.operator_id AND al.invoice_id = i.id
    WHERE i.operator_id = ${operatorId}::uuid AND i.customer_id = ${customerId}::uuid
      AND i.status = 'issued'
    GROUP BY i.id
    HAVING i.charges_paise - coalesce(sum(al.amount_paise), 0) > 0
    ORDER BY i.period, i.id`);
  return rows.rows.map((row) => ({
    invoiceId: row.id,
    invoiceNumber: clip(row.invoice_number, WIRE_LIMITS.documentNumber),
    kind: row.kind,
    period: period(row.period),
    chargesPaise: toPaise(row.charges_paise),
    outstandingPaise: toPaise(row.outstanding),
  }));
}

interface PaymentSqlRow extends Record<string, unknown> {
  id: string;
  amount_paise: string;
  method: PaymentMethod;
  recorded_at: string;
  posted_at: string;
  receipt_number: string;
  provisional_ref: string | null;
  collector_name: string | null;
  reversed: boolean;
}

/**
 * The customer's latest payments with a receipt, newest first (posted time, then id). Every
 * posted payment has its receipt (T-046); a migrated payment without one is not listed (the
 * contract needs a receipt number).
 */
export async function loadRecentPayments(
  tx: Tx,
  operatorId: string,
  customerId: string,
  limit = RECENT_PAYMENTS_LIMIT,
): Promise<RosterRecentPayment[]> {
  const rows = await tx.execute<PaymentSqlRow>(sql`
    SELECT p.id, p.amount_paise::text AS amount_paise, p.method,
      ${iso("p.recorded_at")} AS recorded_at, ${iso("p.posted_at")} AS posted_at,
      r.receipt_number, r.provisional_ref, u.name AS collector_name,
      EXISTS (SELECT 1 FROM payment_reversals x
        WHERE x.operator_id = p.operator_id AND x.payment_id = p.id) AS reversed
    FROM payments p
    JOIN receipts r ON r.operator_id = p.operator_id AND r.payment_id = p.id
    LEFT JOIN users u ON u.operator_id = p.operator_id AND u.id = p.collector_id
    WHERE p.operator_id = ${operatorId}::uuid AND p.customer_id = ${customerId}::uuid
    ORDER BY p.posted_at DESC, p.id DESC
    LIMIT ${limit}`);
  return rows.rows.map((row) => ({
    paymentId: row.id,
    amountPaise: toPaise(row.amount_paise) as Paise,
    method: row.method,
    recordedAt: new Date(row.recorded_at),
    postedAt: new Date(row.posted_at),
    receiptNumber: clip(row.receipt_number, WIRE_LIMITS.documentNumber),
    provisionalRef:
      row.provisional_ref !== null && PROVISIONAL_REF.test(row.provisional_ref)
        ? row.provisional_ref
        : null,
    collectedByName: clipOrNull(row.collector_name, WIRE_LIMITS.personName),
    reversed: Boolean(row.reversed),
  }));
}
