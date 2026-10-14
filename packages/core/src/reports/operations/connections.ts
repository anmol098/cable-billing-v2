/**
 * `reports.connections` (T-081, FR-005/FR-006, BRD §12 "VC status / rental report: which
 * connections are active, suspended or disconnected and what rental applies? Area, status, plan,
 * effective date").
 *
 * Every connection (VC assignment) that had started by the chosen IST day (default today), with:
 * - its **status during that day**, by T-040's rule (`assignmentStatusOn`): a start counts from the
 *   start of its day, a stop / start again / removal from the **next** day (only changes effective
 *   before the day decide it; a removed connection's `end_date` is its last day). "Since" is the
 *   first day of that status;
 * - the **rent and plan of the day's month**, by T-040's `rentalForPeriod`: the last plan change
 *   effective on or before the month's last day, else the rent it started with.
 *
 * Both are computed in SQL from `vc_assignments` + `assignment_events` with the mapping T-044's
 * billing run uses (events in effective order, recorded order `at, id` within a day; the first
 * plan change's "from" is the starting rent and plan). The tests compare every connection on many
 * days with T-040's functions, and the active rent on the 1st with the month's bill run.
 *
 * Filters: area, status, plan (or "own amount"). The totals row (connections by status, Σ rent of
 * the active ones, customers with an active connection) covers every matching connection.
 *
 * As of now (the call's clock); one REPEATABLE READ snapshot. Capability `reports.view`.
 */
import { ASSIGNMENT_STATUSES, type AssignmentStatus, areas, plans } from "@cb/db";
import {
  type BusinessDate,
  businessDate,
  businessDateOf,
  compareBusinessDates,
  err,
  ok,
  periodEnd,
  periodOf,
  toPaise,
} from "@cb/domain";
import { asc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDateInput, idInput } from "../../collections/inputs";
import { defineService } from "../../context/service";
import { notFound, serviceError } from "../../errors/errors";
import { REPORT_MAX_PAGE_SIZE, resolveAsOf } from "../dues/as-of";
import type { ConnectionReportRow, ConnectionsReport } from "./types";

/** Connections per page. */
export const CONNECTIONS_PAGE_SIZE = 50;

/** The plan filter's value for connections with their own amount (no plan). */
export const OWN_AMOUNT = "own" as const;

export const ConnectionsReportInput = z.object({
  /** The IST day the statuses are for (default today; not after today). */
  date: businessDateInput.optional(),
  areaId: idInput.optional(),
  status: z.enum(ASSIGNMENT_STATUSES).optional(),
  /** A plan id, or `own` for connections with their own amount. */
  plan: z.union([z.literal(OWN_AMOUNT), idInput]).optional(),
  page: z.int().min(1).max(10_000).default(1),
  /** Rows per page (T-082: an export reads bigger pages). */
  pageSize: z.int().min(1).max(REPORT_MAX_PAGE_SIZE).default(CONNECTIONS_PAGE_SIZE),
});

export type ConnectionsReportCommand = z.output<typeof ConnectionsReportInput>;

interface TotalsDbRow extends Record<string, unknown> {
  connections: number;
  active: number;
  suspended: number;
  disconnected: number;
  active_rent: string;
  active_customers: number;
}

interface ConnectionDbRow extends Record<string, unknown> {
  id: string;
  customer_id: string;
  customer_code: string;
  customer_name: string;
  area_id: string | null;
  area_name: string | null;
  vc_number: string;
  status: AssignmentStatus;
  since: string;
  start_date: string;
  end_date: string | null;
  plan_id: string | null;
  plan_name: string | null;
  rent: string;
}

export const connectionsReport = defineService({
  name: "reports.connections",
  capability: "reports.view",
  input: ConnectionsReportInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx, now }) {
    const asOf = resolveAsOf(now, undefined);
    if (!asOf.ok) return err(asOf.error);
    const today = businessDateOf(now);
    const day: BusinessDate = input.date ?? today;
    if (compareBusinessDates(day, today) > 0) {
      return err(
        serviceError("VALIDATION", "The day is in the future", {
          fields: [{ path: "date", code: "future" }],
        }),
      );
    }
    const { operatorId } = ctx;

    const areaRows = await tx
      .select({ id: areas.id, name: areas.name })
      .from(areas)
      .where(eq(areas.operatorId, operatorId))
      .orderBy(asc(areas.name), asc(areas.id));
    if (input.areaId !== undefined && !areaRows.some((area) => area.id === input.areaId)) {
      return err(notFound());
    }
    const planRows = await tx
      .select({
        id: plans.id,
        name: plans.name,
        monthlyAmountPaise: plans.monthlyAmountPaise,
        status: plans.status,
      })
      .from(plans)
      .where(eq(plans.operatorId, operatorId))
      .orderBy(asc(plans.name), asc(plans.id));
    if (
      input.plan !== undefined &&
      input.plan !== OWN_AMOUNT &&
      !planRows.some((plan) => plan.id === input.plan)
    ) {
      return err(notFound());
    }

    const op = sql`${operatorId}::uuid`;
    const d = sql`${day}::date`;
    const monthEnd = sql`${periodEnd(periodOf(day))}::date`;
    const filters: SQL[] = [sql`true`];
    if (input.areaId !== undefined) filters.push(sql`cu.area_id = ${input.areaId}::uuid`);
    if (input.status !== undefined) filters.push(sql`c.status = ${input.status}`);
    if (input.plan === OWN_AMOUNT) filters.push(sql`c.plan_id IS NULL`);
    else if (input.plan !== undefined) filters.push(sql`c.plan_id = ${input.plan}::uuid`);
    const where = sql.join(filters, sql` AND `);

    // The status during the day and the rent of its month, per connection (see the module notes).
    const cte = sql`
      a AS (
        SELECT va.id, va.customer_id, va.vc_asset_id, va.start_date, va.end_date, va.plan_id,
               va.rental_amount_paise
          FROM vc_assignments va
         WHERE va.operator_id = ${op} AND va.start_date <= ${d}),
      last_change AS (
        SELECT DISTINCT ON (e.assignment_id) e.assignment_id, e.type, e.effective_date
          FROM assignment_events e
         WHERE e.operator_id = ${op}
           AND e.type IN ('suspended', 'reactivated', 'disconnected')
           AND e.effective_date < ${d}
         ORDER BY e.assignment_id, e.effective_date DESC, e.at DESC, e.id DESC),
      last_plan AS (
        SELECT DISTINCT ON (e.assignment_id) e.assignment_id, e.to_plan_id, e.to_rental_paise
          FROM assignment_events e
         WHERE e.operator_id = ${op} AND e.type = 'plan_changed'
           AND e.effective_date <= ${monthEnd}
         ORDER BY e.assignment_id, e.effective_date DESC, e.at DESC, e.id DESC),
      first_plan AS (
        SELECT DISTINCT ON (e.assignment_id) e.assignment_id, e.from_plan_id, e.from_rental_paise
          FROM assignment_events e
         WHERE e.operator_id = ${op} AND e.type = 'plan_changed'
         ORDER BY e.assignment_id, e.at, e.id),
      c AS (
        SELECT a.id, a.customer_id, a.vc_asset_id, a.start_date, a.end_date,
               CASE WHEN a.end_date IS NOT NULL AND a.end_date < ${d} THEN 'disconnected'
                    WHEN lc.type = 'suspended' THEN 'suspended'
                    WHEN lc.type = 'disconnected' THEN 'disconnected'
                    ELSE 'active' END AS status,
               CASE WHEN a.end_date IS NOT NULL AND a.end_date < ${d} THEN a.end_date + 1
                    WHEN lc.assignment_id IS NOT NULL THEN lc.effective_date + 1
                    ELSE a.start_date END AS since,
               CASE WHEN lp.assignment_id IS NOT NULL THEN lp.to_plan_id
                    WHEN fp.assignment_id IS NOT NULL THEN fp.from_plan_id
                    ELSE a.plan_id END AS plan_id,
               coalesce(lp.to_rental_paise, fp.from_rental_paise, a.rental_amount_paise) AS rent
          FROM a
          LEFT JOIN last_change lc ON lc.assignment_id = a.id
          LEFT JOIN last_plan lp ON lp.assignment_id = a.id
          LEFT JOIN first_plan fp ON fp.assignment_id = a.id),
      m AS (
        SELECT c.*, cu.customer_code, cu.name AS customer_name, cu.area_id
          FROM c
          JOIN customers cu ON cu.operator_id = ${op} AND cu.id = c.customer_id
         WHERE ${where})`;

    const [totals] = (
      await tx.execute<TotalsDbRow>(sql`
        WITH ${cte}
        SELECT count(*)::int AS connections,
               (count(*) FILTER (WHERE m.status = 'active'))::int AS active,
               (count(*) FILTER (WHERE m.status = 'suspended'))::int AS suspended,
               (count(*) FILTER (WHERE m.status = 'disconnected'))::int AS disconnected,
               coalesce(sum(m.rent) FILTER (WHERE m.status = 'active'), 0)::text AS active_rent,
               (count(DISTINCT m.customer_id) FILTER (WHERE m.status = 'active'))::int
                 AS active_customers
          FROM m`)
    ).rows;

    const pageSize = input.pageSize;
    const listed = await tx.execute<ConnectionDbRow>(sql`
      WITH ${cte}
      SELECT m.id, m.customer_id, m.customer_code, m.customer_name, m.area_id,
             ar.name AS area_name, vc.vc_number, m.status, m.since::text AS since,
             m.start_date::text AS start_date, m.end_date::text AS end_date, m.plan_id,
             pl.name AS plan_name, m.rent::text AS rent
        FROM m
        JOIN vc_assets vc ON vc.operator_id = ${op} AND vc.id = m.vc_asset_id
        LEFT JOIN areas ar ON ar.operator_id = ${op} AND ar.id = m.area_id
        LEFT JOIN plans pl ON pl.operator_id = ${op} AND pl.id = m.plan_id
       ORDER BY m.customer_code, vc.vc_number, m.start_date, m.id
       LIMIT ${pageSize} OFFSET ${(input.page - 1) * pageSize}`);

    const report: ConnectionsReport = {
      asOf: { at: asOf.value.at, date: asOf.value.date, endOfDay: false },
      date: day,
      isToday: day === today,
      areas: areaRows,
      plans: planRows.map((plan) => ({
        id: plan.id,
        name: plan.name,
        monthlyAmountPaise: toPaise(plan.monthlyAmountPaise),
        retired: plan.status === "retired",
      })),
      totals: {
        connections: Number(totals?.connections ?? 0),
        byStatus: {
          active: Number(totals?.active ?? 0),
          suspended: Number(totals?.suspended ?? 0),
          disconnected: Number(totals?.disconnected ?? 0),
        },
        activeRentPaise: toPaise(totals?.active_rent ?? "0"),
        activeCustomers: Number(totals?.active_customers ?? 0),
      },
      rows: listed.rows.map(
        (row): ConnectionReportRow => ({
          assignmentId: row.id,
          customerId: row.customer_id,
          customerCode: row.customer_code,
          customerName: row.customer_name,
          areaId: row.area_id,
          areaName: row.area_name,
          vcNumber: row.vc_number,
          status: row.status,
          since: businessDate(row.since),
          startDate: businessDate(row.start_date),
          endDate: row.end_date === null ? null : businessDate(row.end_date),
          planId: row.plan_id,
          planName: row.plan_name,
          rentPaise: toPaise(row.rent),
        }),
      ),
      page: input.page,
      pageSize,
    };
    return ok(report);
  },
});
