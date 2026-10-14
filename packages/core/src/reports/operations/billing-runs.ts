/**
 * `reports.billing_runs` (T-081, FR-010/FR-011, BRD §12 "Billing run report: which customers were
 * billed, skipped or failed and why? Operator, period, run ID, status/reason").
 *
 * One month's bill run (one run per month, T-023) with every customer it looked at
 * (`billing_run_items`): a new bill (`created`, with its number and amount), a bill that was
 * already there (`already_exists`), nothing to bill (`skipped`, e.g. every connection stopped) or a
 * problem (`failed`, with T-044's reason and how often it was tried). Problems first.
 *
 * Without a month: the latest run's month (or the current month when there is no run). Filters:
 * outcome, area. The totals row covers every matching customer; without filters it equals the
 * run's own counters and total (T-044 keeps them in step with the items: tested), and the new
 * bills' Σ charges equals Σ their ledger entries.
 *
 * As of now; one REPEATABLE READ snapshot. Capability `reports.view` (Owner, Staff).
 */
import {
  areas,
  BILLING_RUN_ITEM_OUTCOMES,
  type BillingRunItemOutcome,
  type BillingRunSkipReason,
  type BillingRunStatus,
  type BillingRunTrigger,
  billingRuns,
  users,
} from "@cb/db";
import { err, ok, type Period, periodOfInstant, toPaise, period as toPeriod } from "@cb/domain";
import { and, asc, desc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { BillingPeriodInput } from "../../billing/services";
import { idInput } from "../../collections/inputs";
import { defineService } from "../../context/service";
import { notFound } from "../../errors/errors";
import { resolveAsOf } from "../dues/as-of";
import type { BillingRunReport, BillingRunReportRow, BillingRunReportRun } from "./types";

/** Customers per page. */
export const BILLING_RUN_REPORT_PAGE_SIZE = 50;

export const BillingRunReportInput = z.object({
  /** The month (`YYYY-MM-01`); default the latest run's month. */
  period: BillingPeriodInput.optional(),
  outcome: z.enum(BILLING_RUN_ITEM_OUTCOMES).optional(),
  areaId: idInput.optional(),
  page: z.int().min(1).max(10_000).default(1),
});

export type BillingRunReportCommand = z.output<typeof BillingRunReportInput>;

interface TotalsDbRow extends Record<string, unknown> {
  customers: number;
  created: number;
  already_exists: number;
  skipped: number;
  failed: number;
  created_charges: string;
  existing_charges: string;
}

interface ItemDbRow extends Record<string, unknown> {
  id: string;
  customer_id: string;
  customer_code: string;
  name: string;
  area_name: string | null;
  outcome: BillingRunItemOutcome;
  reason: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  charges: string | null;
  attempts: number;
  updated_at: Date | string;
}

const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

export const billingRunReport = defineService({
  name: "reports.billing_runs",
  capability: "reports.view",
  input: BillingRunReportInput,
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

    const runRows = await tx
      .select({ id: billingRuns.id, period: billingRuns.period, status: billingRuns.status })
      .from(billingRuns)
      .where(eq(billingRuns.operatorId, operatorId))
      .orderBy(desc(billingRuns.period));
    const runs = runRows.map((run) => ({
      id: run.id,
      period: toPeriod(run.period),
      status: run.status as BillingRunStatus,
    }));
    const period: Period = input.period ?? runs[0]?.period ?? periodOfInstant(now);

    const [found] = await tx
      .select({ run: billingRuns, startedByName: users.name })
      .from(billingRuns)
      .leftJoin(
        users,
        and(eq(users.operatorId, billingRuns.operatorId), eq(users.id, billingRuns.actorId)),
      )
      .where(and(eq(billingRuns.operatorId, operatorId), eq(billingRuns.period, period)));
    const run: BillingRunReportRun | null = found
      ? {
          id: found.run.id,
          period: toPeriod(found.run.period),
          status: found.run.status,
          trigger: found.run.trigger as BillingRunTrigger,
          skipReason: found.run.skipReason as BillingRunSkipReason | null,
          startedAt: found.run.startedAt,
          finishedAt: found.run.finishedAt,
          createdAt: found.run.createdAt,
          startedByName: found.startedByName,
          customerCount: found.run.customerCount,
          createdCount: found.run.createdCount,
          alreadyExistsCount: found.run.alreadyExistsCount,
          skippedCount: found.run.skippedCount,
          failedCount: found.run.failedCount,
          totalChargesPaise: toPaise(found.run.totalChargesPaise),
        }
      : null;

    const zero = toPaise(0);
    const emptyTotals: BillingRunReport["totals"] = {
      customers: 0,
      byOutcome: { created: 0, already_exists: 0, skipped: 0, failed: 0 },
      createdChargesPaise: zero,
      alreadyExistsChargesPaise: zero,
    };
    const pageSize = BILLING_RUN_REPORT_PAGE_SIZE;
    const base = {
      asOf: { at: asOf.value.at, date: asOf.value.date, endOfDay: false },
      period,
      runs,
      areas: areaRows,
      run,
      page: input.page,
      pageSize,
    };
    if (!run) return ok({ ...base, totals: emptyTotals, rows: [] } satisfies BillingRunReport);

    const op = sql`${operatorId}::uuid`;
    const filters: SQL[] = [sql`it.operator_id = ${op}`, sql`it.run_id = ${run.id}::uuid`];
    if (input.outcome !== undefined) filters.push(sql`it.outcome = ${input.outcome}`);
    if (input.areaId !== undefined) filters.push(sql`c.area_id = ${input.areaId}::uuid`);
    const where = sql.join(filters, sql` AND `);
    const from = sql`
      FROM billing_run_items it
      JOIN customers c ON c.operator_id = it.operator_id AND c.id = it.customer_id
      LEFT JOIN invoices i ON i.operator_id = it.operator_id AND i.id = it.invoice_id`;

    const [totals] = (
      await tx.execute<TotalsDbRow>(sql`
        SELECT count(*)::int AS customers,
               (count(*) FILTER (WHERE it.outcome = 'created'))::int AS created,
               (count(*) FILTER (WHERE it.outcome = 'already_exists'))::int AS already_exists,
               (count(*) FILTER (WHERE it.outcome = 'skipped'))::int AS skipped,
               (count(*) FILTER (WHERE it.outcome = 'failed'))::int AS failed,
               coalesce(sum(i.charges_paise) FILTER (WHERE it.outcome = 'created'), 0)::text
                 AS created_charges,
               coalesce(sum(i.charges_paise) FILTER (WHERE it.outcome = 'already_exists'), 0)::text
                 AS existing_charges
        ${from}
        WHERE ${where}`)
    ).rows;

    const listed = await tx.execute<ItemDbRow>(sql`
      SELECT it.id, it.customer_id, c.customer_code, c.name, ar.name AS area_name, it.outcome,
             it.reason, it.invoice_id, i.invoice_number, i.charges_paise::text AS charges,
             it.attempts, it.updated_at
      ${from}
      LEFT JOIN areas ar ON ar.operator_id = c.operator_id AND ar.id = c.area_id
      WHERE ${where}
      ORDER BY CASE it.outcome WHEN 'failed' THEN 0 WHEN 'skipped' THEN 1
                               WHEN 'created' THEN 2 ELSE 3 END,
               c.customer_code, it.id
      LIMIT ${pageSize} OFFSET ${(input.page - 1) * pageSize}`);

    const report: BillingRunReport = {
      ...base,
      totals: {
        customers: Number(totals?.customers ?? 0),
        byOutcome: {
          created: Number(totals?.created ?? 0),
          already_exists: Number(totals?.already_exists ?? 0),
          skipped: Number(totals?.skipped ?? 0),
          failed: Number(totals?.failed ?? 0),
        },
        createdChargesPaise: toPaise(totals?.created_charges ?? "0"),
        alreadyExistsChargesPaise: toPaise(totals?.existing_charges ?? "0"),
      },
      rows: listed.rows.map(
        (row): BillingRunReportRow => ({
          itemId: row.id,
          customerId: row.customer_id,
          customerCode: row.customer_code,
          customerName: row.name,
          areaName: row.area_name,
          outcome: row.outcome,
          reason: row.reason,
          invoiceId: row.invoice_id,
          invoiceNumber: row.invoice_number,
          chargesPaise: row.charges === null ? null : toPaise(row.charges),
          attempts: Number(row.attempts),
          lastTriedAt: toDate(row.updated_at),
        }),
      ),
    };
    return ok(report);
  },
});
