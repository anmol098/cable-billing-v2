/**
 * The customer statement (T-049; BRD §12 "Customer account statement: what was charged, paid,
 * adjusted and remains due?"; FR-011; B-009; PLAN §12.1 Customers → History).
 *
 * `customerStatement` (`statements.customer`, capability `dashboard.view`: Owner and Staff; READ
 * ONLY, REPEATABLE READ so the lines, the opening balance and `customer_balances` come from one
 * snapshot): the customer's ledger entries in an IST date range, in posting order, each with the
 * balance after it and the document it posts (bill, payment, undone payment, bill change), plus
 * the opening and closing balances and the account now. The arithmetic is `rules.ts`.
 *
 * Exactness: the statement is the ledger. closing = opening + Σ lines = Σ every entry up to the
 * end of `to`; "as of now" that is Σ every entry, which the posting services keep equal to
 * `customer_balances.balance_paise` (`now.ledgerPaise` vs `now.balancePaise` shows it).
 *
 * Another tenant's customer id → NOT_FOUND (RLS hides the row).
 */
import { customerBalances, operators, parseOperatorSettings } from "@cb/db";
import {
  type BusinessDate,
  businessDate,
  businessDateOf,
  compareBusinessDates,
  err,
  isBusinessDate,
  ok,
  type Period,
  toPaise,
  period as toPeriod,
} from "@cb/domain";
import { and, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import { notFound, serviceError } from "../errors/errors";
import { resolveStatementRange, runningBalance } from "./rules";
import type {
  CustomerStatementView,
  StatementCustomer,
  StatementLine,
  StatementLineType,
} from "./types";

const uuid = z.uuid().transform((value) => value.toLowerCase());

/** An IST business date `YYYY-MM-DD`. */
export const BusinessDateInput = z
  .string()
  .refine((value) => isBusinessDate(value), { message: "not a date" })
  .transform((value) => businessDate(value));

export const CustomerStatementInput = z
  .object({
    customerId: uuid,
    /** First day (IST), included. Missing: from the first line ever. */
    from: BusinessDateInput.optional(),
    /** Last day (IST), included. Missing or later than today: today. */
    to: BusinessDateInput.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.from && value.to && compareBusinessDates(value.from, value.to) > 0) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "from is after to" });
    }
  });
export type CustomerStatementCommand = z.output<typeof CustomerStatementInput>;

const dateOf = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const periodOrNull = (value: string | null): Period | null =>
  value === null ? null : toPeriod(value);

interface CustomerRow extends Record<string, unknown> {
  id: string;
  customer_code: string;
  name: string;
  phone: string | null;
  address: string | null;
  status: "active" | "inactive";
  area_name: string | null;
}

interface LineRow extends Record<string, unknown> {
  id: string;
  seq: string | number;
  type: StatementLineType;
  amount_paise: string | number;
  at: Date | string;
  bill_id: string | null;
  invoice_number: string | null;
  bill_period: string | null;
  bill_kind: "regular" | "opening_balance" | null;
  bill_status: "issued" | "void" | null;
  payment_id: string | null;
  payment_method: "cash" | "upi" | null;
  payment_source: "android" | "web" | "migration" | null;
  payment_amount_paise: string | number | null;
  payment_business_date: string | null;
  receipt_number: string | null;
  collector_name: string | null;
  payment_reversed: boolean | null;
  reversal_id: string | null;
  reversal_reason: string | null;
  reversal_at: Date | string | null;
  adjustment_id: string | null;
  adjustment_direction: "debit" | "credit" | null;
  adjustment_source: "plan_change" | "mid_month_start" | "manual" | "migration" | null;
  adjustment_period: string | null;
  adjustment_reason: string | null;
}

interface SumRow extends Record<string, unknown> {
  total: string | number | null;
}

/** The range's ledger entries with the documents they post. */
function lineQuery(operatorId: string, customerId: string, filters: SQL[]): SQL {
  const where = sql.join(
    [
      sql`e.operator_id = ${operatorId}::uuid`,
      sql`e.customer_id = ${customerId}::uuid`,
      ...filters,
    ],
    sql` AND `,
  );
  return sql`
    SELECT e.id, e.seq, e.type, e.amount_paise, e.at,
      i.id AS bill_id, i.invoice_number, i.period::text AS bill_period, i.kind AS bill_kind,
      i.status AS bill_status,
      p.id AS payment_id, p.method AS payment_method, p.source AS payment_source,
      p.amount_paise AS payment_amount_paise, p.business_date::text AS payment_business_date,
      rc.receipt_number, u.name AS collector_name,
      (undo.id IS NOT NULL) AS payment_reversed,
      pr.id AS reversal_id, pr.reason AS reversal_reason, pr.at AS reversal_at,
      a.id AS adjustment_id, a.direction AS adjustment_direction, a.source AS adjustment_source,
      a.period::text AS adjustment_period, a.reason AS adjustment_reason
    FROM ledger_entries e
    LEFT JOIN invoices i ON i.operator_id = e.operator_id AND i.id = e.invoice_id
    LEFT JOIN payment_reversals pr
      ON pr.operator_id = e.operator_id AND pr.id = e.payment_reversal_id
    LEFT JOIN payments p
      ON p.operator_id = e.operator_id AND p.id = coalesce(e.payment_id, pr.payment_id)
    LEFT JOIN payment_reversals undo ON undo.operator_id = p.operator_id AND undo.payment_id = p.id
    LEFT JOIN receipts rc ON rc.operator_id = p.operator_id AND rc.payment_id = p.id
    LEFT JOIN users u ON u.operator_id = p.operator_id AND u.id = p.collector_id
    LEFT JOIN adjustments a ON a.operator_id = e.operator_id AND a.id = e.adjustment_id
    WHERE ${where}
    ORDER BY e.seq`;
}

function toLine(row: LineRow) {
  const at = dateOf(row.at);
  return {
    id: row.id,
    seq: Number(row.seq),
    type: row.type,
    at,
    date: businessDateOf(at),
    amountPaise: toPaise(row.amount_paise),
    bill:
      row.bill_id !== null &&
      row.invoice_number !== null &&
      row.bill_period !== null &&
      row.bill_kind !== null &&
      row.bill_status !== null
        ? {
            id: row.bill_id,
            invoiceNumber: row.invoice_number,
            period: toPeriod(row.bill_period),
            kind: row.bill_kind,
            status: row.bill_status,
          }
        : null,
    payment:
      row.payment_id !== null &&
      row.payment_method !== null &&
      row.payment_source !== null &&
      row.payment_amount_paise !== null &&
      row.payment_business_date !== null
        ? {
            id: row.payment_id,
            method: row.payment_method,
            source: row.payment_source,
            amountPaise: toPaise(row.payment_amount_paise),
            receiptNumber: row.receipt_number,
            businessDate: businessDate(row.payment_business_date),
            collectorName: row.collector_name,
            reversed: row.payment_reversed === true,
          }
        : null,
    reversal:
      row.reversal_id !== null && row.reversal_reason !== null && row.reversal_at !== null
        ? { id: row.reversal_id, reason: row.reversal_reason, at: dateOf(row.reversal_at) }
        : null,
    adjustment:
      row.adjustment_id !== null &&
      row.adjustment_direction !== null &&
      row.adjustment_source !== null
        ? {
            id: row.adjustment_id,
            direction: row.adjustment_direction,
            source: row.adjustment_source,
            period: periodOrNull(row.adjustment_period),
            reason: row.adjustment_reason,
          }
        : null,
  };
}

/** `statements.customer`: the customer's statement for an IST date range. */
export const customerStatement = defineService({
  name: "statements.customer",
  capability: "dashboard.view",
  input: CustomerStatementInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx, now }) {
    const op = ctx.operatorId;
    const customerRows = await tx.execute<CustomerRow>(sql`
      SELECT c.id, c.customer_code, c.name, c.phone, c.address, c.status, a.name AS area_name
      FROM customers c
      LEFT JOIN areas a ON a.operator_id = c.operator_id AND a.id = c.area_id
      WHERE c.operator_id = ${op}::uuid AND c.id = ${input.customerId}::uuid`);
    const customerRow = customerRows.rows[0];
    if (!customerRow) return err(notFound());
    const [operator] = await tx.select().from(operators).where(eq(operators.id, op));
    if (!operator) return err(notFound());
    const settings = parseOperatorSettings(operator.settings);

    const today: BusinessDate = businessDateOf(now);
    if (input.from && compareBusinessDates(input.from, today) > 0) {
      // The range would end (today) before it starts.
      return err(
        serviceError("VALIDATION", "Input failed validation", {
          fields: [{ path: "from", code: "custom" }],
        }),
      );
    }
    const range = resolveStatementRange({ from: input.from, to: input.to }, today);
    const filters: SQL[] = [];
    if (range.startsAt) filters.push(sql`e.at >= ${range.startsAt.toISOString()}::timestamptz`);
    if (range.endsBefore) {
      filters.push(sql`e.at < ${range.endsBefore.toISOString()}::timestamptz`);
    }
    const lineRows = await tx.execute<LineRow>(lineQuery(op, customerRow.id, filters));

    const sumWhere = (extra: SQL | null) => sql`
      SELECT coalesce(sum(e.amount_paise), 0)::text AS total
      FROM ledger_entries e
      WHERE e.operator_id = ${op}::uuid AND e.customer_id = ${customerRow.id}::uuid
        ${extra === null ? sql`` : sql`AND ${extra}`}`;
    const opening = range.startsAt
      ? (
          await tx.execute<SumRow>(
            sumWhere(sql`e.at < ${range.startsAt.toISOString()}::timestamptz`),
          )
        ).rows[0]?.total
      : 0;
    const ledgerTotal = (await tx.execute<SumRow>(sumWhere(null))).rows[0]?.total ?? 0;
    const [balance] = await tx
      .select()
      .from(customerBalances)
      .where(
        and(eq(customerBalances.operatorId, op), eq(customerBalances.customerId, customerRow.id)),
      );

    const computed = runningBalance(toPaise(opening ?? 0), lineRows.rows.map(toLine));
    const customer: StatementCustomer = {
      id: customerRow.id,
      code: customerRow.customer_code,
      name: customerRow.name,
      areaName: customerRow.area_name,
      phone: customerRow.phone,
      address: customerRow.address,
      status: customerRow.status,
    };
    const lines: readonly StatementLine[] = computed.lines;
    const view: CustomerStatementView = {
      customer,
      operator: {
        name: operator.name,
        phone: settings.office_phone ?? operator.phone,
        address: operator.address,
        language: settings.default_language,
      },
      range: { from: range.from, to: range.to, today: range.today, asOfNow: range.asOfNow },
      openingBalancePaise: computed.openingBalancePaise,
      lines,
      hiddenLines: computed.hiddenLines,
      totals: computed.totals,
      closingBalancePaise: computed.closingBalancePaise,
      now: {
        balancePaise: toPaise(balance?.balancePaise ?? 0),
        creditPaise: toPaise(balance?.creditPaise ?? 0),
        oldestDuePeriod: periodOrNull(balance?.oldestDuePeriod ?? null),
        ledgerPaise: toPaise(ledgerTotal),
      },
      generatedAt: now,
    };
    return ok(view);
  },
});
