/**
 * `payments.resolve_review`: the office marks a flagged payment as checked (T-048; PLAN §10.4
 * `posted_needs_review`, §12.1 "payments needing review"). The money was posted when it arrived
 * (a flag never rejects a payment); this only records that someone in the office looked at it.
 *
 * The one change the append-only `payments` trigger allows (T-023): `review_status`
 * `needs_review → resolved` with `reviewed_by`, `reviewed_at` and an optional `review_note`. A
 * payment that was never flagged, or is already checked, is never changed (CONFLICT with
 * `details.reason` = `not_flagged` | `already_resolved`). Amount, allocations, ledger and receipt
 * are untouched; correcting the money itself is the Owner's "Undo payment" (`payments.reverse`).
 *
 * Capability `handover.review` (Owner, Staff, audited; not allowed in read-only mode): checking a
 * flagged payment is the office checking a lineman's collection, the same §9.3 row as accepting
 * a cash handover. No new capability (see the T-048 completion notes).
 */
import { payments } from "@cb/db";
import { err, ok } from "@cb/domain";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { idInput } from "../collections/inputs";
import { defineService } from "../context/service";
import { notFound, serviceError } from "../errors/errors";
import type { ResolvePaymentReviewResult } from "./types";

/** Longest office note on a checked payment. */
export const MAX_REVIEW_NOTE_LENGTH = 500;

export const ResolvePaymentReviewInput = z.object({
  paymentId: idInput,
  /** What the office found (optional). */
  note: z
    .string()
    .trim()
    .max(MAX_REVIEW_NOTE_LENGTH)
    .nullish()
    .transform((value) => (value ? value : null)),
});

export const resolvePaymentReview = defineService({
  name: "payments.resolve_review",
  capability: "handover.review",
  input: ResolvePaymentReviewInput,
  async run({ ctx, input, tx, audit, now }) {
    const [payment] = await tx
      .select({ id: payments.id, reviewStatus: payments.reviewStatus })
      .from(payments)
      .where(and(eq(payments.operatorId, ctx.operatorId), eq(payments.id, input.paymentId)))
      .for("update");
    if (!payment) return err(notFound());
    if (payment.reviewStatus !== "needs_review") {
      const reason = payment.reviewStatus === "resolved" ? "already_resolved" : "not_flagged";
      return err(serviceError("CONFLICT", "The payment is not waiting to be checked", { reason }));
    }
    const reviewedAt = now;
    await tx
      .update(payments)
      .set({
        reviewStatus: "resolved",
        reviewedBy: ctx.userId,
        reviewedAt,
        reviewNote: input.note,
      })
      .where(and(eq(payments.operatorId, ctx.operatorId), eq(payments.id, payment.id)));
    await audit.record({
      entityType: "payment",
      entityId: payment.id,
      before: { review_status: "needs_review" },
      after: { review_status: "resolved", has_note: input.note !== null },
    });
    const value: ResolvePaymentReviewResult = {
      paymentId: payment.id,
      reviewStatus: "resolved",
      reviewedAt,
    };
    return ok(value);
  },
});
