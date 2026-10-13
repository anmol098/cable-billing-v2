/**
 * `POST /payments:batch` (PLAN §10.4, FR-015, PRD §13.3): the phone pushes up to 50 queued
 * payments; the server posts each one idempotently on its `id` and answers per item.
 * Served by T-061 (through T-046 `postPayment`), consumed by T-066.
 *
 * Outcome → app state (PLAN §10.4):
 * - `posted`, `duplicate` → SENT_TO_OFFICE (green check).
 * - `posted_needs_review` → SENT_TO_OFFICE + review flag (the money is safe; the office checks).
 * - `rejected` → NEEDS_OFFICE_HELP (red, "Call office"). Never retried automatically.
 * - `retry_later` → stays SAVED_ON_PHONE and is sent again with backoff (same as a network error).
 *
 * A whole-request error (HTTP 4xx/5xx, timeout) means nothing in the response can be trusted: keep
 * every item SAVED_ON_PHONE and retry. Replays are safe because the server is idempotent on `id`.
 */

import * as z from "zod";
import { BillKind } from "./customers";
import { responseBody } from "./envelope";
import { ItemError } from "./errors";
import {
  BusinessDateSchema,
  InvoiceNumber,
  NonNegativePaise,
  PaymentMethod,
  PeriodSchema,
  PositivePaise,
  ProvisionalRef,
  ReceiptNumber,
  SignedPaise,
  Timestamp,
  Uuid,
} from "./primitives";

/** At most this many payments per batch (PLAN §10.2). */
export const PAYMENT_BATCH_MAX = 50;

export const PaymentBatchItem = z
  .object({
    id: Uuid.describe(
      "Payment id = idempotency key. A UUIDv7 the phone creates before saving the payment locally (FR-015); it never changes, so a retry can never post twice.",
    ),
    customer_id: Uuid.describe("The customer who paid."),
    amount_paise: PositivePaise.describe(
      "Amount received, in paise (> 0). The app takes whole rupees (D-17), so this is a multiple of 100 today.",
    ),
    method: PaymentMethod.describe("Cash or UPI."),
    upi_reference: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .nullish()
      .describe(
        "UPI reference the lineman typed (optional, only with method 'upi'). Not proof of payment (BR-10). Omit or null when skipped.",
      ),
    notes: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullish()
      .describe("Optional note. Omit or null for none."),
    recorded_at: Timestamp.describe(
      "When the lineman saved the payment, by the phone's clock (UTC). More than 10 minutes in the future or more than 7 days old → posted_needs_review.",
    ),
    provisional_ref: ProvisionalRef.describe(
      "The provisional receipt reference shown to the customer before sync (P-{device_code}-{seq}). Kept forever as an alias of the permanent receipt number (FR-016).",
    ),
    collector_id: Uuid.describe(
      "Id of the user who took the payment (UserInfo.id when it was saved). The server takes identity from the token and flags a mismatch for review; it never trusts this for access.",
    ),
    device_id: Uuid.describe(
      "RegisteredDevice.id of this phone when the payment was saved. A mismatch with the token's device is flagged for review.",
    ),
  })
  .superRefine((item, ctx) => {
    if (item.method === "cash" && item.upi_reference != null) {
      ctx.addIssue({
        code: "custom",
        path: ["upi_reference"],
        message: "upi_reference is only allowed with method 'upi'",
      });
    }
  })
  .meta({
    id: "PaymentBatchItem",
    description:
      "One payment saved on the phone (PRD §13.3). upi_reference must be absent for cash.",
  });

export type PaymentBatchItem = z.infer<typeof PaymentBatchItem>;

export const PaymentBatchRequest = z
  .object({
    payments: z
      .array(PaymentBatchItem)
      .min(1)
      .max(PAYMENT_BATCH_MAX)
      .describe(
        `1–${PAYMENT_BATCH_MAX} queued payments, oldest first. The server posts them in this order.`,
      ),
  })
  .meta({
    id: "PaymentBatchRequest",
    description: "Push queued payments. Safe to send again after a timeout or crash.",
  });

export type PaymentBatchRequest = z.infer<typeof PaymentBatchRequest>;

/**
 * The batch request with items left unchecked, for servers: validate the envelope with this, then
 * each item with {@link PaymentBatchItem}, so one bad item is `rejected` (VALIDATION) on its own
 * instead of failing the whole batch.
 */
export const PaymentBatchEnvelope = z.object({
  payments: z.array(z.unknown()).min(1).max(PAYMENT_BATCH_MAX),
});

export const PaymentOutcome = z
  .enum(["posted", "duplicate", "posted_needs_review", "rejected", "retry_later"])
  .meta({
    id: "PaymentOutcome",
    description: [
      "What happened to one payment:",
      "- posted: saved now; `payment` has the permanent receipt.",
      "- duplicate: this id was already saved with the same data; `payment` is the original result.",
      "- posted_needs_review: saved, but the office must check it (see review_reason). The money is safe.",
      "- rejected: not saved and will never be (see error); show 'Call office'. Includes ID_REUSED_WITH_DIFFERENT_DATA.",
      "- retry_later: a temporary server problem for this item; nothing saved. Keep it and send it again later.",
    ].join("\n"),
  });

export type PaymentOutcome = z.infer<typeof PaymentOutcome>;

export const ReviewReason = z
  .enum([
    "customer_inactive",
    "collector_inactive",
    "collector_mismatch",
    "device_mismatch",
    "recorded_at_out_of_range",
    "other",
  ])
  .meta({
    id: "ReviewReason",
    description: [
      "Why a posted payment needs an office check (the payment is kept, PRD §13.3):",
      "- customer_inactive: the customer was deactivated before the payment synced.",
      "- collector_inactive: the lineman was deactivated before it synced.",
      "- collector_mismatch: saved by a different user than the one now signed in (PLAN §9.2).",
      "- device_mismatch: saved on a different device registration than the token's.",
      "- recorded_at_out_of_range: recorded_at is > 10 min in the future or > 7 days old (PLAN §10.4).",
      "- other: any other reason the server flags.",
    ].join("\n"),
  });

export const Allocation = z
  .object({
    invoice_id: Uuid.describe("The bill this money went to."),
    invoice_number: InvoiceNumber.describe("Bill number."),
    kind: BillKind.describe("Monthly bill or old dues."),
    period: PeriodSchema.describe("Month of that bill (YYYY-MM-01)."),
    amount_paise: PositivePaise.describe("How much of this payment went to that bill, in paise."),
    outstanding_after_paise: NonNegativePaise.describe(
      "What was left to pay on that bill right after this payment (0 = fully paid). For the receipt line 'Oct bill paid, Nov bill ₹50 left'.",
    ),
  })
  .meta({
    id: "Allocation",
    description: "Part of a payment applied to one bill (oldest bill first, PRD §13.2).",
  });

export const PostedPayment = z
  .object({
    id: Uuid.describe("Payment id (the idempotency key)."),
    customer_id: Uuid.describe("The customer who paid."),
    amount_paise: PositivePaise.describe("Amount, in paise."),
    method: PaymentMethod.describe("Cash or UPI."),
    receipt_number: ReceiptNumber.describe(
      "The permanent receipt number. Replace the provisional reference with it everywhere (keep the link).",
    ),
    provisional_ref: ProvisionalRef.describe("The provisional reference it replaces (FR-016)."),
    recorded_at: Timestamp.describe("When it was taken, by the phone's clock (UTC), as sent."),
    posted_at: Timestamp.describe(
      "When the server accepted it (UTC). Show both times where they differ (PRD §13.3).",
    ),
    business_date: BusinessDateSchema.describe(
      "The India-time day it counts for (from recorded_at): the collection session it belongs to.",
    ),
    allocations: z
      .array(Allocation)
      .describe("Bills this payment paid, oldest first. Empty if it all went to advance."),
    credit_added_paise: NonNegativePaise.describe(
      "Part of this payment kept as advance (credit) because no bill was left to pay, in paise.",
    ),
    balance_after_paise: SignedPaise.describe(
      "The customer's balance right after this payment was posted, in paise (same meaning as RosterCustomer.balance_paise). A replay returns the same value.",
    ),
    credit_after_paise: NonNegativePaise.describe(
      "The customer's advance right after this payment was posted, in paise. A replay returns the same value.",
    ),
  })
  .meta({
    id: "PostedPayment",
    description: "A payment the server has saved: what the final receipt prints (PLAN §11.8).",
  });

export type PostedPayment = z.infer<typeof PostedPayment>;

export const PaymentBatchResult = z
  .object({
    id: Uuid.describe("The payment id this result is for."),
    outcome: PaymentOutcome.describe("What happened to this payment."),
    payment: PostedPayment.nullable().describe(
      "The saved payment for posted, duplicate and posted_needs_review; null for rejected and retry_later.",
    ),
    review_reason: ReviewReason.nullable().describe(
      "Why the office must check it; set only for posted_needs_review, else null.",
    ),
    error: ItemError.nullable().describe(
      "Why it failed; set only for rejected and retry_later, else null.",
    ),
  })
  .superRefine((result, ctx) => {
    const saved = ["posted", "duplicate", "posted_needs_review"].includes(result.outcome);
    if (saved !== (result.payment !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["payment"],
        message: "payment is set exactly for saved outcomes",
      });
    }
    if ((result.outcome === "posted_needs_review") !== (result.review_reason !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["review_reason"],
        message: "review_reason is set exactly for posted_needs_review",
      });
    }
    if (saved === (result.error !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is set exactly for rejected and retry_later",
      });
    }
    if (result.payment !== null && result.payment.id !== result.id) {
      ctx.addIssue({
        code: "custom",
        path: ["payment", "id"],
        message: "payment.id must equal id",
      });
    }
  })
  .meta({
    id: "PaymentBatchResult",
    description:
      "The result for one payment. Exactly one of `payment` (saved) or `error` (not saved) is set.",
  });

export type PaymentBatchResult = z.infer<typeof PaymentBatchResult>;

export const PaymentBatchResponse = responseBody(
  "PaymentBatchResponse",
  "One result per request item, in the same order. Replaying a batch gives the same results (duplicates instead of posted).",
  {
    results: z
      .array(PaymentBatchResult)
      .min(1)
      .max(PAYMENT_BATCH_MAX)
      .describe("Results in request order, one per item, matched by id."),
  },
);

export type PaymentBatchResponse = z.infer<typeof PaymentBatchResponse>;
