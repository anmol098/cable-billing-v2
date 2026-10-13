/**
 * Read services for collection sessions (T-062, PLAN §8.7, FR-022, §12.1 "Linemen"):
 *
 * - {@link getLinemenDay} (`collections.linemen_day`, `dashboard.view`: Owner, Staff): the Linemen
 *   page for one IST day, one card per lineman (cash, UPI, count, handover, phone warning).
 * - {@link getLinemanDay} (`collections.lineman_day`, `dashboard.view`): the review screen of one
 *   lineman's day (payments, latest handover, history, phone warning).
 * - {@link getOwnCollectionDay} (`collections.own_day`, `reports.own_day.view`): the signed-in
 *   user's own day, the contract's `GET /collections/{date}` (T-061). Always the caller's own
 *   day: the input has no user id.
 *
 * Totals are the session's running totals (expected cash = cash, not reversed, Android; see
 * `rules.ts` for the exact rule). Future dates are VALIDATION.
 */
import type { Tx } from "@cb/db";
import { type BusinessDate, businessDateOf, err, ok } from "@cb/domain";
import { z } from "zod";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";
import { businessDateInput, futureDateError, idInput } from "./inputs";
import {
  changedSinceHandover,
  dayView,
  findCollector,
  findSession,
  handoverOf,
  lastSeenByUser,
  loadDayPayments,
  loadHistory,
  loadLinemenForDay,
  phoneWarning,
} from "./read";
import type { CollectionDayView, LinemanDayCard, LinemanDayView, LinemenDayView } from "./types";

/** Order of the cards: what the office must do first. */
const STATUS_ORDER = { submitted: 0, returned: 1, open: 2, accepted: 3 } as const;

export const LinemenDayInput = z.object({ businessDate: businessDateInput });
export const LinemanDayInput = z.object({ linemanId: idInput, businessDate: businessDateInput });
export const OwnCollectionDayInput = z.object({ businessDate: businessDateInput });

const isToday = (date: BusinessDate, now: Date) => businessDateOf(now) === date;

/** The Linemen page for one day. */
export const getLinemenDay = defineService({
  name: "collections.linemen_day",
  capability: "dashboard.view",
  input: LinemenDayInput,
  async run({ ctx, input, tx, now }) {
    const date = input.businessDate;
    const future = futureDateError(date, now);
    if (future) return err(future);
    const people = await loadLinemenForDay(tx, ctx.operatorId, date);
    const seen = await lastSeenByUser(
      tx,
      ctx.operatorId,
      people.map((p) => p.id),
    );
    const cards: LinemanDayCard[] = people.map(({ id, name, active, session }) => ({
      linemanId: id,
      name,
      active,
      sessionId: session?.id ?? null,
      cashExpectedPaise: session?.cashExpectedPaise ?? 0,
      upiTotalPaise: session?.upiTotalPaise ?? 0,
      paymentCount: session?.paymentCount ?? 0,
      status: session?.status ?? "open",
      handover: session ? handoverOf(session) : null,
      changedSinceHandover: changedSinceHandover(session),
      phone: phoneWarning(seen.get(id) ?? null, session, date, now),
    }));
    cards.sort(
      (a, b) =>
        STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
        a.name.localeCompare(b.name, "en") ||
        a.linemanId.localeCompare(b.linemanId),
    );
    const view: LinemenDayView = {
      businessDate: date,
      isToday: isToday(date, now),
      linemen: cards,
      totals: {
        cashExpectedPaise: cards.reduce((sum, c) => sum + c.cashExpectedPaise, 0),
        upiTotalPaise: cards.reduce((sum, c) => sum + c.upiTotalPaise, 0),
        paymentCount: cards.reduce((sum, c) => sum + c.paymentCount, 0),
        waitingCount: cards.filter((c) => c.status === "submitted").length,
      },
    };
    return ok(view);
  },
});

/** One lineman's day for the review screen. NOT_FOUND for an unknown / other tenant's user. */
export const getLinemanDay = defineService({
  name: "collections.lineman_day",
  capability: "dashboard.view",
  input: LinemanDayInput,
  async run({ ctx, input, tx, now }) {
    const date = input.businessDate;
    const future = futureDateError(date, now);
    if (future) return err(future);
    const session = await findSession(tx, ctx.operatorId, input.linemanId, date);
    const person = await findCollector(tx, ctx.operatorId, input.linemanId, session !== undefined);
    if (!person) return err(notFound());
    // One transaction = one connection: sequential reads.
    const dayPayments = await loadDayPayments(tx, ctx.operatorId, person.id, date);
    const seen = await lastSeenByUser(tx, ctx.operatorId, [person.id]);
    const history = session ? await loadHistory(tx, ctx.operatorId, session.id) : [];
    const view: LinemanDayView = {
      linemanId: person.id,
      name: person.name,
      active: person.active,
      isToday: isToday(date, now),
      day: dayView(person.id, date, session, dayPayments),
      changedSinceHandover: changedSinceHandover(session),
      phone: phoneWarning(seen.get(person.id) ?? null, session, date, now),
      history,
    };
    return ok(view);
  },
});

/** Reads the caller's own day inside a tenant transaction (also used after a handover). */
export async function ownDay(
  tx: Tx,
  operatorId: string,
  collectorId: string,
  date: BusinessDate,
): Promise<CollectionDayView> {
  const session = await findSession(tx, operatorId, collectorId, date);
  const dayPayments = await loadDayPayments(tx, operatorId, collectorId, date);
  return dayView(collectorId, date, session, dayPayments);
}

/**
 * The signed-in user's own day (`GET /collections/{date}`, T-061). Never another user's: the
 * collector is `ctx.userId`.
 */
export const getOwnCollectionDay = defineService({
  name: "collections.own_day",
  capability: "reports.own_day.view",
  input: OwnCollectionDayInput,
  async run({ ctx, input, tx, now }) {
    const future = futureDateError(input.businessDate, now);
    if (future) return err(future);
    return ok(await ownDay(tx, ctx.operatorId, ctx.userId, input.businessDate));
  },
});
