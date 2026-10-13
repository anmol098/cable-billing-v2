/**
 * Idempotency payload comparison (PLAN §8.4, FR-015): a payment id seen again is a replay only if
 * the client sent the same payment. Pure.
 *
 * Compared (what the client chose): customer, amount, method, UPI reference, notes, the
 * provisional reference, and `recorded_at` when the caller sent one (the web counter usually
 * doesn't; then the server's clock was used and a retry can't repeat it).
 *
 * Not compared: the claimed collector/device (never trusted; a different user re-sending the
 * phone's queue is still the same payment) and anything the server derived (posting time,
 * balances, review flags, receipt number).
 */
import type { PaymentMethod } from "@cb/db";

/** What the client sent for a payment, normalised (absent optional values are null). */
export interface PaymentPayload {
  readonly customerId: string;
  readonly amountPaise: number;
  readonly method: PaymentMethod;
  readonly upiReference: string | null;
  readonly notes: string | null;
  readonly provisionalRef: string | null;
  /** null: not sent by the client (not compared). */
  readonly recordedAt: Date | null;
}

/** The stored side: the payment row and its receipt's provisional reference. */
export interface StoredPayload {
  readonly customerId: string;
  readonly amountPaise: number;
  readonly method: PaymentMethod;
  readonly upiReference: string | null;
  readonly notes: string | null;
  readonly provisionalRef: string | null;
  readonly recordedAt: Date;
}

/** Names of the fields that differ (empty: same payment). Names only, never values. */
export function payloadDifferences(sent: PaymentPayload, stored: StoredPayload): string[] {
  const differences: string[] = [];
  if (sent.customerId.toLowerCase() !== stored.customerId.toLowerCase()) {
    differences.push("customerId");
  }
  if (sent.amountPaise !== stored.amountPaise) differences.push("amountPaise");
  if (sent.method !== stored.method) differences.push("method");
  if (sent.upiReference !== stored.upiReference) differences.push("upiReference");
  if (sent.notes !== stored.notes) differences.push("notes");
  if (sent.provisionalRef !== stored.provisionalRef) differences.push("provisionalRef");
  if (sent.recordedAt !== null && sent.recordedAt.getTime() !== stored.recordedAt.getTime()) {
    differences.push("recordedAt");
  }
  return differences;
}
