/**
 * `reports.bill_register` (T-080, FR-023, BRD §12 "Invoice register: which bills were issued and
 * what is their status? Period, customer, status, amount"): the bills of one month or a range of
 * months (up to 12), with what is paid and still due, filtered by area and pay state, with totals
 * over every matching bill and the as-of moment.
 *
 * **One register, one definition.** The Bills section's `/bills/register` (T-047 `listBills`,
 * one month) and this report use the same rules: a bill's paid amount is Σ its allocation rows
 * (payments and credit, net of undone payments: reversal rows are negative), still due =
 * charges − paid (T-041 `invoiceOutstanding`), and the pay state is T-047's `billPayState`. Every
 * bill counts, as in the ledger (a cancelled bill keeps its ledger entry until a void flow exists,
 * T-023). For one month and no filters the totals equal `listBills`' totals (tested).
 *
 * Totals reconcile to the ledger (tested): billed = Σ the bills' `invoice` / `opening_balance`
 * ledger entries; paid = Σ their allocations; and over all months, Σ still due − Σ unused advance
 * = Σ the ledger (the dues report).
 *
 * As of now: rows written after the call's clock are left out, and the statements read one
 * REPEATABLE READ snapshot, so rows and totals agree. Capability `reports.view` (Owner, Staff).
 */
import { areas } from "@cb/db";
import { err, monthsBetween, ok, type Period, toPaise, period as toPeriod } from "@cb/domain";
import { asc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { BillingPeriodInput } from "../../billing/services";
import { BILL_PAY_STATES, type BillPayState, type BillRow } from "../../billing/view-types";
import { billPayState } from "../../billing/views";
import { idInput } from "../../collections/inputs";
import { defineService } from "../../context/service";
import { notFound } from "../../errors/errors";
import { REPORT_MAX_PAGE_SIZE, resolveAsOf } from "../dues/as-of";
import type { BillRegisterReport } from "./types";

/** Rows per page. */
export const BILL_REPORT_PAGE_SIZE = 50;
/** Months one report may cover. */
export const BILL_REPORT_MAX_MONTHS = 12;

export const BillRegisterReportInput = z
  .object({
    from: BillingPeriodInput,
    to: BillingPeriodInput,
    areaId: idInput.optional(),
    payState: z.enum(BILL_PAY_STATES).optional(),
    page: z.int().min(1).max(10_000).default(1),
    /** Rows per page (T-082: an export reads bigger pages). */
    pageSize: z.int().min(1).max(REPORT_MAX_PAGE_SIZE).default(BILL_REPORT_PAGE_SIZE),
  })
  .superRefine((value, ctx) => {
    const span = monthsBetween(value.from, value.to);
    if (span < 0) ctx.addIssue({ code: "custom", path: ["to"], message: "to is before from" });
    else if (span >= BILL_REPORT_MAX_MONTHS) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "too many months" });
    }
  });

export type BillRegisterReportCommand = z.output<typeof BillRegisterReportInput>;

interface TotalsRow extends Record<string, unknown> {
  count: number;
  charges: string;
  paid: string;
  unpaid: number;
  part_paid: number;
  paid_count: number;
  no_charge: number;
  void: number;
}

interface BillDbRow extends Record<string, unknown> {
  id: string;
  invoice_number: string;
  period: string;
  kind: "regular" | "opening_balance";
  status: "issued" | "void";
  charges: string;
  paid: string;
  customer_id: string;
  customer_code: string;
  name: string;
  area_name: string | null;
}

export const billRegisterReport = defineService({
  name: "reports.bill_register",
  capability: "reports.view",
  input: BillRegisterReportInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx, now }) {
    const asOf = resolveAsOf(now, undefined);
    if (!asOf.ok) return err(asOf.error);
    const { operatorId } = ctx;
    const areaRows = await tx
      .select({ id: areas.id, name: areas.name })
      .from(areas)
      .where(eq(areas.operatorId, operatorId))
      .orderBy(asc(areas.name), asc(areas.id));
    if (input.areaId !== undefined && !areaRows.some((area) => area.id === input.areaId)) {
      return err(notFound());
    }
    const op = sql`${operatorId}::uuid`;
    const cutoff = sql`${asOf.value.cutoff.toISOString()}::timestamptz`;
    const areaFilter =
      input.areaId === undefined ? sql`` : sql`AND c.area_id = ${input.areaId}::uuid`;
    // Same CASE as T-047's listBills (and `billPayState`).
    const stateFilter: SQL =
      input.payState === undefined ? sql`` : sql`AND b.pay_state = ${input.payState}`;
    const cte = sql`
      bills AS (
        SELECT i.id, i.invoice_number, i.period, i.kind, i.status, i.customer_id,
               i.charges_paise AS charges, coalesce(p.paid, 0) AS paid,
               CASE
                 WHEN i.status = 'void' THEN 'void'
                 WHEN i.charges_paise = 0 THEN 'no_charge'
                 WHEN coalesce(p.paid, 0) >= i.charges_paise THEN 'paid'
                 WHEN coalesce(p.paid, 0) > 0 THEN 'part_paid'
                 ELSE 'unpaid' END AS pay_state
          FROM invoices i
          JOIN customers c ON c.operator_id = i.operator_id AND c.id = i.customer_id
          LEFT JOIN LATERAL (
            SELECT sum(a.amount_paise) AS paid
              FROM allocations a
             WHERE a.operator_id = i.operator_id AND a.invoice_id = i.id
               AND a.created_at < ${cutoff}) p ON true
         WHERE i.operator_id = ${op}
           AND i.period BETWEEN ${input.from}::date AND ${input.to}::date
           AND i.issued_at < ${cutoff} ${areaFilter})`;

    const [totals] = (
      await tx.execute<TotalsRow>(sql`
        WITH ${cte}
        SELECT count(*)::int AS count,
               coalesce(sum(b.charges), 0)::text AS charges,
               coalesce(sum(b.paid), 0)::text AS paid,
               (count(*) FILTER (WHERE b.pay_state = 'unpaid'))::int AS unpaid,
               (count(*) FILTER (WHERE b.pay_state = 'part_paid'))::int AS part_paid,
               (count(*) FILTER (WHERE b.pay_state = 'paid'))::int AS paid_count,
               (count(*) FILTER (WHERE b.pay_state = 'no_charge'))::int AS no_charge,
               (count(*) FILTER (WHERE b.pay_state = 'void'))::int AS void
          FROM bills b
         WHERE true ${stateFilter}`)
    ).rows;

    const pageSize = input.pageSize;
    const listed = await tx.execute<BillDbRow>(sql`
      WITH ${cte}
      SELECT b.id, b.invoice_number, b.period::text AS period, b.kind, b.status,
             b.charges::text AS charges, b.paid::text AS paid, b.customer_id,
             c.customer_code, c.name, ar.name AS area_name
        FROM bills b
        JOIN customers c ON c.operator_id = ${op} AND c.id = b.customer_id
        LEFT JOIN areas ar ON ar.operator_id = c.operator_id AND ar.id = c.area_id
       WHERE true ${stateFilter}
       ORDER BY b.period DESC, c.customer_code, b.invoice_number, b.id
       LIMIT ${pageSize} OFFSET ${(input.page - 1) * pageSize}`);

    const chargesTotal = toPaise(totals?.charges ?? "0");
    const paidTotal = toPaise(totals?.paid ?? "0");
    const byState: Record<BillPayState, number> = {
      unpaid: Number(totals?.unpaid ?? 0),
      part_paid: Number(totals?.part_paid ?? 0),
      paid: Number(totals?.paid_count ?? 0),
      no_charge: Number(totals?.no_charge ?? 0),
      void: Number(totals?.void ?? 0),
    };
    const report: BillRegisterReport = {
      asOf: { at: asOf.value.at, date: asOf.value.date, endOfDay: false },
      from: input.from,
      to: input.to,
      areas: areaRows,
      totals: {
        count: Number(totals?.count ?? 0),
        chargesPaise: chargesTotal,
        paidPaise: paidTotal,
        outstandingPaise: toPaise(chargesTotal - paidTotal),
        byState,
      },
      rows: listed.rows.map((row): BillRow => {
        const charges = toPaise(row.charges);
        const paid = toPaise(row.paid);
        return {
          id: row.id,
          invoiceNumber: row.invoice_number,
          period: toPeriod(row.period) as Period,
          kind: row.kind,
          status: row.status,
          customer: {
            id: row.customer_id,
            code: row.customer_code,
            name: row.name,
            areaName: row.area_name,
          },
          chargesPaise: charges,
          paidPaise: paid,
          outstandingPaise: toPaise(charges - paid),
          payState: billPayState(row.status, charges, paid),
        };
      }),
      page: input.page,
      pageSize,
    };
    return ok(report);
  },
});
