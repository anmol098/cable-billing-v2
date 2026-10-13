/**
 * Customers as the phone sees them (PLAN §10.3, §11.3): the roster row cached in Room, the fresh
 * detail fetched when online, and the phone-number correction from the receipt flow (FR-004).
 * Served by T-060.
 */

import * as z from "zod";
import { responseBody } from "./envelope";
import {
  IndianMobile,
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

export const AreaRef = z
  .object({
    id: Uuid.describe("Area id."),
    name: z.string().min(1).max(200).describe("Area name as the operator typed it."),
  })
  .meta({ id: "AreaRef", description: "The area (locality) a customer belongs to." });

export const ConnectionStatus = z.enum(["active", "suspended"]).meta({
  id: "ConnectionStatus",
  description:
    "'active' or 'suspended' (temporarily off). Disconnected connections are not sent to the phone.",
});

export const Connection = z
  .object({
    vc_number: z
      .string()
      .min(1)
      .max(64)
      .describe(
        "VC (viewing card) number as stored, searched by the number pad. Match on digits; never parse it.",
      ),
    status: ConnectionStatus.describe("Whether the connection is on or suspended."),
  })
  .meta({
    id: "Connection",
    description: "One current connection (VC assignment) of the customer.",
  });

export const OpenBillsSummary = z
  .object({
    count: z.int().min(0).describe("Number of bills that still have money left to pay."),
    outstanding_paise: NonNegativePaise.describe(
      "Money left to pay on those bills, in paise (the sum of their outstanding amounts).",
    ),
    oldest_period: PeriodSchema.nullable().describe(
      "Month of the oldest unpaid bill (YYYY-MM-01), or null when nothing is unpaid.",
    ),
  })
  .meta({ id: "OpenBillsSummary", description: "Summary of the customer's unpaid bills." });

export const RosterCustomer = z
  .object({
    id: Uuid.describe("Customer id."),
    code: z
      .string()
      .min(1)
      .max(64)
      .describe("Customer code, unique within the operator (searchable, e.g. '1045')."),
    name: z.string().min(1).max(200).describe("Customer name."),
    phone: z
      .string()
      .max(20)
      .nullable()
      .describe(
        "Primary phone as stored (legacy data may not be a clean 10-digit number; confirm before using it, FR-004). Null when missing.",
      ),
    alt_phone: z.string().max(20).nullable().describe("Second phone as stored, or null."),
    address: z.string().max(500).nullable().describe("Address as one line of text, or null."),
    area: AreaRef.nullable().describe("The customer's area, or null when none is set."),
    active: z
      .boolean()
      .describe(
        "False when the customer is deactivated. The roster never sends inactive customers (they come as removed_customer_ids); customer detail may.",
      ),
    connections: z
      .array(Connection)
      .describe("Current connections (active or suspended), oldest first. May be empty."),
    balance_paise: SignedPaise.describe(
      "The customer's ledger balance in paise. Positive: the customer owes this much in total. Zero or negative: nothing is due (negative means paid in advance). Show max(balance_paise, 0) as the due amount.",
    ),
    credit_paise: NonNegativePaise.describe(
      "Advance (credit) in paise: money paid that is not yet used for any bill. Shown separately from the due (D-14).",
    ),
    open_bills: OpenBillsSummary.describe("Summary of unpaid bills."),
    updated_at: Timestamp.describe(
      "When anything in this row last changed on the server (UTC). Part of the sync order.",
    ),
  })
  .meta({
    id: "RosterCustomer",
    description:
      "A customer as cached on the phone for search and the customer screen (PLAN §10.3). The roster and the customer detail use the same shape, so the app can upsert either.",
  });

export type RosterCustomer = z.infer<typeof RosterCustomer>;

// ── GET /customers/{id} ──────────────────────────────────────────────────────────────────────────

export const CustomerIdParams = z.object({
  id: Uuid.describe("Customer id."),
});

export const BillKind = z.enum(["regular", "opening_balance"]).meta({
  id: "BillKind",
  description:
    "'regular' for a monthly bill, 'opening_balance' for old dues brought in when the operator started using Cable Billing.",
});

export const OpenBill = z
  .object({
    invoice_id: Uuid.describe("Bill (invoice) id."),
    invoice_number: InvoiceNumber.describe("Bill number."),
    kind: BillKind.describe("Monthly bill or old dues."),
    period: PeriodSchema.describe("The month the bill is for (YYYY-MM-01)."),
    charges_paise: NonNegativePaise.describe(
      "This bill's own charges in paise (rent and adjustments of the month; old dues for an opening_balance bill). Excludes earlier months' arrears.",
    ),
    outstanding_paise: PositivePaise.describe(
      "Money still to pay on this bill, in paise (always > 0 for an open bill).",
    ),
  })
  .meta({ id: "OpenBill", description: "A bill that still has money left to pay." });

export const RecentPayment = z
  .object({
    payment_id: Uuid.describe("Payment id (the phone's idempotency key for phone payments)."),
    amount_paise: PositivePaise.describe("Amount paid, in paise."),
    method: PaymentMethod.describe("Cash or UPI."),
    recorded_at: Timestamp.describe(
      "When the payment was taken, by the collecting device's clock (UTC).",
    ),
    posted_at: Timestamp.describe("When the server accepted it (UTC)."),
    receipt_number: ReceiptNumber.describe("Permanent receipt number."),
    provisional_ref: ProvisionalRef.nullable().describe(
      "The phone's provisional reference if the payment was taken on a phone, else null.",
    ),
    collected_by_name: z
      .string()
      .max(200)
      .nullable()
      .describe("Name of the person who took the payment, or null if unknown (migrated data)."),
    reversed: z
      .boolean()
      .describe("True if the owner cancelled (reversed) this payment; its receipt is 'Cancelled'."),
  })
  .meta({ id: "RecentPayment", description: "One of the customer's latest payments." });

export const CustomerDetailResponse = responseBody(
  "CustomerDetailResponse",
  "Fresh customer detail for the customer screen when online. Upsert `customer` into the roster cache.",
  {
    customer: RosterCustomer.describe("The customer, same shape as a roster row."),
    open_bills: z
      .array(OpenBill)
      .describe("Unpaid bills, oldest first (the order payments are applied, PRD §13.2)."),
    recent_payments: z
      .array(RecentPayment)
      .max(20)
      .describe("The latest payments, newest first (at most 20; the server usually sends 10)."),
  },
);

export type CustomerDetailResponse = z.infer<typeof CustomerDetailResponse>;

// ── PATCH /customers/{id}/phone ──────────────────────────────────────────────────────────────────

export const UpdatePhoneRequest = z
  .object({
    phone: IndianMobile.describe("The confirmed or corrected primary mobile number."),
  })
  .meta({
    id: "UpdatePhoneRequest",
    description:
      "Correct the customer's primary phone from the receipt flow (FR-004). Audited with source 'android'. Sending the current number again changes nothing.",
  });

export type UpdatePhoneRequest = z.infer<typeof UpdatePhoneRequest>;

export const UpdatePhoneResponse = responseBody(
  "UpdatePhoneResponse",
  "The customer after the change. Upsert it into the roster cache.",
  {
    changed: z
      .boolean()
      .describe("True if the number changed; false if it already was this number."),
    customer: RosterCustomer.describe("The customer after the change."),
  },
);

export type UpdatePhoneResponse = z.infer<typeof UpdatePhoneResponse>;
