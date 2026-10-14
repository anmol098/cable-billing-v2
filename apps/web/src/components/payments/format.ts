/**
 * Pure helpers for the payment pages (T-048): URLs, money and time words, the counter's payment id,
 * and the Owner's undo reasons. No next-intl import (the translator is passed in) and no server
 * code, so client components and unit tests use them directly.
 *
 * Money is integer paise everywhere; the counter's amount box takes whole rupees (D-17) and gives
 * paise (`AmountInput`). Instants are shown in IST (CLAUDE.md "Time").
 */
import {
  type BusinessDate,
  businessDateOf,
  type DisplayLocale,
  formatBusinessDate,
  isBusinessDate,
} from "@cb/domain";
import { formatRupees } from "@cb/ui";

/** A translator for the `payments` namespace (next-intl's `t`, or a test double). */
export type Translate = (key: string, values?: Record<string, string | number>) => string;

// ---------------------------------------------------------------------------------------------
// URLs

export function paymentHref(paymentId: string): string {
  return `/payments/${paymentId}`;
}

/** The A5 receipt (PDF) of a payment, opened in a new tab to print. */
export function receiptPrintHref(paymentId: string): string {
  return `/payments/${paymentId}/receipt`;
}

export function undoHref(paymentId: string): string {
  return `/payments/${paymentId}/undo`;
}

/** `/payments/new`, or with the customer already chosen (T-033 "Take payment"). */
export function takePaymentHref(customerId?: string): string {
  return customerId ? `/payments/new?customer=${encodeURIComponent(customerId)}` : "/payments/new";
}

/** `path?a=1&b=2`, leaving out empty values. */
export function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) query.set(key, value);
  const text = query.toString();
  return text ? `${path}?${text}` : path;
}

// ---------------------------------------------------------------------------------------------
// Money and time words

/** `₹1,23,456` (Indian grouping) for an amount; the sign is dropped. */
export function rupees(paise: number): string {
  return formatRupees(paise).text;
}

/** `₹500 due` / `₹200 credit` / `Nothing due` for a signed balance (> 0 due, < 0 credit). */
export function balanceText(t: Translate, balancePaise: number): string {
  if (balancePaise > 0) return t("balance.due", { amount: digits(balancePaise) });
  if (balancePaise < 0) return t("balance.credit", { amount: digits(-balancePaise) });
  return t("balance.clear");
}

/** `1,23,456` (no ₹): for messages that put the ₹ in the sentence (glossary rule). */
function digits(paise: number): string {
  return rupees(paise).replace(/^₹/, "");
}

const IST_CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

/** `"4:05"` + AM/PM of an instant, in IST. */
export function istClock(at: Date): { time: string; pm: boolean } {
  const parts = IST_CLOCK.formatToParts(at);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const period = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  return { time: `${hour}:${minute}`, pm: period.toLowerCase().startsWith("p") };
}

/** `13 Oct 2026, 4:05 PM` (IST). */
export function whenText(t: Translate, at: Date, locale: DisplayLocale): string {
  const { time, pm } = istClock(at);
  return t("date_time", {
    date: formatBusinessDate(businessDateOf(at), locale),
    time: t(pm ? "time_pm" : "time_am", { time }),
  });
}

// ---------------------------------------------------------------------------------------------
// Register filters

/** A `YYYY-MM-DD` from the URL, or `undefined`. */
export function dayParam(raw: string | string[] | undefined): BusinessDate | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && isBusinessDate(value) ? value : undefined;
}

/** The first day of `date`'s month. */
export function monthStart(date: BusinessDate): BusinessDate {
  return `${date.slice(0, 8)}01` as BusinessDate;
}

// ---------------------------------------------------------------------------------------------
// The counter's payment id (FR-015 idempotency key)

/**
 * A UUIDv7 made in the browser when a counter payment is first saved, then reused for every retry
 * and double click of the same form, so the server posts it once (`payments.post` is idempotent
 * on the id: the same id again is a `duplicate`, never a second payment). Web Crypto
 * `getRandomValues` (works on plain-http LAN addresses too, unlike `randomUUID`).
 */
export function newPaymentId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ms = Math.floor(now);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 9562 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------------------------
// Undo reasons (PLAN §8.6 "choose a reason")

export const UNDO_REASONS = [
  "wrong_customer",
  "wrong_amount",
  "entered_twice",
  "not_received",
  "other",
] as const;
export type UndoReason = (typeof UNDO_REASONS)[number];

/** Longest note with a reason (`reason: note` stays within the service's 500 characters). */
export const MAX_UNDO_NOTE_LENGTH = 400;

export function isUndoReason(value: unknown): value is UndoReason {
  return typeof value === "string" && (UNDO_REASONS as readonly string[]).includes(value);
}

/**
 * What is stored as `payment_reversals.reason`: the reason's code, and the Owner's note after a
 * colon (`wrong_amount: typed 5000 instead of 500`). A code (not words) so the reason reads in the
 * viewer's language; the note is kept as typed.
 */
export function undoReasonText(reason: UndoReason, note: string): string {
  const trimmed = note.trim().slice(0, MAX_UNDO_NOTE_LENGTH);
  return trimmed ? `${reason}: ${trimmed}` : reason;
}

/** The reverse of {@link undoReasonText}; text stored some other way comes back as a note. */
export function parseUndoReason(text: string): { reason: UndoReason | null; note: string | null } {
  const match = /^([a-z_]+)(?::\s*([\s\S]*))?$/.exec(text.trim());
  if (match && isUndoReason(match[1])) {
    const note = match[2]?.trim();
    return { reason: match[1], note: note ? note : null };
  }
  return { reason: null, note: text.trim() || null };
}

/** The reason in words (+ the note): `Wrong amount: typed 5000 instead of 500`. */
export function undoReasonWords(t: Translate, text: string): string {
  const { reason, note } = parseUndoReason(text);
  if (!reason) return note ?? "";
  const word = t(`undo_reason.${reason}`);
  return note ? `${word}: ${note}` : word;
}
