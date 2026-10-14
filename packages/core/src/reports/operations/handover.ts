/**
 * `reports.handover` (T-081, FR-022, FR-023, BRD §12 "Cash handover reconciliation: does the cash
 * handed over match expected cash? Lineman, session, expected/actual cash, discrepancy").
 *
 * One row per lineman's day (`collection_sessions`) in the chosen IST days, with T-062's numbers:
 * - **cash expected now** = the running total of the day's phone cash payments, not cancelled
 *   (UPI is never part of the cash: shown apart);
 * - the **latest handover**: cash expected when it was handed over (the server's snapshot), cash
 *   handed over, the difference (handed − snapshot; negative = short) and the lineman's reason;
 * - the status (not handed over / waiting / sent back / accepted) and **what happened** (every
 *   `handover_events` step, oldest first, with who and when);
 * - a flag when the cash total moved after the handover (a late phone payment or a cancelled one).
 *
 * Filters: days, lineman, status, difference (short / extra). The totals row covers every matching
 * day. Reconciliation (tested): Σ cash expected = Σ the linemen's phone cash payments that are not
 * cancelled (the collections report's cash for them), and every row equals T-062's
 * `getLinemanDay` for that day.
 *
 * As of now; one REPEATABLE READ snapshot. Capability `reports.view` (Owner, Staff).
 */
import {
  COLLECTION_SESSION_STATUSES,
  type CollectionSessionStatus,
  type DiscrepancyReason,
  handoverEvents,
  type Tx,
  users,
} from "@cb/db";
import { businessDate, err, ok, toPaise } from "@cb/domain";
import { aliasedTable, and, asc, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { businessDateInput, idInput } from "../../collections/inputs";
import type { HandoverEventView } from "../../collections/types";
import { defineService } from "../../context/service";
import { notFound } from "../../errors/errors";
import { REPORT_MAX_PAGE_SIZE, resolveAsOf } from "../dues/as-of";
import { resolveDayRange } from "./range";
import type { HandoverReport, HandoverReportRow, ReportPerson } from "./types";

/** Days per page. */
export const HANDOVER_PAGE_SIZE = 50;
/** Days shown when no days are chosen (the last week). */
export const HANDOVER_DEFAULT_DAYS = 7;

export const HANDOVER_DIFFERENCES = ["short", "extra"] as const;
export type HandoverDifferenceFilter = (typeof HANDOVER_DIFFERENCES)[number];

export const HandoverReportInput = z.object({
  /** First IST day (default: 6 days before `to`). */
  from: businessDateInput.optional(),
  /** Last IST day (default: today). */
  to: businessDateInput.optional(),
  linemanId: idInput.optional(),
  status: z.enum(COLLECTION_SESSION_STATUSES).optional(),
  /** Only handovers with less (`short`) or more (`extra`) cash than expected. */
  difference: z.enum(HANDOVER_DIFFERENCES).optional(),
  page: z.int().min(1).max(10_000).default(1),
  /** Rows per page (T-082: an export reads bigger pages). */
  pageSize: z.int().min(1).max(REPORT_MAX_PAGE_SIZE).default(HANDOVER_PAGE_SIZE),
});

export type HandoverReportCommand = z.output<typeof HandoverReportInput>;

interface TotalsDbRow extends Record<string, unknown> {
  days: number;
  expected: string;
  upi: string;
  handed: string;
  not_handed: string;
  short: string;
  extra: string;
  difference_count: number;
  open: number;
  submitted: number;
  accepted: number;
  returned: number;
}

interface SessionDbRow extends Record<string, unknown> {
  id: string;
  collector_id: string;
  name: string;
  user_status: string;
  business_date: string;
  status: CollectionSessionStatus;
  cash_expected_paise: string;
  upi_total_paise: string;
  payment_count: number;
  handover_cash_expected_paise: string | null;
  cash_handed_over_paise: string | null;
  discrepancy_paise: string | null;
  discrepancy_reason: DiscrepancyReason | null;
  handover_note: string | null;
  submitted_at: Date | string | null;
  reviewed_at: Date | string | null;
  reviewer_name: string | null;
  review_note: string | null;
}

const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/** The handover history of some sessions (one query), each oldest first, with the actors' names. */
async function loadHistories(
  tx: Tx,
  operatorId: string,
  sessionIds: readonly string[],
): Promise<Map<string, HandoverEventView[]>> {
  const result = new Map<string, HandoverEventView[]>();
  if (sessionIds.length === 0) return result;
  const actor = aliasedTable(users, "actor");
  const rows = await tx
    .select({ event: handoverEvents, actorName: actor.name })
    .from(handoverEvents)
    .innerJoin(
      actor,
      and(eq(actor.operatorId, handoverEvents.operatorId), eq(actor.id, handoverEvents.actorId)),
    )
    .where(
      and(
        eq(handoverEvents.operatorId, operatorId),
        inArray(handoverEvents.sessionId, [...sessionIds]),
      ),
    )
    .orderBy(asc(handoverEvents.at), asc(handoverEvents.id));
  for (const { event, actorName } of rows) {
    const list = result.get(event.sessionId) ?? [];
    list.push({
      id: event.id,
      type: event.type,
      submissionId: event.submissionId,
      at: event.at,
      actorId: event.actorId,
      actorName,
      cashExpectedPaise: event.cashExpectedPaise,
      cashHandedOverPaise: event.cashHandedOverPaise,
      discrepancyPaise: event.discrepancyPaise,
      discrepancyReason: event.discrepancyReason,
      unsyncedPaymentCount: event.unsyncedPaymentCount,
      unsyncedCashPaise: event.unsyncedCashPaise,
      note: event.note,
    });
    result.set(event.sessionId, list);
  }
  return result;
}

export const handoverReport = defineService({
  name: "reports.handover",
  capability: "reports.view",
  input: HandoverReportInput,
  isolationLevel: "repeatable read",
  async run({ ctx, input, tx, now }) {
    const asOf = resolveAsOf(now, undefined);
    if (!asOf.ok) return err(asOf.error);
    const range = resolveDayRange(now, input, HANDOVER_DEFAULT_DAYS);
    if (!range.ok) return err(range.error);
    const { from, to } = range.value;
    const { operatorId } = ctx;
    const op = sql`${operatorId}::uuid`;

    // The filter's people: every lineman, plus anyone with a day in the range.
    const people = await tx
      .select({ id: users.id, name: users.name, role: users.role, status: users.status })
      .from(users)
      .where(
        and(
          eq(users.operatorId, operatorId),
          or(
            eq(users.role, "lineman"),
            sql`EXISTS (SELECT 1 FROM collection_sessions s
                         WHERE s.operator_id = ${users.operatorId} AND s.collector_id = ${users.id}
                           AND s.business_date BETWEEN ${from}::date AND ${to}::date)`,
          ),
        ),
      )
      .orderBy(asc(users.name), asc(users.id));
    if (input.linemanId !== undefined && !people.some((u) => u.id === input.linemanId)) {
      // Another tenant's id or a made-up one (RLS) → NOT_FOUND; a user of this business who is no
      // lineman and has no day in the range simply has no rows.
      const [known] = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.operatorId, operatorId), eq(users.id, input.linemanId)));
      if (!known) return err(notFound());
    }

    const conditions: SQL[] = [
      sql`s.operator_id = ${op}`,
      sql`s.business_date BETWEEN ${from}::date AND ${to}::date`,
    ];
    if (input.linemanId !== undefined) {
      conditions.push(sql`s.collector_id = ${input.linemanId}::uuid`);
    }
    if (input.status !== undefined) conditions.push(sql`s.status = ${input.status}`);
    if (input.difference === "short") conditions.push(sql`s.discrepancy_paise < 0`);
    if (input.difference === "extra") conditions.push(sql`s.discrepancy_paise > 0`);
    const where = sql.join(conditions, sql` AND `);

    const [totals] = (
      await tx.execute<TotalsDbRow>(sql`
        SELECT count(*)::int AS days,
               coalesce(sum(s.cash_expected_paise), 0)::text AS expected,
               coalesce(sum(s.upi_total_paise), 0)::text AS upi,
               coalesce(sum(s.cash_handed_over_paise), 0)::text AS handed,
               coalesce(sum(s.cash_expected_paise) FILTER (WHERE s.status = 'open'), 0)::text AS not_handed,
               coalesce(-sum(s.discrepancy_paise) FILTER (WHERE s.discrepancy_paise < 0), 0)::text AS short,
               coalesce(sum(s.discrepancy_paise) FILTER (WHERE s.discrepancy_paise > 0), 0)::text AS extra,
               (count(*) FILTER (WHERE s.discrepancy_paise <> 0))::int AS difference_count,
               (count(*) FILTER (WHERE s.status = 'open'))::int AS open,
               (count(*) FILTER (WHERE s.status = 'submitted'))::int AS submitted,
               (count(*) FILTER (WHERE s.status = 'accepted'))::int AS accepted,
               (count(*) FILTER (WHERE s.status = 'returned'))::int AS returned
          FROM collection_sessions s
         WHERE ${where}`)
    ).rows;

    const pageSize = input.pageSize;
    const listed = await tx.execute<SessionDbRow>(sql`
      SELECT s.id, s.collector_id, u.name, u.status AS user_status,
             s.business_date::text AS business_date, s.status,
             s.cash_expected_paise::text AS cash_expected_paise,
             s.upi_total_paise::text AS upi_total_paise, s.payment_count,
             s.handover_cash_expected_paise::text AS handover_cash_expected_paise,
             s.cash_handed_over_paise::text AS cash_handed_over_paise,
             s.discrepancy_paise::text AS discrepancy_paise, s.discrepancy_reason,
             s.handover_note, s.submitted_at, s.reviewed_at, rv.name AS reviewer_name,
             s.review_note
        FROM collection_sessions s
        JOIN users u ON u.operator_id = s.operator_id AND u.id = s.collector_id
        LEFT JOIN users rv ON rv.operator_id = s.operator_id AND rv.id = s.reviewed_by
       WHERE ${where}
       ORDER BY s.business_date DESC,
                CASE s.status WHEN 'submitted' THEN 0 WHEN 'returned' THEN 1
                              WHEN 'open' THEN 2 ELSE 3 END,
                u.name, s.id
       LIMIT ${pageSize} OFFSET ${(input.page - 1) * pageSize}`);

    const histories = await loadHistories(
      tx,
      operatorId,
      listed.rows.map((row) => row.id),
    );

    const rows = listed.rows.map((row): HandoverReportRow => {
      const expected = toPaise(row.cash_expected_paise);
      const handover =
        row.status === "open" ||
        row.handover_cash_expected_paise === null ||
        row.cash_handed_over_paise === null ||
        row.discrepancy_paise === null ||
        row.submitted_at === null
          ? null
          : {
              cashExpectedPaise: toPaise(row.handover_cash_expected_paise),
              cashHandedOverPaise: toPaise(row.cash_handed_over_paise),
              discrepancyPaise: Number(row.discrepancy_paise),
              discrepancyReason: row.discrepancy_reason,
              note: row.handover_note,
              submittedAt: toDate(row.submitted_at),
              reviewedAt: row.reviewed_at === null ? null : toDate(row.reviewed_at),
              reviewedByName: row.reviewer_name,
              reviewNote: row.review_note,
            };
      return {
        sessionId: row.id,
        linemanId: row.collector_id,
        linemanName: row.name,
        linemanActive: row.user_status === "active",
        businessDate: businessDate(row.business_date),
        status: row.status,
        cashExpectedPaise: expected,
        upiTotalPaise: toPaise(row.upi_total_paise),
        paymentCount: Number(row.payment_count),
        handover,
        changedSinceHandover: handover !== null && handover.cashExpectedPaise !== expected,
        history: histories.get(row.id) ?? [],
      };
    });

    const report: HandoverReport = {
      asOf: { at: asOf.value.at, date: asOf.value.date, endOfDay: false },
      from,
      to,
      linemen: people.map(
        (u): ReportPerson => ({
          id: u.id,
          name: u.name,
          role: u.role,
          active: u.status === "active",
        }),
      ),
      totals: {
        days: Number(totals?.days ?? 0),
        cashExpectedPaise: toPaise(totals?.expected ?? "0"),
        upiTotalPaise: toPaise(totals?.upi ?? "0"),
        cashHandedOverPaise: toPaise(totals?.handed ?? "0"),
        notHandedOverPaise: toPaise(totals?.not_handed ?? "0"),
        shortPaise: toPaise(totals?.short ?? "0"),
        extraPaise: toPaise(totals?.extra ?? "0"),
        differenceCount: Number(totals?.difference_count ?? 0),
        byStatus: {
          open: Number(totals?.open ?? 0),
          submitted: Number(totals?.submitted ?? 0),
          accepted: Number(totals?.accepted ?? 0),
          returned: Number(totals?.returned ?? 0),
        },
      },
      rows,
      page: input.page,
      pageSize,
    };
    return ok(report);
  },
});
