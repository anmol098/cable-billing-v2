/**
 * Wire primitives shared by every schema in the mobile contract.
 *
 * - **Field names are `snake_case`** (PLAN §10.2: `install_id`, `min_app_version`, `server_time`).
 * - **Money** is an integer number of **paise** (`*_paise`). Never a float, never rupees. The
 *   inferred TypeScript type is `@cb/domain`'s branded `Paise`, so server code must build amounts
 *   through `paise()` / `toPaise()`; parsing a request yields a checked `Paise` without a transform.
 * - **Instants** are ISO-8601 strings in UTC with a `Z` suffix (`2026-10-13T05:30:00.000Z`).
 * - **Business dates and periods** are `YYYY-MM-DD` in India time (`Asia/Kolkata`). A period is the
 *   1st of its month.
 * - **Ids** are UUID strings (UUIDv7 in practice; the contract only promises "a UUID").
 *
 * Schemas here carry no transforms, so the request (input) and response (output) JSON Schema are the
 * same and `openapi.json` stays one schema per component.
 */

import {
  type BusinessDate,
  isBusinessDate,
  isPeriod,
  MAX_INPUT_RUPEES,
  PAISE_PER_RUPEE,
  type Paise,
  type Period,
} from "@cb/domain";
import * as z from "zod";

/** The largest amount (paise) one payment or handover can carry: 13 rupee digits (`MAX_INPUT_RUPEES`). */
export const MAX_AMOUNT_PAISE = MAX_INPUT_RUPEES * PAISE_PER_RUPEE;

/** Re-types a schema's output (for `@cb/domain` brands) without changing its runtime behaviour. */
function branded<T, I>(schema: z.ZodType<I>): z.ZodType<T, I> {
  return schema as unknown as z.ZodType<T, I>;
}

// ── Identity ─────────────────────────────────────────────────────────────────────────────────────

/** Any UUID (RFC 9562). Server ids are UUIDv7; the phone generates UUIDv7 for payments. */
export const Uuid = z.uuid().meta({
  description:
    "A UUID (RFC 9562) as 36 hex characters with dashes; the server sends lower case. Ids are UUIDv7 in practice.",
  example: "0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b",
});

// ── Time ─────────────────────────────────────────────────────────────────────────────────────────

/** An instant in UTC: ISO-8601 with a `Z` suffix. Offsets other than `Z` are refused. */
export const Timestamp = z.iso.datetime({ offset: false, local: false }).meta({
  description:
    "An instant in UTC as ISO-8601 with a 'Z' suffix (no other offset), e.g. 2026-10-13T05:30:00.000Z. Millisecond precision.",
  example: "2026-10-13T05:30:00.000Z",
});

/** A calendar date in India (`Asia/Kolkata`), `YYYY-MM-DD`. Typed as `@cb/domain` `BusinessDate`. */
export const BusinessDateSchema = branded<BusinessDate, string>(
  z.iso.date().refine(isBusinessDate, { message: "Not a real calendar date" }).meta({
    description:
      "A business date: a calendar date in India time (Asia/Kolkata), YYYY-MM-DD. The IST day starts at 18:30 UTC the previous day.",
    example: "2026-10-13",
  }),
);

/** A billing period: the 1st of a month, `YYYY-MM-01`. Typed as `@cb/domain` `Period`. */
export const PeriodSchema = branded<Period, string>(
  z.iso.date().refine(isPeriod, { message: "A period is the 1st of a month (YYYY-MM-01)" }).meta({
    description: "A billing period (calendar month), written as its first day: YYYY-MM-01.",
    example: "2026-10-01",
  }),
);

// ── Money (integer paise) ────────────────────────────────────────────────────────────────────────

const PAISE_NOTE = "Integer paise (₹1 = 100 paise); never a fraction.";

/** A positive amount of paise (> 0), at most {@link MAX_AMOUNT_PAISE}. */
export const PositivePaise = branded<Paise, number>(
  z
    .int()
    .min(1)
    .max(MAX_AMOUNT_PAISE)
    .meta({ description: `A positive amount. ${PAISE_NOTE}`, example: 50000 }),
);

/** A non-negative amount of paise (≥ 0). */
export const NonNegativePaise = branded<Paise, number>(
  z
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .meta({ description: `A zero or positive amount. ${PAISE_NOTE}`, example: 45000 }),
);

/** A zero or positive amount a person entered (≥ 0), at most {@link MAX_AMOUNT_PAISE}. */
export const EnteredPaise = branded<Paise, number>(
  z
    .int()
    .min(0)
    .max(MAX_AMOUNT_PAISE)
    .meta({ description: `A zero or positive amount a person entered. ${PAISE_NOTE}`, example: 0 }),
);

/** A signed amount of paise (balances, discrepancies). */
export const SignedPaise = branded<Paise, number>(
  z
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER)
    .meta({ description: `A signed amount. ${PAISE_NOTE}`, example: -5000 }),
);

// ── Other shared shapes ──────────────────────────────────────────────────────────────────────────

/** An opaque pagination / sync cursor. Clients store it and send it back unchanged. */
export const Cursor = z.string().min(1).max(512).meta({
  description:
    "An opaque cursor. Store it and send it back unchanged; never parse or build one on the phone.",
  example: "eyJ1IjoiMjAyNi0xMC0xM1QwNTozMDowMC4wMDBaIiwiaSI6IjAxOTJhM2I0In0",
});

/** An Indian mobile number as the phone sends it: 10 digits, starting 6–9, no `+91`. */
export const IndianMobile = z
  .string()
  .regex(/^[6-9][0-9]{9}$/)
  .meta({
    description:
      "An Indian mobile number: exactly 10 digits starting with 6, 7, 8 or 9, without +91 or spaces.",
    example: "9876543210",
  });

/** UI language of a user. */
export const Language = z.enum(["hi", "en"]).meta({
  description: "UI language: 'hi' (Hindi, the Android default) or 'en' (English).",
  example: "hi",
});

/** Payment method (BRD §6.2: cash or UPI recorded by hand, no gateway). */
export const PaymentMethod = z.enum(["cash", "upi"]).meta({
  id: "PaymentMethod",
  description: "How the customer paid: 'cash' or 'upi' (UPI is recorded by hand, not verified).",
});

/** Provisional receipt reference made on the phone: `P-{deviceCode}-{localSeq:04}` (PLAN §7.3). */
export const ProvisionalRef = z
  .string()
  .regex(/^P-[A-Z0-9]{3}-[0-9]{4,9}$/)
  .meta({
    description:
      "Provisional receipt reference made on the phone before sync: P-{device_code}-{local sequence, at least 4 digits}. Linked forever to the permanent receipt number (FR-016).",
    example: "P-K7Q-0012",
  });

/** Permanent receipt number given by the server when it accepts a payment (`R-{YYMM}-{seq:05}`). */
export const ReceiptNumber = z.string().min(1).max(64).meta({
  description:
    "Permanent receipt number, assigned only when the server accepts the payment. Usually R-{YYMM}-{seq:05}; migrated receipts may differ, so never parse it.",
  example: "R-2610-00045",
});

/** Invoice (bill) number, `INV-{YYMM}-{seq:05}` by default; the operator may change the prefix. */
export const InvoiceNumber = z.string().min(1).max(64).meta({
  description:
    "Bill (invoice) number. Usually INV-{YYMM}-{seq:05}, but the operator's prefix and migrated bills may differ, so never parse it.",
  example: "INV-2610-00123",
});

/** Optional free text a person typed (notes, reasons). */
export function freeText(max: number, description: string) {
  return z.string().max(max).meta({ description });
}
