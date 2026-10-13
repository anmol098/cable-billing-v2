/**
 * Receipts on the phone (PLAN §11.7, FR-017 to FR-021): the online preview link and the log of
 * what the lineman did with a receipt. Served by T-061 (T-050 makes the links); consumed by T-069.
 *
 * Honest states only (BR-12, RULE-19, CLAUDE.md): the app can know that it printed, that a print
 * failed, that it opened WhatsApp or the SMS composer, or that it handed a PDF to the share sheet.
 * It can never know that a message was sent or delivered, so the contract has no such values.
 */

import * as z from "zod";
import { responseBody } from "./envelope";
import { ItemError } from "./errors";
import { ReceiptNumber, Timestamp, Uuid } from "./primitives";

// ── POST /receipts/{paymentId}/link ──────────────────────────────────────────────────────────────

export const ReceiptLinkParams = z.object({
  paymentId: Uuid.describe(
    "The payment id. The payment must already be on the server (PAYMENT_NOT_FOUND otherwise: 'Link will be ready after sync').",
  ),
});

export const ReceiptLink = z
  .object({
    url: z
      .url({ protocol: /^https$/ })
      .max(2048)
      .describe(
        "The public preview page (https, unguessable token). Put it in the WhatsApp/SMS text as is.",
      ),
    expires_at: Timestamp.describe("When the link stops working (90 days, D-14), UTC."),
    receipt_number: ReceiptNumber.describe("The receipt the link shows."),
  })
  .meta({
    id: "ReceiptLink",
    description: "A receipt preview link (FR-021). The page shows minimal personal data.",
  });

export const ReceiptLinkResponse = responseBody(
  "ReceiptLinkResponse",
  "A usable preview link for the payment's receipt: an existing unexpired one or a new one. Online only.",
  { link: ReceiptLink.describe("The preview link.") },
);

export type ReceiptLinkResponse = z.infer<typeof ReceiptLinkResponse>;

// ── POST /receipts/actions:batch ─────────────────────────────────────────────────────────────────

/** At most this many receipt actions per batch. */
export const RECEIPT_ACTION_BATCH_MAX = 100;

export const ReceiptActionType = z
  .enum(["printed", "print_failed", "whatsapp_opened", "sms_opened", "pdf_shared"])
  .meta({
    id: "ReceiptActionType",
    description: [
      "What the lineman did with a receipt. Observable states only: never 'sent' or 'delivered' (BR-12, RULE-19).",
      "- printed: the printer accepted the receipt.",
      "- print_failed: printing failed (printer off, no paper, not paired).",
      "- whatsapp_opened: WhatsApp was opened with the message ready.",
      "- sms_opened: the SMS app was opened with the message ready.",
      "- pdf_shared: the receipt PDF was handed to the share sheet or WhatsApp.",
    ].join("\n"),
  });

export const ReceiptActionItem = z
  .object({
    id: Uuid.describe("Idempotency key for this action, made on the phone when it happened."),
    payment_id: Uuid.describe("The payment whose receipt it was."),
    action: ReceiptActionType.describe("What happened."),
    at: Timestamp.describe("When it happened, by the phone's clock (UTC)."),
  })
  .meta({ id: "ReceiptActionItem", description: "One receipt action from the phone's outbox." });

export type ReceiptActionItem = z.infer<typeof ReceiptActionItem>;

export const ReceiptActionsRequest = z
  .object({
    actions: z
      .array(ReceiptActionItem)
      .min(1)
      .max(RECEIPT_ACTION_BATCH_MAX)
      .describe(
        `1–${RECEIPT_ACTION_BATCH_MAX} actions, oldest first. Send them after their payments have synced.`,
      ),
  })
  .meta({ id: "ReceiptActionsRequest", description: "Push the receipt-action outbox." });

export type ReceiptActionsRequest = z.infer<typeof ReceiptActionsRequest>;

/** For servers: the envelope with unchecked items, so one bad item is rejected on its own. */
export const ReceiptActionsEnvelope = z.object({
  actions: z.array(z.unknown()).min(1).max(RECEIPT_ACTION_BATCH_MAX),
});

export const ReceiptActionOutcome = z
  .enum(["recorded", "duplicate", "rejected", "retry_later"])
  .meta({
    id: "ReceiptActionOutcome",
    description: [
      "What happened to one action:",
      "- recorded: saved now.",
      "- duplicate: already saved with the same data.",
      "- rejected: invalid and never will be saved (see error); drop it from the outbox.",
      "- retry_later: not saved yet (e.g. PAYMENT_NOT_FOUND because the payment has not synced); keep it and send again later.",
    ].join("\n"),
  });

export const ReceiptActionResult = z
  .object({
    id: Uuid.describe("The action id this result is for."),
    outcome: ReceiptActionOutcome.describe("What happened to this action."),
    error: ItemError.nullable().describe(
      "Why it was not saved; set only for rejected and retry_later, else null.",
    ),
  })
  .superRefine((result, ctx) => {
    const failed = result.outcome === "rejected" || result.outcome === "retry_later";
    if (failed !== (result.error !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["error"],
        message: "error is set exactly for rejected and retry_later",
      });
    }
  })
  .meta({ id: "ReceiptActionResult", description: "The result for one receipt action." });

export const ReceiptActionsResponse = responseBody(
  "ReceiptActionsResponse",
  "One result per request item, in the same order.",
  {
    results: z
      .array(ReceiptActionResult)
      .min(1)
      .max(RECEIPT_ACTION_BATCH_MAX)
      .describe("Results in request order, one per item, matched by id."),
  },
);

export type ReceiptActionsResponse = z.infer<typeof ReceiptActionsResponse>;
