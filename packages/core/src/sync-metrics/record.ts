/**
 * `sync_metrics.record_payment_batch` (T-086a; PRD §16 "Payment sync success rate" and
 * "Duplicate prevention count"): stores what the server answered one `/payments:batch` request
 * (T-061), as counts, in one append-only `payment_sync_batches` row of the tenant.
 *
 * Called by the batch route after it answered every item (each item was posted by T-046
 * `postPayment` in its own transaction). The input is the answer per item: the outcome, the
 * error code of a refusal or a "send again", and the payment id. No amount, name, phone, note or
 * customer id is passed or stored.
 *
 * **Deduplicated by payment id** (PRD §16):
 * - `posted` / `posted_needs_review`: T-046 posts a payment id once per tenant, so these count each
 *   accepted id once; a later send of the same id is `duplicate` (the duplicate prevention count).
 * - `rejected`: the first refusal of an id is stored in `payment_sync_rejections` (insert, `ON
 *   CONFLICT DO NOTHING`) and counted in `rejected_new_ids`; a refusal of an id refused before
 *   (the phone lost the answer and sent the batch again) or of an id that is a saved payment
 *   (`ID_REUSED_WITH_DIFFERENT_DATA`) is not a new id. Rejected items without a usable id are
 *   counted apart (`rejected_without_id`): there is nothing to deduplicate them by.
 * - An accepted id that was refused earlier is counted in `accepted_after_rejection` (and by the
 *   IST day of that refusal in `accepted_after_rejection_by_day`), so the rate doesn't count that
 *   id twice, and a window only subtracts refusals it also counts.
 * - Refusal keys are inserted sorted by id, so two batches with the same ids never deadlock.
 * - The transaction has short statement and lock timeouts: it runs after the phone's answer, and
 *   a stalled database must not hold a connection long for a count.
 * - `retry_later`: nothing was decided for the id (it comes again); counted by code only.
 *
 * Every accepted or duplicate id must be a payment of this tenant (NOT_FOUND otherwise, nothing
 * written): the counts can't claim a payment that isn't there, and another tenant's payment id is
 * just unknown here (RLS).
 *
 * Capability `payments.record` (the batch's own; allowed in read-only mode, D-13). Not audited
 * (`audit.skip("no_change")`): it changes no business record, the row is itself the count.
 */
import {
  isUuid,
  PAYMENT_SYNC_BATCH_MAX,
  PAYMENT_SYNC_REJECT_CODES,
  PAYMENT_SYNC_RETRY_CODES,
  type PaymentSyncRejectCode,
  type PaymentSyncRetryCode,
  paymentSyncBatches,
  paymentSyncRejections,
  payments,
  uuidv7,
} from "@cb/db";
import { businessDateOf, err, ok } from "@cb/domain";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { defineService } from "../context/service";
import { notFound } from "../errors/errors";

/** The nil UUID T-061 answers for an item without a usable id. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * How long the metrics transaction may wait on one statement or one lock: a stalled database must
 * not hold a connection for long for a count (the answer has already gone to the phone).
 */
export const SYNC_METRICS_STATEMENT_TIMEOUT_MS = 5_000;
export const SYNC_METRICS_LOCK_TIMEOUT_MS = 3_000;

/**
 * A payment id: any well-formed UUID (the same loose check as T-061's `itemIdOf`, `isUuid`), in
 * lower case. Stricter than the route would make one odd id fail the whole batch's counts.
 */
const paymentId = z
  .string()
  .refine((value) => isUuid(value), { message: "Invalid UUID" })
  .transform((value) => value.toLowerCase());
/** A payment id, or null (or the nil UUID) when the item had none. */
const optionalPaymentId = paymentId
  .nullable()
  .transform((value) => (value === null || value === NIL_UUID ? null : value));

export const PaymentSyncItem = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.enum(["posted", "posted_needs_review", "duplicate"]),
    id: paymentId,
  }),
  z.object({
    outcome: z.literal("rejected"),
    id: optionalPaymentId,
    code: z.enum(PAYMENT_SYNC_REJECT_CODES),
  }),
  z.object({
    outcome: z.literal("retry_later"),
    id: optionalPaymentId,
    code: z.enum(PAYMENT_SYNC_RETRY_CODES),
  }),
]);
export type PaymentSyncItemInput = z.input<typeof PaymentSyncItem>;

export const RecordPaymentSyncBatchInput = z.object({
  /** One answer per item, as the batch answered them (1–50). */
  items: z.array(PaymentSyncItem).min(1).max(PAYMENT_SYNC_BATCH_MAX),
});

/** The stored counts of one batch (the `payment_sync_batches` row, without ids or times). */
export interface PaymentSyncCounts {
  readonly items: number;
  readonly posted: number;
  readonly postedNeedsReview: number;
  readonly duplicate: number;
  readonly rejected: Readonly<Record<PaymentSyncRejectCode, number>>;
  readonly rejectedWithoutId: number;
  readonly rejectedNewIds: number;
  readonly acceptedAfterRejection: number;
  /** `acceptedAfterRejection` by the IST day of the earlier refusal. */
  readonly acceptedAfterRejectionByDay: Readonly<Record<string, number>>;
  readonly retryLater: Readonly<Record<PaymentSyncRetryCode, number>>;
}

export interface RecordedPaymentSyncBatch {
  readonly batchId: string;
  readonly businessDate: string;
  readonly counts: PaymentSyncCounts;
}

const zeroes = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

export const recordPaymentSyncBatch = defineService<
  typeof RecordPaymentSyncBatchInput,
  RecordedPaymentSyncBatch,
  "NOT_FOUND"
>({
  name: "sync_metrics.record_payment_batch",
  capability: "payments.record",
  input: RecordPaymentSyncBatchInput,
  async run({ ctx, input, tx, audit, log, now }) {
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${SYNC_METRICS_STATEMENT_TIMEOUT_MS}`));
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${SYNC_METRICS_LOCK_TIMEOUT_MS}`));
    const accepted = new Set<string>(); // posted or posted_needs_review
    const known = new Set<string>(); // accepted or duplicate: must be payments of this tenant
    const rejectedCode = new Map<string, PaymentSyncRejectCode>(); // first code per id
    const rejected = zeroes(PAYMENT_SYNC_REJECT_CODES);
    const retryLater = zeroes(PAYMENT_SYNC_RETRY_CODES);
    let posted = 0;
    let postedNeedsReview = 0;
    let duplicate = 0;
    let rejectedWithoutId = 0;
    for (const item of input.items) {
      switch (item.outcome) {
        case "posted":
        case "posted_needs_review":
          if (item.outcome === "posted") posted += 1;
          else postedNeedsReview += 1;
          accepted.add(item.id);
          known.add(item.id);
          break;
        case "duplicate":
          duplicate += 1;
          known.add(item.id);
          break;
        case "rejected":
          if (item.id === null) {
            rejectedWithoutId += 1;
          } else {
            rejected[item.code] += 1;
            if (!rejectedCode.has(item.id)) rejectedCode.set(item.id, item.code);
          }
          break;
        case "retry_later":
          retryLater[item.code] += 1;
          break;
      }
    }

    const lookup = [...new Set([...known, ...rejectedCode.keys()])];
    const saved = new Set(
      lookup.length === 0
        ? []
        : (
            await tx
              .select({ id: payments.id })
              .from(payments)
              .where(and(eq(payments.operatorId, ctx.operatorId), inArray(payments.id, lookup)))
          ).map((r) => r.id),
    );
    if ([...known].some((id) => !saved.has(id))) return err(notFound());

    // Accepted ids refused before (read before this batch's refusals are stored; an id can't be
    // both, since a refusal is stored only for an id that is not a saved payment).
    const acceptedIds = [...accepted];
    const refusedBefore =
      acceptedIds.length === 0
        ? []
        : await tx
            .select({ at: paymentSyncRejections.firstRejectedAt })
            .from(paymentSyncRejections)
            .where(
              and(
                eq(paymentSyncRejections.operatorId, ctx.operatorId),
                inArray(paymentSyncRejections.id, acceptedIds),
              ),
            );

    const acceptedAfterRejectionByDay: Record<string, number> = {};
    for (const { at } of refusedBefore) {
      const day = businessDateOf(at);
      acceptedAfterRejectionByDay[day] = (acceptedAfterRejectionByDay[day] ?? 0) + 1;
    }

    // Sorted by id: two batches inserting the same keys lock them in the same order (no deadlock).
    const newRefusals = [...rejectedCode]
      .filter(([id]) => !saved.has(id))
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
    const firstRefusals =
      newRefusals.length === 0
        ? []
        : await tx
            .insert(paymentSyncRejections)
            .values(
              newRefusals.map(([id, code]) => ({
                id,
                operatorId: ctx.operatorId,
                code,
                firstRejectedAt: now,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: paymentSyncRejections.id });

    const counts: PaymentSyncCounts = {
      items: input.items.length,
      posted,
      postedNeedsReview,
      duplicate,
      rejected,
      rejectedWithoutId,
      rejectedNewIds: firstRefusals.length,
      acceptedAfterRejection: refusedBefore.length,
      acceptedAfterRejectionByDay,
      retryLater,
    };
    const batchId = uuidv7();
    const businessDate = businessDateOf(now);
    await tx.insert(paymentSyncBatches).values({
      id: batchId,
      operatorId: ctx.operatorId,
      businessDate,
      receivedAt: now,
      items: counts.items,
      posted,
      postedNeedsReview,
      duplicate,
      rejectedValidation: rejected.VALIDATION,
      rejectedCustomerNotFound: rejected.CUSTOMER_NOT_FOUND,
      rejectedIdReused: rejected.ID_REUSED_WITH_DIFFERENT_DATA,
      rejectedWithoutId,
      rejectedNewIds: counts.rejectedNewIds,
      acceptedAfterRejection: counts.acceptedAfterRejection,
      acceptedAfterRejectionByDay,
      retryLaterConflict: retryLater.CONFLICT,
      retryLaterInternal: retryLater.INTERNAL,
      retryLaterRateLimited: retryLater.RATE_LIMITED,
    });
    audit.skip("no_change");
    log.info("payment_sync.recorded", {
      batch_id: batchId,
      items: counts.items,
      accepted: posted + postedNeedsReview,
      duplicate,
      rejected_new_ids: counts.rejectedNewIds,
    });
    return ok({ batchId, businessDate, counts });
  },
});
