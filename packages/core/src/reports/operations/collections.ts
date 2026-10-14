/**
 * `reports.collections` (T-081, FR-023, BRD §12 "Daily lineman collections: how much cash and UPI
 * did each lineman collect? Lineman, business date, payment method"; B-014 / RULE-14 "cash and UPI
 * are separate collection methods and report totals").
 *
 * Every payment of the chosen IST days (`payments.business_date`: the IST day the money was taken,
 * the day of the lineman's collection session), per person and day and per person over the days,
 * **cash and UPI always apart**. A payment the owner cancelled is never counted; it is listed apart
 * (count and amount). Office counter payments are included under the Owner / Staff member who took
 * them, and payments brought from the old app under "no collector", so the totals equal the payment
 * register (T-048 `listPayments`) for the same days and person (tested).
 *
 * Reconciliation (tested): a lineman's day equals T-062's running totals on `collection_sessions`
 * (cash expected, UPI, payments; the phone's payments are the only ones a lineman has), and the
 * counted cash + UPI equal −Σ the ledger entries of those payments and their undos.
 *
 * As of now: payments that reached the office (`posted_at`) and undos made (`at`) before the call's
 * clock; one REPEATABLE READ snapshot, so the rows, the people and the totals agree. One statement
 * with GROUPING SETS (day × person, person, all). Capability `reports.view` (Owner, Staff).
 */
import { users } from "@cb/db";
import { type BusinessDate, businessDate, err, ok, type Paise, toPaise } from "@cb/domain";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDateInput, idInput } from "../../collections/inputs";
import { defineService } from "../../context/service";
import { notFound } from "../../errors/errors";
import { REPORT_MAX_PAGE_SIZE, resolveAsOf } from "../dues/as-of";
import { resolveDayRange } from "./range";
import type {
  CollectionAmounts,
  CollectionDayRow,
  CollectionPersonRow,
  CollectionsReport,
  ReportPerson,
} from "./types";

/** Day rows per page. */
export const COLLECTIONS_PAGE_SIZE = 50;

export const CollectionsReportInput = z.object({
  /** First IST day (default: `to`). */
  from: businessDateInput.optional(),
  /** Last IST day (default: today). */
  to: businessDateInput.optional(),
  /** Who took the money (a user of this business). */
  collectorId: idInput.optional(),
  page: z.int().min(1).max(10_000).default(1),
  /** Rows per page (T-082: an export reads bigger pages). */
  pageSize: z.int().min(1).max(REPORT_MAX_PAGE_SIZE).default(COLLECTIONS_PAGE_SIZE),
});

export type CollectionsReportCommand = z.output<typeof CollectionsReportInput>;

interface GroupRow extends Record<string, unknown> {
  /** 0: day × person, 2: person, 3: all (GROUPING(business_date, collector_id)). */
  grouping: number;
  business_date: string | null;
  collector_id: string | null;
  cash: string;
  upi: string;
  count: number;
  cancelled_count: number;
  cancelled: string;
  days: number;
  people: number;
}

function amounts(row: GroupRow): CollectionAmounts {
  return {
    cashPaise: toPaise(row.cash),
    upiPaise: toPaise(row.upi),
    count: Number(row.count),
    cancelledCount: Number(row.cancelled_count),
    cancelledPaise: toPaise(row.cancelled),
  };
}

export const collectionsReport = defineService({
  name: "reports.collections",
  capability: "reports.view",
  input: CollectionsReportInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx, now }) {
    const asOf = resolveAsOf(now, undefined);
    if (!asOf.ok) return err(asOf.error);
    const range = resolveDayRange(now, input);
    if (!range.ok) return err(range.error);
    const { from, to } = range.value;
    const { operatorId } = ctx;

    const people = await tx
      .select({ id: users.id, name: users.name, role: users.role, status: users.status })
      .from(users)
      .where(eq(users.operatorId, operatorId))
      .orderBy(asc(users.name), asc(users.id));
    if (input.collectorId !== undefined && !people.some((u) => u.id === input.collectorId)) {
      return err(notFound());
    }
    const byId = new Map(people.map((u) => [u.id, u]));

    const cutoff = sql`${asOf.value.cutoff.toISOString()}::timestamptz`;
    const collectorFilter =
      input.collectorId === undefined
        ? sql``
        : sql`AND p.collector_id = ${input.collectorId}::uuid`;
    const grouped = await tx.execute<GroupRow>(sql`
      WITH p AS (
        SELECT p.business_date, p.collector_id, p.method, p.amount_paise,
               (r.id IS NOT NULL) AS cancelled
          FROM payments p
          LEFT JOIN payment_reversals r
                 ON r.operator_id = p.operator_id AND r.payment_id = p.id AND r.at < ${cutoff}
         WHERE p.operator_id = ${operatorId}::uuid
           AND p.business_date BETWEEN ${from}::date AND ${to}::date
           AND p.posted_at < ${cutoff} ${collectorFilter})
      SELECT GROUPING(p.business_date, p.collector_id)::int AS grouping,
             p.business_date::text AS business_date, p.collector_id,
             coalesce(sum(p.amount_paise) FILTER (WHERE p.method = 'cash' AND NOT p.cancelled), 0)::text AS cash,
             coalesce(sum(p.amount_paise) FILTER (WHERE p.method = 'upi' AND NOT p.cancelled), 0)::text AS upi,
             (count(*) FILTER (WHERE NOT p.cancelled))::int AS count,
             (count(*) FILTER (WHERE p.cancelled))::int AS cancelled_count,
             coalesce(sum(p.amount_paise) FILTER (WHERE p.cancelled), 0)::text AS cancelled,
             count(DISTINCT p.business_date)::int AS days,
             count(DISTINCT coalesce(p.collector_id::text, '-'))::int AS people
        FROM p
       GROUP BY GROUPING SETS ((p.business_date, p.collector_id), (p.collector_id), ())`);

    const person = (collectorId: string | null) => {
      const user = collectorId === null ? undefined : byId.get(collectorId);
      return {
        collectorId,
        name: user?.name ?? null,
        role: user?.role ?? null,
        active: user ? user.status === "active" : false,
      };
    };
    const byName = (
      a: { name: string | null; collectorId: string | null },
      b: { name: string | null; collectorId: string | null },
    ) => {
      // The old app's payments (no collector) last.
      if (a.collectorId === null || b.collectorId === null) {
        return a.collectorId === b.collectorId ? 0 : a.collectorId === null ? 1 : -1;
      }
      return (
        (a.name ?? "").localeCompare(b.name ?? "", "en") ||
        a.collectorId.localeCompare(b.collectorId)
      );
    };

    let totalsRow: GroupRow | undefined;
    const days: CollectionDayRow[] = [];
    const byCollector: CollectionPersonRow[] = [];
    for (const row of grouped.rows) {
      const grouping = Number(row.grouping);
      if (grouping === 3) totalsRow = row;
      else if (grouping === 2) {
        byCollector.push({ ...person(row.collector_id), ...amounts(row), days: Number(row.days) });
      } else if (row.business_date !== null) {
        days.push({
          ...person(row.collector_id),
          ...amounts(row),
          businessDate: businessDate(row.business_date),
        });
      }
    }
    byCollector.sort(byName);
    days.sort((a, b) => b.businessDate.localeCompare(a.businessDate) || byName(a, b));

    const pageSize = input.pageSize;
    const zero = toPaise(0);
    const totals = totalsRow
      ? { ...amounts(totalsRow), people: Number(totalsRow.people) }
      : {
          cashPaise: zero as Paise,
          upiPaise: zero as Paise,
          count: 0,
          cancelledCount: 0,
          cancelledPaise: zero as Paise,
          people: 0,
        };
    const report: CollectionsReport = {
      asOf: { at: asOf.value.at, date: asOf.value.date, endOfDay: false },
      from: from as BusinessDate,
      to: to as BusinessDate,
      collectors: people.map(
        (u): ReportPerson => ({
          id: u.id,
          name: u.name,
          role: u.role,
          active: u.status === "active",
        }),
      ),
      totals,
      byCollector,
      rows: days.slice((input.page - 1) * pageSize, input.page * pageSize),
      rowCount: days.length,
      page: input.page,
      pageSize,
    };
    return ok(report);
  },
});
