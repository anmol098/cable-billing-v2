/**
 * The lineman's day and cash handover (PLAN §8.7, FR-022, J-05): `GET /collections/{date}` and
 * `POST /collections/{date}/handover`. Served by T-061 over T-062's services; consumed by T-070.
 *
 * Server totals count only payments the server has; the app adds its unsynced payments locally and
 * labels them as such (PLAN §8.7).
 */

import * as z from "zod";
import { responseBody } from "./envelope";
import {
  BusinessDateSchema,
  EnteredPaise,
  NonNegativePaise,
  PaymentMethod,
  PositivePaise,
  ProvisionalRef,
  ReceiptNumber,
  SignedPaise,
  Timestamp,
  Uuid,
} from "./primitives";

export const CollectionDateParams = z.object({
  date: BusinessDateSchema.describe(
    "The India-time business date (YYYY-MM-DD). Linemen can read only their own days; future dates are VALIDATION.",
  ),
});

export const HandoverStatus = z.enum(["open", "submitted", "accepted", "returned"]).meta({
  id: "HandoverStatus",
  description: [
    "Where the day's cash handover stands:",
    "- open: not handed over yet.",
    "- submitted: the lineman handed over; the office has not checked it.",
    "- accepted: the office accepted it (final).",
    "- returned: the office sent it back with a note; the lineman can submit again.",
  ].join("\n"),
});

export const DiscrepancyReason = z.enum(["short", "extra", "pending_sync", "other"]).meta({
  id: "DiscrepancyReason",
  description: [
    "Why the cash handed over differs from the expected cash (picked from icon tiles, PLAN §11.3):",
    "- short: less cash than expected.",
    "- extra: more cash than expected.",
    "- pending_sync: some payments are still on the phone, so the server total is behind.",
    "- other: anything else (explain in the note).",
  ].join("\n"),
});

export const DayPayment = z
  .object({
    payment_id: Uuid.describe("Payment id."),
    customer_id: Uuid.describe("Customer id."),
    customer_code: z.string().min(1).max(64).describe("Customer code."),
    customer_name: z.string().min(1).max(200).describe("Customer name."),
    amount_paise: PositivePaise.describe("Amount, in paise."),
    method: PaymentMethod.describe("Cash or UPI."),
    recorded_at: Timestamp.describe("When it was taken, by the phone's clock (UTC)."),
    posted_at: Timestamp.describe("When the server accepted it (UTC)."),
    receipt_number: ReceiptNumber.describe("Permanent receipt number."),
    provisional_ref: ProvisionalRef.nullable().describe(
      "The phone's provisional reference, or null for a payment not taken on a phone.",
    ),
    reversed: z
      .boolean()
      .describe("True if the owner reversed it; reversed payments are not in the totals."),
  })
  .meta({ id: "DayPayment", description: "A payment the server has for this lineman and day." });

export const Handover = z
  .object({
    submission_id: Uuid.describe("The submission_id of the latest handover."),
    cash_expected_paise: NonNegativePaise.describe(
      "Cash the server expected when the handover was submitted, in paise (server-side cash total; UPI excluded).",
    ),
    cash_handed_over_paise: NonNegativePaise.describe("Cash the lineman handed over, in paise."),
    discrepancy_paise: SignedPaise.describe(
      "cash_handed_over_paise − cash_expected_paise, computed by the server. Negative = short, positive = extra.",
    ),
    discrepancy_reason: DiscrepancyReason.nullable().describe(
      "The lineman's reason when there is a discrepancy, else null.",
    ),
    note: z.string().max(500).nullable().describe("The lineman's note, or null."),
    unsynced_payment_count: z
      .int()
      .min(0)
      .describe(
        "Payments still on the phone when the handover was submitted (warning for office).",
      ),
    unsynced_cash_paise: NonNegativePaise.describe(
      "Cash of those unsynced payments, in paise, as the phone reported it.",
    ),
    submitted_at: Timestamp.describe("When the server received the handover (UTC)."),
    reviewed_at: Timestamp.nullable().describe(
      "When the office accepted or returned it (UTC), or null while submitted.",
    ),
    review_note: z
      .string()
      .max(500)
      .nullable()
      .describe("The office's note when it returned (or accepted) the handover, or null."),
  })
  .meta({ id: "Handover", description: "The latest cash handover for the day." });

export const CollectionDay = z
  .object({
    business_date: BusinessDateSchema.describe("The India-time day (YYYY-MM-DD)."),
    cash_total_paise: NonNegativePaise.describe(
      "Cash collected (server-known, not reversed), in paise: the cash the office expects.",
    ),
    upi_total_paise: NonNegativePaise.describe(
      "UPI collected (server-known, not reversed), in paise. Not part of the cash handover.",
    ),
    payment_count: z.int().min(0).describe("Number of server-known payments, not reversed."),
    status: HandoverStatus.describe("Where the cash handover stands."),
    handover: Handover.nullable().describe("The latest handover, or null while status is open."),
    payments: z
      .array(DayPayment)
      .describe(
        "The day's server-known payments by this lineman, newest first (including reversed ones, flagged).",
      ),
  })
  .meta({
    id: "CollectionDay",
    description:
      "The lineman's collection session for one business date (PLAN §8.7). All zero with status 'open' if nothing was collected.",
  });

export type CollectionDay = z.infer<typeof CollectionDay>;

export const CollectionDayResponse = responseBody(
  "CollectionDayResponse",
  "The lineman's own totals for the day (the Today screen).",
  { session: CollectionDay.describe("The day's totals, payments and handover.") },
);

export type CollectionDayResponse = z.infer<typeof CollectionDayResponse>;

export const HandoverRequest = z
  .object({
    submission_id: Uuid.describe(
      "Idempotency key for this submission (a new UUID per Submit tap; reuse it when retrying the same submission).",
    ),
    cash_handed_over_paise: EnteredPaise.describe("Cash the lineman hands over, in paise (≥ 0)."),
    discrepancy_reason: DiscrepancyReason.nullish().describe(
      "Required when the cash differs from the server's expected cash (VALIDATION otherwise); omit or null when it matches.",
    ),
    note: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .nullish()
      .describe("Optional note (e.g. for 'other'). Omit or null for none."),
    unsynced_payment_count: z
      .int()
      .min(0)
      .max(10_000)
      .describe("How many of this day's payments are still on the phone (0 when all synced)."),
    unsynced_cash_paise: EnteredPaise.describe(
      "Total cash of those unsynced payments, in paise (0 when all synced).",
    ),
  })
  .meta({
    id: "HandoverRequest",
    description:
      "Hand over the day's cash. Allowed while the day is open, submitted or returned; a new submission replaces the previous one. Once accepted: HANDOVER_ALREADY_ACCEPTED.",
  });

export type HandoverRequest = z.infer<typeof HandoverRequest>;

export const HandoverResponse = responseBody(
  "HandoverResponse",
  "The day after the handover (status 'submitted'). Repeating the same submission_id returns the current state.",
  { session: CollectionDay.describe("The day's totals, payments and handover.") },
);

export type HandoverResponse = z.infer<typeof HandoverResponse>;
