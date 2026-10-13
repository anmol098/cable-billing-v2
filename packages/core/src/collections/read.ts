/**
 * Reads behind the collection services (T-062). Every function runs inside the caller's tenant
 * transaction (RLS limits it to the tenant; the explicit `operator_id` filters keep the indexes in
 * use). Not exported from the package.
 */
import {
  collectionSessions,
  customers,
  devices,
  handoverEvents,
  paymentReversals,
  payments,
  receipts,
  type Tx,
  users,
} from "@cb/db";
import { type BusinessDate, businessDate } from "@cb/domain";
import { aliasedTable, and, asc, desc, eq, inArray, isNull, max, or } from "drizzle-orm";
import { lastContactOf, phoneMayHoldPayments } from "./rules";
import type {
  CollectionDayView,
  DayPaymentView,
  HandoverEventView,
  HandoverView,
  PhoneWarningView,
} from "./types";

export type SessionRow = typeof collectionSessions.$inferSelect;

/** The day's session of a collector, optionally locked (`FOR UPDATE`). */
export async function findSession(
  tx: Tx,
  operatorId: string,
  collectorId: string,
  date: BusinessDate,
  options: { lock?: boolean } = {},
): Promise<SessionRow | undefined> {
  const query = tx
    .select()
    .from(collectionSessions)
    .where(
      and(
        eq(collectionSessions.operatorId, operatorId),
        eq(collectionSessions.collectorId, collectorId),
        eq(collectionSessions.businessDate, date),
      ),
    );
  const [row] = options.lock ? await query.for("update") : await query;
  return row;
}

/** A session by id (RLS: another tenant's id finds nothing), optionally locked. */
export async function findSessionById(
  tx: Tx,
  operatorId: string,
  sessionId: string,
  options: { lock?: boolean } = {},
): Promise<SessionRow | undefined> {
  const query = tx
    .select()
    .from(collectionSessions)
    .where(
      and(eq(collectionSessions.operatorId, operatorId), eq(collectionSessions.id, sessionId)),
    );
  const [row] = options.lock ? await query.for("update") : await query;
  return row;
}

/** The latest handover stored on a session, or null while it is open. */
export function handoverOf(row: SessionRow): HandoverView | null {
  if (
    row.status === "open" ||
    row.handoverSubmissionId === null ||
    row.handoverCashExpectedPaise === null ||
    row.cashHandedOverPaise === null ||
    row.discrepancyPaise === null ||
    row.unsyncedPaymentCount === null ||
    row.unsyncedCashPaise === null ||
    row.submittedAt === null
  ) {
    return null;
  }
  return {
    submissionId: row.handoverSubmissionId,
    cashExpectedPaise: row.handoverCashExpectedPaise,
    cashHandedOverPaise: row.cashHandedOverPaise,
    discrepancyPaise: row.discrepancyPaise,
    discrepancyReason: row.discrepancyReason,
    note: row.handoverNote,
    unsyncedPaymentCount: row.unsyncedPaymentCount,
    unsyncedCashPaise: row.unsyncedCashPaise,
    submittedAt: row.submittedAt,
    reviewedAt: row.reviewedAt,
    reviewedBy: row.reviewedBy,
    reviewNote: row.reviewNote,
  };
}

/** The running cash total moved after the latest handover was submitted. */
export function changedSinceHandover(row: SessionRow | undefined): boolean {
  if (!row) return false;
  const handover = handoverOf(row);
  return handover !== null && handover.cashExpectedPaise !== row.cashExpectedPaise;
}

/**
 * The day's payments of a collector that count for the session (`source = 'android'`, PLAN §8.7 /
 * T-046 decision 3), newest first, reversed ones flagged.
 */
export async function loadDayPayments(
  tx: Tx,
  operatorId: string,
  collectorId: string,
  date: BusinessDate,
): Promise<DayPaymentView[]> {
  const rows = await tx
    .select({
      paymentId: payments.id,
      customerId: payments.customerId,
      customerCode: customers.customerCode,
      customerName: customers.name,
      amountPaise: payments.amountPaise,
      method: payments.method,
      recordedAt: payments.recordedAt,
      postedAt: payments.postedAt,
      receiptNumber: receipts.receiptNumber,
      provisionalRef: receipts.provisionalRef,
      reversalId: paymentReversals.id,
      reviewStatus: payments.reviewStatus,
    })
    .from(payments)
    .innerJoin(
      customers,
      and(eq(customers.operatorId, payments.operatorId), eq(customers.id, payments.customerId)),
    )
    .innerJoin(
      receipts,
      and(eq(receipts.operatorId, payments.operatorId), eq(receipts.paymentId, payments.id)),
    )
    .leftJoin(
      paymentReversals,
      and(
        eq(paymentReversals.operatorId, payments.operatorId),
        eq(paymentReversals.paymentId, payments.id),
      ),
    )
    .where(
      and(
        eq(payments.operatorId, operatorId),
        eq(payments.collectorId, collectorId),
        eq(payments.businessDate, date),
        eq(payments.source, "android"),
      ),
    )
    .orderBy(desc(payments.recordedAt), desc(payments.id));
  return rows.map((r) => ({
    paymentId: r.paymentId,
    customerId: r.customerId,
    customerCode: r.customerCode,
    customerName: r.customerName,
    amountPaise: r.amountPaise,
    method: r.method,
    recordedAt: r.recordedAt,
    postedAt: r.postedAt,
    receiptNumber: r.receiptNumber,
    provisionalRef: r.provisionalRef,
    reversed: r.reversalId !== null,
    needsReview: r.reviewStatus === "needs_review",
  }));
}

/** A day as the contract's `CollectionDay` sees it (zeros and `open` without a session). */
export function dayView(
  collectorId: string,
  date: BusinessDate,
  row: SessionRow | undefined,
  dayPayments: readonly DayPaymentView[],
): CollectionDayView {
  return {
    sessionId: row?.id ?? null,
    collectorId,
    businessDate: date,
    cashExpectedPaise: row?.cashExpectedPaise ?? 0,
    upiTotalPaise: row?.upiTotalPaise ?? 0,
    paymentCount: row?.paymentCount ?? 0,
    status: row?.status ?? "open",
    handover: row ? handoverOf(row) : null,
    payments: dayPayments,
  };
}

/** Newest `last_seen_at` per user among their phones that are not signed out. */
export async function lastSeenByUser(
  tx: Tx,
  operatorId: string,
  userIds: readonly string[],
): Promise<Map<string, Date | null>> {
  const result = new Map<string, Date | null>();
  if (userIds.length === 0) return result;
  const rows = await tx
    .select({ userId: devices.userId, lastSeenAt: max(devices.lastSeenAt) })
    .from(devices)
    .where(
      and(
        eq(devices.operatorId, operatorId),
        inArray(devices.userId, [...userIds]),
        isNull(devices.revokedAt),
      ),
    )
    .groupBy(devices.userId);
  for (const row of rows) {
    // max() comes back as a string from some drivers; normalise to a Date.
    const value = row.lastSeenAt as unknown as Date | string | null;
    result.set(row.userId, value === null ? null : new Date(value));
  }
  return result;
}

/** The phone warning for one lineman's day (see `rules.ts`). */
export function phoneWarning(
  lastSeenAt: Date | null,
  row: SessionRow | undefined,
  date: BusinessDate,
  now: Date,
): PhoneWarningView {
  const handover = row ? handoverOf(row) : null;
  const submittedAt = handover?.submittedAt ?? null;
  return {
    lastSeenAt,
    lastContactAt: lastContactOf({ lastSeenAt, submittedAt }),
    phoneNotSeen: phoneMayHoldPayments({ lastSeenAt, submittedAt, businessDate: date, now }),
    reportedUnsyncedCount: handover?.unsyncedPaymentCount ?? 0,
    reportedUnsyncedCashPaise: handover?.unsyncedCashPaise ?? 0,
  };
}

/** A session's history, oldest first, with the actors' names. */
export async function loadHistory(
  tx: Tx,
  operatorId: string,
  sessionId: string,
): Promise<HandoverEventView[]> {
  const actor = aliasedTable(users, "actor");
  const rows = await tx
    .select({ event: handoverEvents, actorName: actor.name })
    .from(handoverEvents)
    .innerJoin(
      actor,
      and(eq(actor.operatorId, handoverEvents.operatorId), eq(actor.id, handoverEvents.actorId)),
    )
    .where(and(eq(handoverEvents.operatorId, operatorId), eq(handoverEvents.sessionId, sessionId)))
    .orderBy(asc(handoverEvents.at), asc(handoverEvents.id));
  return rows.map(({ event, actorName }) => ({
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
  }));
}

/**
 * A tenant user shown on the Linemen page: a lineman (any status), or anyone with a session row
 * that day (`hasSession`). Undefined otherwise, and for another tenant's id (RLS).
 */
export async function findCollector(
  tx: Tx,
  operatorId: string,
  userId: string,
  hasSession: boolean,
): Promise<{ id: string; name: string; active: boolean } | undefined> {
  const [row] = await tx
    .select({ id: users.id, name: users.name, status: users.status, role: users.role })
    .from(users)
    .where(and(eq(users.operatorId, operatorId), eq(users.id, userId)));
  if (!row || (row.role !== "lineman" && !hasSession)) return undefined;
  return { id: row.id, name: row.name, active: row.status === "active" };
}

/**
 * The linemen to show for a day: every active lineman, plus anyone whose day has a session (a
 * deactivated lineman's cash still has to reach the office). With each one's session row, if any.
 */
export async function loadLinemenForDay(
  tx: Tx,
  operatorId: string,
  date: BusinessDate,
): Promise<{ id: string; name: string; active: boolean; session: SessionRow | undefined }[]> {
  const sessions = await tx
    .select()
    .from(collectionSessions)
    .where(
      and(eq(collectionSessions.operatorId, operatorId), eq(collectionSessions.businessDate, date)),
    );
  const byCollector = new Map(sessions.map((s) => [s.collectorId, s]));
  const people = await tx
    .select({ id: users.id, name: users.name, status: users.status })
    .from(users)
    .where(
      and(
        eq(users.operatorId, operatorId),
        sessions.length === 0
          ? and(eq(users.role, "lineman"), eq(users.status, "active"))
          : or(
              and(eq(users.role, "lineman"), eq(users.status, "active")),
              inArray(users.id, [...byCollector.keys()]),
            ),
      ),
    );
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    active: p.status === "active",
    session: byCollector.get(p.id),
  }));
}

/** Parses a DB `date` string into a `BusinessDate` (trusted value). */
export function dateOf(row: SessionRow): BusinessDate {
  return businessDate(row.businessDate);
}
