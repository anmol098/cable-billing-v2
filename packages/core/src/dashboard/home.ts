/**
 * `dashboard.home` (T-083, PLAN §12.1 "Home", §12.3, BRD §12 "Operator dashboard": "How is the
 * business performing today and this month?"): today's cash and UPI, this month's bills and
 * collections, the total due, the latest bill run, the alerts (handovers waiting, payments to
 * check, missed bill runs, the subscription) and the setup checklist's done flags.
 *
 * Every number is the same Σ as the page it links to (tested against those services):
 *
 * | Number | Same as |
 * |---|---|
 * | collected today / this month | `payments.list` totals for the IST days (`business_date`), undone payments left out |
 * | billed this month | `billing.months` for the current month (regular, issued bills) |
 * | due | Σ max(ledger balance, 0) per customer (PLAN §7.2; the dues report's total due) |
 * | latest run | the newest `billing_runs` row (the Bills page's run status) |
 * | missed runs | `billing.missed_runs` (status `skipped`) |
 * | handovers waiting | sessions with status `submitted` (T-062: the Linemen page's "to check") |
 * | payments to check | `payments.list` with status `to_check` |
 *
 * Set-based: three statements (one row of aggregates, the latest run, the subscription row), each
 * through the tables' `operator_id` indexes, in one REPEATABLE READ, READ ONLY transaction, so
 * every number comes from one snapshot even while payments are being posted. Capability
 * `dashboard.view` (Owner, Staff); allowed in read-only mode. "Today" is the IST date of the call's
 * clock.
 */
import { billingRuns, subscriptions } from "@cb/db";
import {
  type BusinessDate,
  businessDateOf,
  ok,
  type Period,
  periodOfInstant,
  toPaise,
} from "@cb/domain";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { toRunView } from "../billing/runs";
import { defineService } from "../context/service";
import { subscriptionSummary } from "./rules";
import type { CollectedMoney, HomeDashboard } from "./types";

export const HomeDashboardInput = z.object({}).strict();

interface AggregateRow extends Record<string, unknown> {
  today_cash: string;
  today_upi: string;
  today_count: number;
  month_cash: string;
  month_upi: string;
  month_count: number;
  bill_count: number;
  bill_total: string;
  due: string;
  due_customers: number;
  missed_count: number;
  oldest_missed: string | null;
  waiting_count: number;
  oldest_waiting: string | null;
  to_check: number;
  has_plans: boolean;
  has_customers: boolean;
  has_linemen: boolean;
  has_app: boolean;
}

/** The one-row aggregate query (every subquery filters `operator_id` too, besides RLS). */
function aggregateSql(operatorId: string, today: BusinessDate, period: Period) {
  const op = sql`${operatorId}::uuid`;
  const day = sql`${today}::date`;
  const month = sql`${period}::date`;
  return sql`
    WITH pay AS (
      SELECT
        coalesce(sum(p.amount_paise) FILTER (WHERE p.method = 'cash' AND p.business_date = ${day}), 0)::text AS today_cash,
        coalesce(sum(p.amount_paise) FILTER (WHERE p.method = 'upi' AND p.business_date = ${day}), 0)::text AS today_upi,
        (count(*) FILTER (WHERE p.business_date = ${day}))::int AS today_count,
        coalesce(sum(p.amount_paise) FILTER (WHERE p.method = 'cash'), 0)::text AS month_cash,
        coalesce(sum(p.amount_paise) FILTER (WHERE p.method = 'upi'), 0)::text AS month_upi,
        count(*)::int AS month_count
        FROM payments p
       WHERE p.operator_id = ${op}
         AND p.business_date BETWEEN ${month} AND ${day}
         AND NOT EXISTS (
           SELECT 1 FROM payment_reversals r
            WHERE r.operator_id = ${op} AND r.payment_id = p.id)),
    bills AS (
      SELECT count(*)::int AS bill_count, coalesce(sum(i.charges_paise), 0)::text AS bill_total
        FROM invoices i
       WHERE i.operator_id = ${op} AND i.period = ${month}
         AND i.kind = 'regular' AND i.status = 'issued'),
    dues AS (
      SELECT coalesce(sum(l.net), 0)::text AS due, count(*)::int AS due_customers
        FROM (SELECT sum(e.amount_paise) AS net
                FROM ledger_entries e
               WHERE e.operator_id = ${op}
               GROUP BY e.customer_id) l
       WHERE l.net > 0),
    missed AS (
      SELECT count(*)::int AS missed_count, min(b.period)::text AS oldest_missed
        FROM billing_runs b
       WHERE b.operator_id = ${op} AND b.status = 'skipped'),
    waiting AS (
      SELECT count(*)::int AS waiting_count, min(s.business_date)::text AS oldest_waiting
        FROM collection_sessions s
       WHERE s.operator_id = ${op} AND s.status = 'submitted'),
    to_check AS (
      SELECT count(*)::int AS to_check
        FROM payments p
       WHERE p.operator_id = ${op} AND p.review_status = 'needs_review')
    SELECT pay.*, bills.*, dues.*, missed.*, waiting.*, to_check.*,
      EXISTS (SELECT 1 FROM plans x WHERE x.operator_id = ${op}) AS has_plans,
      EXISTS (SELECT 1 FROM customers x WHERE x.operator_id = ${op}) AS has_customers,
      EXISTS (SELECT 1 FROM users x WHERE x.operator_id = ${op} AND x.role = 'lineman') AS has_linemen,
      EXISTS (SELECT 1 FROM devices x WHERE x.operator_id = ${op}) AS has_app
      FROM pay, bills, dues, missed, waiting, to_check`;
}

function money(cash: string, upi: string, count: number): CollectedMoney {
  return { cashPaise: toPaise(cash), upiPaise: toPaise(upi), paymentCount: Number(count) };
}

export const homeDashboard = defineService({
  name: "dashboard.home",
  capability: "dashboard.view",
  input: HomeDashboardInput,
  isolationLevel: "repeatable read",
  async run({ ctx, tx, now }) {
    const { operatorId } = ctx;
    const today = businessDateOf(now);
    const period = periodOfInstant(now);

    const aggregate = await tx.execute<AggregateRow>(aggregateSql(operatorId, today, period));
    const row = aggregate.rows[0];
    if (!row) throw new Error("dashboard.home: the aggregate query returned no row");

    const [latest] = await tx
      .select()
      .from(billingRuns)
      .where(eq(billingRuns.operatorId, operatorId))
      .orderBy(desc(billingRuns.period))
      .limit(1);

    const [subscription] = await tx
      .select({
        status: subscriptions.status,
        trialEndsAt: subscriptions.trialEndsAt,
        graceEndsAt: subscriptions.graceEndsAt,
      })
      .from(subscriptions)
      .where(eq(subscriptions.operatorId, operatorId));

    const view: HomeDashboard = {
      today,
      period,
      collectedToday: money(row.today_cash, row.today_upi, row.today_count),
      collectedThisMonth: money(row.month_cash, row.month_upi, row.month_count),
      billedThisMonth: { billCount: Number(row.bill_count), totalPaise: toPaise(row.bill_total) },
      due: { duePaise: toPaise(row.due), customerCount: Number(row.due_customers) },
      latestRun: latest ? toRunView(latest) : null,
      missedRuns: {
        count: Number(row.missed_count),
        oldestPeriod: (row.oldest_missed as Period | null) ?? null,
      },
      handoversWaiting: {
        count: Number(row.waiting_count),
        oldestDate: (row.oldest_waiting as BusinessDate | null) ?? null,
      },
      paymentsToCheck: Number(row.to_check),
      subscription: subscriptionSummary(subscription ?? null, today),
      setup: {
        plans: Boolean(row.has_plans),
        customers: Boolean(row.has_customers),
        linemen: Boolean(row.has_linemen),
        app: Boolean(row.has_app),
      },
    };
    return ok(view);
  },
});
