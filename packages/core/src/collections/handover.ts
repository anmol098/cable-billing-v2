/**
 * The cash handover (T-062, PLAN §8.7, FR-022, J-05, B-016): the lineman submits the day's cash,
 * the office accepts it or returns it with a note. Every step is one READ COMMITTED transaction
 * that locks the day's `collection_sessions` row (`FOR UPDATE`), updates it, appends a
 * `handover_events` row and writes an audit event.
 *
 * State machine (`collection_sessions.status`):
 *
 * ```text
 * open ──submit──▶ submitted ──accept──▶ accepted (final; HANDOVER_ALREADY_ACCEPTED after)
 *                    ▲  │ └──submit (replaces the latest handover)──▶ submitted
 *                    │  └──return (note)──▶ returned ──submit──▶ submitted
 * ```
 *
 * - **Submit** (`handover.submit`, capability `handover.submit`: lineman only, allowed in read-only
 *   mode, D-13). The collector is always the signed-in user (`ctx.userId`); a handover is never
 *   made for someone else. The server takes the expected cash from the locked session (running
 *   total: cash, not reversed; `rules.ts`), computes `discrepancy = handed − expected`, and
 *   requires a reason when it isn't 0 (VALIDATION `discrepancyReason: required` with
 *   `details.cashExpectedPaise`, so the phone can show the server's number). Idempotent on
 *   `submissionId` (any earlier submission, not only the latest): same data → `duplicate` with the
 *   current day; different data → ID_REUSED_WITH_DIFFERENT_DATA (`details.fields`, names only).
 * - **Accept** / **Return** (`handover.accept` / `handover.return`, capability `handover.review`:
 *   Owner, Staff; TENANT_READ_ONLY in read-only mode). The office decides on the submission it
 *   looked at (`submissionId`): if the lineman has submitted again meanwhile, or the day is not
 *   waiting, the call is a CONFLICT with `details.reason` (`resubmitted` | `already_accepted` |
 *   `already_returned` | `not_submitted`) and nothing changes. So a double "Accept" records once.
 *
 * Lock order: only the session row (posting locks balance → counter → session; T-046 decision 8),
 * so no cycles.
 */
import {
  collectionSessions,
  DISCREPANCY_REASONS,
  type DiscrepancyReason,
  handoverEvents,
  type Tx,
  uuidv7,
} from "@cb/db";
import { type BusinessDate, err, ok, type Result } from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import { type CoreErrorCode, notFound, type ServiceError, serviceError } from "../errors/errors";
import { MAX_PAYMENT_PAISE } from "../payments/post-payment";
import { ownDay } from "./day";
import { businessDateInput, futureDateError, idInput } from "./inputs";
import { findSession, findSessionById, handoverOf, type SessionRow } from "./read";
import { discrepancyOf, storedReason } from "./rules";
import type { ReviewHandoverResult, SubmitHandoverResult } from "./types";

/** Error codes the handover services add to the core ones (all are contract `ERROR_CODES`). */
export const HANDOVER_ERROR_CODES = ["HANDOVER_ALREADY_ACCEPTED"] as const;
export type HandoverErrorCode = (typeof HANDOVER_ERROR_CODES)[number];

/** The most a note may hold (contract `HandoverRequest.note`, `Handover.review_note`). */
export const MAX_HANDOVER_NOTE_LENGTH = 500;
/** Contract `HandoverRequest.unsynced_payment_count` maximum. */
export const MAX_UNSYNCED_PAYMENT_COUNT = 10_000;

const note = z.string().trim().min(1).max(MAX_HANDOVER_NOTE_LENGTH);

/**
 * The submit command. T-061 maps the contract's `HandoverRequest` onto it: `date` path param →
 * `businessDate`, `submission_id` → `submissionId`, `cash_handed_over_paise`,
 * `discrepancy_reason`, `note`, `unsynced_payment_count`, `unsynced_cash_paise` (camelCase).
 */
export const SubmitHandoverInput = z.object({
  businessDate: businessDateInput,
  submissionId: idInput,
  cashHandedOverPaise: z.int().min(0).max(MAX_PAYMENT_PAISE),
  /** Required when the cash differs from the server's expected cash; ignored when it matches. */
  discrepancyReason: z.enum(DISCREPANCY_REASONS).nullish(),
  note: note.nullish(),
  unsyncedPaymentCount: z.int().min(0).max(MAX_UNSYNCED_PAYMENT_COUNT),
  unsyncedCashPaise: z.int().min(0).max(MAX_PAYMENT_PAISE),
});
export type SubmitHandoverCommand = z.output<typeof SubmitHandoverInput>;

/** Accept: the session and the submission the office looked at; an optional note. */
export const AcceptHandoverInput = z.object({
  sessionId: idInput,
  submissionId: idInput,
  note: note.nullish(),
});

/** Return: like accept, but the note (what to fix) is required. */
export const ReturnHandoverInput = z.object({
  sessionId: idInput,
  submissionId: idInput,
  note,
});

type SubmitError = ServiceError<CoreErrorCode | HandoverErrorCode>;

/** The fields of a stored submission that a replay must repeat exactly. */
function differingFields(
  stored: typeof handoverEvents.$inferSelect,
  session: SessionRow,
  collectorId: string,
  input: SubmitHandoverCommand,
): string[] {
  const fields: string[] = [];
  if (session.collectorId !== collectorId) fields.push("collector");
  if (session.businessDate !== input.businessDate) fields.push("businessDate");
  if (stored.cashHandedOverPaise !== input.cashHandedOverPaise) fields.push("cashHandedOverPaise");
  if (stored.cashExpectedPaise !== null) {
    const discrepancy = discrepancyOf(input.cashHandedOverPaise, stored.cashExpectedPaise);
    const reason = storedReason(discrepancy, input.discrepancyReason) ?? null;
    if (stored.discrepancyReason !== reason) fields.push("discrepancyReason");
  }
  if (stored.note !== (input.note ?? null)) fields.push("note");
  if (stored.unsyncedPaymentCount !== input.unsyncedPaymentCount) {
    fields.push("unsyncedPaymentCount");
  }
  if (stored.unsyncedCashPaise !== input.unsyncedCashPaise) fields.push("unsyncedCashPaise");
  return fields;
}

/**
 * An earlier submission with this id: `duplicate` (same data), ID_REUSED (different data), or
 * `undefined` (new).
 */
async function replayOf(
  tx: Tx,
  operatorId: string,
  collectorId: string,
  input: SubmitHandoverCommand,
): Promise<Result<SubmitHandoverResult, SubmitError> | undefined> {
  const [stored] = await tx
    .select({ event: handoverEvents, session: collectionSessions })
    .from(handoverEvents)
    .innerJoin(
      collectionSessions,
      and(
        eq(collectionSessions.operatorId, handoverEvents.operatorId),
        eq(collectionSessions.id, handoverEvents.sessionId),
      ),
    )
    .where(
      and(
        eq(handoverEvents.operatorId, operatorId),
        eq(handoverEvents.submissionId, input.submissionId),
        eq(handoverEvents.type, "submitted"),
      ),
    );
  if (!stored) return undefined;
  const fields = differingFields(stored.event, stored.session, collectorId, input);
  if (fields.length > 0) {
    return err(
      serviceError("ID_REUSED_WITH_DIFFERENT_DATA", "Submission id already used for other data", {
        fields,
      }),
    );
  }
  return ok({
    outcome: "duplicate",
    day: await ownDay(tx, operatorId, collectorId, input.businessDate),
  });
}

/** The submit algorithm inside the caller's tenant transaction. */
export async function submitHandoverInTx(
  tx: Tx,
  actor: { readonly operatorId: string; readonly userId: string },
  input: SubmitHandoverCommand,
  now: Date,
): Promise<Result<SubmitHandoverResult & { session?: SessionRow }, SubmitError>> {
  const { operatorId, userId } = actor;
  const date: BusinessDate = input.businessDate;
  const future = futureDateError(date, now);
  if (future) return err(future);

  // Fast path for a retry; checked again under the lock (a concurrent identical submit).
  const early = await replayOf(tx, operatorId, userId, input);
  if (early) return early;

  // A handover is allowed on a day with no payment yet (e.g. everything still on the phone).
  await tx
    .insert(collectionSessions)
    .values({ id: uuidv7(), operatorId, collectorId: userId, businessDate: date })
    .onConflictDoNothing({
      target: [
        collectionSessions.operatorId,
        collectionSessions.collectorId,
        collectionSessions.businessDate,
      ],
    });
  const session = await findSession(tx, operatorId, userId, date, { lock: true });
  if (!session) throw new Error("collection session missing after upsert");

  const replay = await replayOf(tx, operatorId, userId, input);
  if (replay) return replay;

  if (session.status === "accepted") {
    return err(
      serviceError("HANDOVER_ALREADY_ACCEPTED", "The office already accepted this day's handover"),
    );
  }

  const expected = session.cashExpectedPaise;
  const discrepancy = discrepancyOf(input.cashHandedOverPaise, expected);
  const reason: DiscrepancyReason | null | undefined = storedReason(
    discrepancy,
    input.discrepancyReason,
  );
  if (reason === undefined) {
    return err(
      serviceError("VALIDATION", "A reason is required when the cash differs", {
        fields: [{ path: "discrepancyReason", code: "required" }],
        cashExpectedPaise: expected,
        discrepancyPaise: discrepancy,
      }),
    );
  }

  const handoverNote = input.note ?? null;
  const [updated] = await tx
    .update(collectionSessions)
    .set({
      status: "submitted",
      handoverSubmissionId: input.submissionId,
      handoverCashExpectedPaise: expected,
      cashHandedOverPaise: input.cashHandedOverPaise,
      discrepancyPaise: discrepancy,
      discrepancyReason: reason,
      handoverNote,
      unsyncedPaymentCount: input.unsyncedPaymentCount,
      unsyncedCashPaise: input.unsyncedCashPaise,
      submittedAt: now,
      reviewedBy: null,
      reviewedAt: null,
      reviewNote: null,
      updatedAt: now,
    })
    .where(
      and(eq(collectionSessions.operatorId, operatorId), eq(collectionSessions.id, session.id)),
    )
    .returning();
  if (!updated) throw new Error("collection session update returned nothing");
  await tx.insert(handoverEvents).values({
    id: uuidv7(),
    operatorId,
    sessionId: session.id,
    type: "submitted",
    submissionId: input.submissionId,
    actorId: userId,
    cashExpectedPaise: expected,
    cashHandedOverPaise: input.cashHandedOverPaise,
    discrepancyPaise: discrepancy,
    discrepancyReason: reason,
    unsyncedPaymentCount: input.unsyncedPaymentCount,
    unsyncedCashPaise: input.unsyncedCashPaise,
    note: handoverNote,
    at: now,
  });
  return ok({
    outcome: "submitted",
    day: await ownDay(tx, operatorId, userId, date),
    session: updated,
  });
}

/**
 * Submits the signed-in lineman's cash handover for a day (`POST /collections/{date}/handover`,
 * T-061). Errors: VALIDATION (input, future date, missing reason), HANDOVER_ALREADY_ACCEPTED,
 * ID_REUSED_WITH_DIFFERENT_DATA, CONFLICT `retryable` (rare lock failure), INTERNAL.
 */
export const submitHandover = defineService<
  typeof SubmitHandoverInput,
  SubmitHandoverResult,
  CoreErrorCode | HandoverErrorCode
>({
  name: "handover.submit",
  capability: "handover.submit",
  input: SubmitHandoverInput,
  async run({ ctx, input, tx, audit, now }) {
    const result = await submitHandoverInTx(tx, ctx, input, now);
    if (!result.ok) return result;
    const { outcome, day, session } = result.value;
    if (outcome === "duplicate" || !session) {
      audit.skip("idempotent_replay");
    } else {
      const handover = handoverOf(session);
      await audit.record({
        entityType: "collection_session",
        entityId: session.id,
        after: {
          status: session.status,
          collector_id: session.collectorId,
          business_date: session.businessDate,
          submission_id: input.submissionId,
          cash_expected_paise: handover?.cashExpectedPaise,
          cash_handed_over_paise: handover?.cashHandedOverPaise,
          discrepancy_paise: handover?.discrepancyPaise,
          discrepancy_reason: handover?.discrepancyReason,
          has_note: handover?.note !== null,
          unsynced_payment_count: handover?.unsyncedPaymentCount,
          unsynced_cash_paise: handover?.unsyncedCashPaise,
        },
      });
    }
    return ok({ outcome, day });
  },
});

type ReviewDecision = "accepted" | "returned";

/** The accept/return algorithm inside the caller's tenant transaction. */
export async function reviewHandoverInTx(
  tx: Tx,
  actor: { readonly operatorId: string; readonly userId: string },
  input: { sessionId: string; submissionId: string; note?: string | null | undefined },
  decision: ReviewDecision,
  now: Date,
): Promise<
  Result<{ result: ReviewHandoverResult; before: SessionRow }, ServiceError<CoreErrorCode>>
> {
  const { operatorId, userId } = actor;
  const session = await findSessionById(tx, operatorId, input.sessionId, { lock: true });
  if (!session) return err(notFound());
  if (session.status !== "submitted") {
    const reason =
      session.status === "accepted"
        ? "already_accepted"
        : session.status === "returned"
          ? "already_returned"
          : "not_submitted";
    return err(
      serviceError("CONFLICT", "The handover is not waiting for the office", {
        reason,
        status: session.status,
      }),
    );
  }
  if (session.handoverSubmissionId !== input.submissionId) {
    return err(
      serviceError("CONFLICT", "The lineman submitted a newer handover", {
        reason: "resubmitted",
        status: session.status,
      }),
    );
  }
  const reviewNote = input.note ?? null;
  await tx
    .update(collectionSessions)
    .set({ status: decision, reviewedBy: userId, reviewedAt: now, reviewNote, updatedAt: now })
    .where(
      and(eq(collectionSessions.operatorId, operatorId), eq(collectionSessions.id, session.id)),
    );
  await tx.insert(handoverEvents).values({
    id: uuidv7(),
    operatorId,
    sessionId: session.id,
    type: decision,
    submissionId: input.submissionId,
    actorId: userId,
    note: reviewNote,
    at: now,
  });
  return ok({
    before: session,
    result: {
      sessionId: session.id,
      submissionId: input.submissionId,
      status: decision,
      reviewedAt: now,
      reviewedBy: userId,
      reviewNote,
    },
  });
}

function reviewAudit(before: SessionRow, result: ReviewHandoverResult) {
  return {
    entityType: "collection_session",
    entityId: before.id,
    before: { status: before.status },
    after: {
      status: result.status,
      collector_id: before.collectorId,
      business_date: before.businessDate,
      submission_id: result.submissionId,
      cash_expected_paise: before.handoverCashExpectedPaise,
      cash_handed_over_paise: before.cashHandedOverPaise,
      discrepancy_paise: before.discrepancyPaise,
      discrepancy_reason: before.discrepancyReason,
      has_note: result.reviewNote !== null,
    },
  };
}

/** The office accepts a submitted handover (final). */
export const acceptHandover = defineService({
  name: "handover.accept",
  capability: "handover.review",
  input: AcceptHandoverInput,
  async run({ ctx, input, tx, audit, now }) {
    const reviewed = await reviewHandoverInTx(tx, ctx, input, "accepted", now);
    if (!reviewed.ok) return reviewed;
    await audit.record(reviewAudit(reviewed.value.before, reviewed.value.result));
    return ok(reviewed.value.result);
  },
});

/** The office sends a submitted handover back to the lineman with a note. */
export const returnHandover = defineService({
  name: "handover.return",
  capability: "handover.review",
  input: ReturnHandoverInput,
  async run({ ctx, input, tx, audit, now }) {
    const reviewed = await reviewHandoverInTx(tx, ctx, input, "returned", now);
    if (!reviewed.ok) return reviewed;
    await audit.record(reviewAudit(reviewed.value.before, reviewed.value.result));
    return ok(reviewed.value.result);
  },
});
