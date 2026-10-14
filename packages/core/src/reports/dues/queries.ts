/**
 * `reports.dues` (T-080, FR-023, BRD §12 "Outstanding dues / ageing", PLAN §12.1): who owes money,
 * how much and for how long, by area, as of now or the end of a past IST day.
 *
 * Numbers come from the ledger (PLAN §7.2 "customer balance = Σ ledger_entries.amount"), never
 * from the `customer_balances` read model, so the report can be read as of a past day and always
 * adds up to the ledger: for any filter, Σ due − Σ advance = Σ ledger_entries of those customers
 * up to the as-of instant (tested). The ageing rule is in `ageing.ts`.
 *
 * Set-based: two SQL statements per call (totals by area + the list's totals, then the list page),
 * each scanning the tenant's ledger, allocations and bills once through their `operator_id`
 * indexes, in one REPEATABLE READ, READ ONLY transaction (one snapshot for both). Capability
 * `reports.view` (Owner, Staff); allowed in read-only mode. Another tenant's area id → NOT_FOUND.
 */
import { areas } from "@cb/db";
import { type BusinessDate, err, ok, type Paise, type Period, toPaise } from "@cb/domain";
import { asc, eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDateInput, idInput } from "../../collections/inputs";
import { defineService } from "../../context/service";
import { notFound } from "../../errors/errors";
import {
  AGEING_BUCKET_LIMITS,
  AGEING_BUCKETS,
  type AgeingBucket,
  type BucketAmounts,
} from "./ageing";
import { resolveAsOf } from "./as-of";
import {
  DUES_LIST_KINDS,
  type DuesAreaTotals,
  type DuesReport,
  type DuesRow,
  type DuesTotals,
} from "./types";

/** Rows per page of the list. */
export const DUES_PAGE_SIZE = 50;

export const DuesReportInput = z.object({
  /** A past IST date (as of the end of that day); default now. */
  asOfDate: businessDateInput.optional(),
  areaId: idInput.optional(),
  /** The list: customers who owe (default) or who have an advance. */
  kind: z.enum(DUES_LIST_KINDS).default("due"),
  /** The list (kind `due`): only customers with some due in this bucket. */
  bucket: z.enum(AGEING_BUCKETS).optional(),
  page: z.int().min(1).max(10_000).default(1),
});

export type DuesReportCommand = z.output<typeof DuesReportInput>;

const [D30, D60, D90] = AGEING_BUCKET_LIMITS;

/**
 * The per-customer CTEs (`led` … `per_customer`), as of `cutoff` (exclusive), ages counted to
 * `asOfDate`. `per_customer` has one row per customer with a non-zero balance (matching `areaId`):
 * `net`, `due`, `advance`, `b0`…`b3` (Σ = due), `oldest_period`, `oldest_bucket` (0…3).
 */
export function duesCte(input: {
  operatorId: string;
  cutoff: Date;
  asOfDate: BusinessDate;
  areaId?: string | undefined;
}): SQL {
  const op = sql`${input.operatorId}::uuid`;
  const cutoff = sql`${input.cutoff.toISOString()}::timestamptz`;
  const asOf = sql`${input.asOfDate}::date`;
  const bucketOf = (period: SQL) => sql`CASE
      WHEN ${asOf} - ${period} <= ${D30}::int THEN 0
      WHEN ${asOf} - ${period} <= ${D60}::int THEN 1
      WHEN ${asOf} - ${period} <= ${D90}::int THEN 2
      ELSE 3 END`;
  const areaFilter =
    input.areaId === undefined ? sql`` : sql`AND c.area_id = ${input.areaId}::uuid`;
  return sql`
    led AS (
      SELECT customer_id, sum(amount_paise) AS net
        FROM ledger_entries
       WHERE operator_id = ${op} AND at < ${cutoff}
       GROUP BY customer_id
      HAVING sum(amount_paise) <> 0),
    owing AS (SELECT customer_id, net FROM led WHERE net > 0),
    alloc AS (
      SELECT a.invoice_id, sum(a.amount_paise) AS allocated
        FROM allocations a
        JOIN owing o ON o.customer_id = a.customer_id
       WHERE a.operator_id = ${op} AND a.created_at < ${cutoff}
       GROUP BY a.invoice_id),
    unpaid AS (
      SELECT i.customer_id, i.id, i.period,
             i.charges_paise - coalesce(a.allocated, 0) AS outstanding
        FROM invoices i
        JOIN owing o ON o.customer_id = i.customer_id
        LEFT JOIN alloc a ON a.invoice_id = i.id
       WHERE i.operator_id = ${op} AND i.issued_at < ${cutoff}
         AND i.charges_paise - coalesce(a.allocated, 0) > 0),
    spread AS (
      SELECT u.customer_id, u.period,
             least(u.outstanding,
                   greatest(0, o.net - (sum(u.outstanding) OVER w - u.outstanding))) AS amount
        FROM unpaid u
        JOIN owing o ON o.customer_id = u.customer_id
      WINDOW w AS (PARTITION BY u.customer_id ORDER BY u.period DESC, u.id DESC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)),
    aged AS (
      SELECT customer_id, period, amount, ${bucketOf(sql`period`)} AS bucket
        FROM spread WHERE amount > 0),
    per_customer AS (
      SELECT l.customer_id, c.area_id, l.net,
             greatest(l.net, 0) AS due,
             greatest(-l.net, 0) AS advance,
             greatest(l.net, 0) - coalesce(sum(g.amount), 0)
               + coalesce(sum(g.amount) FILTER (WHERE g.bucket = 0), 0) AS b0,
             coalesce(sum(g.amount) FILTER (WHERE g.bucket = 1), 0) AS b1,
             coalesce(sum(g.amount) FILTER (WHERE g.bucket = 2), 0) AS b2,
             coalesce(sum(g.amount) FILTER (WHERE g.bucket = 3), 0) AS b3,
             min(g.period) AS oldest_period,
             coalesce(max(g.bucket), 0) AS oldest_bucket
        FROM led l
        JOIN customers c ON c.operator_id = ${op} AND c.id = l.customer_id
        LEFT JOIN aged g ON g.customer_id = l.customer_id
       WHERE true ${areaFilter}
       GROUP BY l.customer_id, c.area_id, l.net)`;
}

/** The list's WHERE over `per_customer pc`. */
function listFilter(input: DuesReportCommand): SQL {
  if (input.kind === "advance") return sql`pc.advance > 0`;
  if (input.bucket === undefined) return sql`pc.due > 0`;
  const column = sql.raw(`pc.b${AGEING_BUCKETS.indexOf(input.bucket)}`);
  return sql`pc.due > 0 AND ${column} > 0`;
}

const totalsColumns = sql`
  (count(*) FILTER (WHERE pc.due > 0))::int AS due_customers,
  coalesce(sum(pc.due), 0)::text AS due,
  coalesce(sum(pc.b0), 0)::text AS b0,
  coalesce(sum(pc.b1), 0)::text AS b1,
  coalesce(sum(pc.b2), 0)::text AS b2,
  coalesce(sum(pc.b3), 0)::text AS b3,
  (count(*) FILTER (WHERE pc.advance > 0))::int AS advance_customers,
  coalesce(sum(pc.advance), 0)::text AS advance,
  coalesce(sum(pc.net), 0)::text AS net,
  (count(*) FILTER (WHERE pc.b0 > 0))::int AS c0,
  (count(*) FILTER (WHERE pc.b1 > 0))::int AS c1,
  (count(*) FILTER (WHERE pc.b2 > 0))::int AS c2,
  (count(*) FILTER (WHERE pc.b3 > 0))::int AS c3`;

interface TotalsRow extends Record<string, unknown> {
  due_customers: number;
  due: string;
  b0: string;
  b1: string;
  b2: string;
  b3: string;
  advance_customers: number;
  advance: string;
  net: string;
  c0: number;
  c1: number;
  c2: number;
  c3: number;
}

interface SummaryRow extends TotalsRow {
  /** `area` (one area), `all` (every customer of the filter), `list` (the list's filters). */
  scope: "area" | "all" | "list";
  area_id: string | null;
}

interface ListRow extends Record<string, unknown> {
  customer_id: string;
  customer_code: string;
  name: string;
  phone: string | null;
  status: "active" | "inactive";
  area_id: string | null;
  area_name: string | null;
  net: string;
  due: string;
  advance: string;
  b0: string;
  b1: string;
  b2: string;
  b3: string;
  oldest_period: string | null;
  oldest_bucket: number;
}

const bucketIndex = (index: number): AgeingBucket => AGEING_BUCKETS[index] ?? "d0_30";

function bucketsOf(row: { b0: string; b1: string; b2: string; b3: string }): BucketAmounts {
  return {
    d0_30: toPaise(row.b0),
    d31_60: toPaise(row.b1),
    d61_90: toPaise(row.b2),
    d90_plus: toPaise(row.b3),
  };
}

function totalsOf(row: TotalsRow | undefined): DuesTotals {
  const zero = "0";
  return {
    dueCustomers: Number(row?.due_customers ?? 0),
    duePaise: toPaise(row?.due ?? zero),
    buckets: bucketsOf(row ?? { b0: zero, b1: zero, b2: zero, b3: zero }),
    advanceCustomers: Number(row?.advance_customers ?? 0),
    advancePaise: toPaise(row?.advance ?? zero),
    netPaise: toPaise(row?.net ?? zero),
    customersByBucket: {
      d0_30: Number(row?.c0 ?? 0),
      d31_60: Number(row?.c1 ?? 0),
      d61_90: Number(row?.c2 ?? 0),
      d90_plus: Number(row?.c3 ?? 0),
    },
  };
}

export const duesReport = defineService({
  name: "reports.dues",
  capability: "reports.view",
  input: DuesReportInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx, now }) {
    const asOf = resolveAsOf(now, input.asOfDate);
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
    const cte = duesCte({
      operatorId,
      cutoff: asOf.value.cutoff,
      asOfDate: asOf.value.date,
      areaId: input.areaId,
    });
    const filter = listFilter(input);

    const summary = await tx.execute<SummaryRow>(sql`
      WITH ${cte}
      SELECT CASE WHEN grouping(pc.area_id) = 1 THEN 'all' ELSE 'area' END AS scope,
             pc.area_id, ${totalsColumns}
        FROM per_customer pc
       GROUP BY GROUPING SETS ((pc.area_id), ())
      UNION ALL
      SELECT 'list', NULL, ${totalsColumns}
        FROM per_customer pc
       WHERE ${filter}`);

    const pageSize = DUES_PAGE_SIZE;
    const order =
      input.kind === "advance"
        ? sql`pc.advance DESC, c.customer_code, c.id`
        : sql`pc.oldest_period ASC NULLS LAST, pc.due DESC, c.customer_code, c.id`;
    const listed = await tx.execute<ListRow>(sql`
      WITH ${cte}
      SELECT pc.customer_id, c.customer_code, c.name, c.phone, c.status, pc.area_id,
             ar.name AS area_name, pc.net::text AS net, pc.due::text AS due,
             pc.advance::text AS advance, pc.b0::text AS b0, pc.b1::text AS b1,
             pc.b2::text AS b2, pc.b3::text AS b3, pc.oldest_period::text AS oldest_period,
             pc.oldest_bucket
        FROM per_customer pc
        JOIN customers c ON c.operator_id = ${operatorId}::uuid AND c.id = pc.customer_id
        LEFT JOIN areas ar ON ar.operator_id = c.operator_id AND ar.id = pc.area_id
       WHERE ${filter}
       ORDER BY ${order}
       LIMIT ${pageSize} OFFSET ${(input.page - 1) * pageSize}`);

    const areaNames = new Map(areaRows.map((area) => [area.id, area.name]));
    const byArea: DuesAreaTotals[] = summary.rows
      .filter((row) => row.scope === "area")
      .map((row) => ({
        areaId: row.area_id,
        areaName: row.area_id === null ? null : (areaNames.get(row.area_id) ?? null),
        ...totalsOf(row),
      }))
      .sort((a, b) => {
        if (a.areaName === null) return 1;
        if (b.areaName === null) return -1;
        return a.areaName.localeCompare(b.areaName, "en");
      });

    const rows: DuesRow[] = listed.rows.map((row) => {
      const due: Paise = toPaise(row.due);
      return {
        customerId: row.customer_id,
        customerCode: row.customer_code,
        customerName: row.name,
        phone: row.phone,
        customerStatus: row.status,
        areaId: row.area_id,
        areaName: row.area_name,
        balancePaise: toPaise(row.net),
        duePaise: due,
        advancePaise: toPaise(row.advance),
        buckets: bucketsOf(row),
        oldestDuePeriod: row.oldest_period === null ? null : (row.oldest_period as Period),
        oldestBucket: due > 0 ? bucketIndex(Number(row.oldest_bucket)) : null,
      };
    });

    const report: DuesReport = {
      asOf: { at: asOf.value.at, date: asOf.value.date, endOfDay: asOf.value.endOfDay },
      areas: areaRows,
      totals: totalsOf(summary.rows.find((row) => row.scope === "all")),
      byArea,
      rows,
      listTotals: totalsOf(summary.rows.find((row) => row.scope === "list")),
      page: input.page,
      pageSize,
    };
    return ok(report);
  },
});
