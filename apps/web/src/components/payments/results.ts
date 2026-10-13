/**
 * What the payment Server Actions answer (T-048), and the mapping from a service error (code +
 * details) to the words the office sees. Pure and client-safe: the client components import the
 * types, the actions import the mappers, the tests check both.
 */
import type { PaymentReviewReason } from "@cb/db";

type ErrorLike = {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
};

function fieldPaths(error: ErrorLike): string[] {
  const fields = error.details?.fields;
  if (!Array.isArray(fields)) return [];
  return fields
    .map((field) => (field as { path?: unknown }).path)
    .filter((path): path is string => typeof path === "string");
}

// --- Customer search ---------------------------------------------------------------------------

/** A customer as the counter's picker shows it. */
export interface PickerCustomer {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly phone: string | null;
  readonly areaName: string | null;
  /** Signed: > 0 due, < 0 credit. */
  readonly balancePaise: number;
  readonly active: boolean;
}

export type FindCustomersResult =
  | { readonly ok: true; readonly customers: readonly PickerCustomer[] }
  | { readonly ok: false };

// --- Take payment ------------------------------------------------------------------------------

export interface TakePaymentInput {
  /** The form's payment id (made once in the browser, reused on retries). */
  readonly id: string;
  readonly customerId: string;
  readonly amountPaise: number;
  readonly method: "cash" | "upi";
  readonly upiReference?: string;
}

export interface SavedPayment {
  readonly paymentId: string;
  /** `duplicate` = this form was already saved (a retry or double click): the stored result. */
  readonly outcome: "posted" | "posted_needs_review" | "duplicate";
  readonly receiptNumber: string;
  readonly amountPaise: number;
  readonly method: "cash" | "upi";
  /** The customer's balance right after this payment (signed). */
  readonly newBalancePaise: number;
  readonly reviewReason: PaymentReviewReason | null;
  /** Undone since (only possible for a duplicate). */
  readonly cancelled: boolean;
}

export type TakePaymentErrorKey =
  | "amount"
  | "upi_ref"
  | "customer_not_found"
  | "already_saved_different"
  | "busy"
  | "generic";

export type TakePaymentResult =
  | { readonly ok: true; readonly payment: SavedPayment }
  | { readonly ok: false; readonly error: TakePaymentErrorKey };

export function takePaymentErrorKey(error: ErrorLike): TakePaymentErrorKey {
  switch (error.code) {
    case "ID_REUSED_WITH_DIFFERENT_DATA":
      return "already_saved_different";
    case "NOT_FOUND":
      return "customer_not_found";
    case "VALIDATION": {
      const paths = fieldPaths(error);
      if (paths.includes("upiReference")) return "upi_ref";
      if (paths.includes("amountPaise")) return "amount";
      if (paths.includes("customerId")) return "customer_not_found";
      return "generic";
    }
    case "CONFLICT":
      return error.details?.retryable === true ? "busy" : "generic";
    default:
      return "generic";
  }
}

// --- Receipt link ------------------------------------------------------------------------------

export type ReceiptLinkErrorKey = "too_many_links" | "not_found" | "generic";

export type ReceiptLinkResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly error: ReceiptLinkErrorKey };

export function receiptLinkErrorKey(error: ErrorLike): ReceiptLinkErrorKey {
  if (error.code === "NOT_FOUND") return "not_found";
  if (error.code === "CONFLICT" && error.details?.reason === "too_many_links") {
    return "too_many_links";
  }
  return "generic";
}

// --- Mark as checked ---------------------------------------------------------------------------

export type ResolveErrorKey = "already_resolved" | "not_flagged" | "read_only" | "generic";

export type ResolveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ResolveErrorKey };

export function resolveErrorKey(error: ErrorLike): ResolveErrorKey {
  if (error.code === "TENANT_READ_ONLY") return "read_only";
  if (error.code === "CONFLICT") {
    const reason = error.details?.reason;
    if (reason === "already_resolved" || reason === "not_flagged") return reason;
  }
  return "generic";
}

// --- Undo payment ------------------------------------------------------------------------------

export type UndoErrorKey =
  | "already_cancelled"
  | "forbidden"
  | "read_only"
  | "reason_required"
  | "note_required"
  | "generic";

export type UndoResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: UndoErrorKey };

export function undoErrorKey(error: ErrorLike): UndoErrorKey {
  if (error.code === "CONFLICT" && error.details?.reason === "already_reversed") {
    return "already_cancelled";
  }
  if (error.code === "FORBIDDEN") return "forbidden";
  if (error.code === "TENANT_READ_ONLY") return "read_only";
  return "generic";
}
