/**
 * What the review Server Actions answer (T-062), and the mapping from a service error to the words
 * the office sees (`linemen.review.error.*`). Pure, client-safe.
 */

export type ReviewErrorKey =
  | "already_accepted"
  | "already_returned"
  | "not_submitted"
  | "resubmitted"
  | "read_only"
  | "note_required"
  | "generic";

export type ReviewActionResult =
  | { readonly ok: true; readonly status: "accepted" | "returned" }
  | { readonly ok: false; readonly error: ReviewErrorKey };

const CONFLICT_REASONS = new Set<ReviewErrorKey>([
  "already_accepted",
  "already_returned",
  "not_submitted",
  "resubmitted",
]);

/** A service error (code + details) → the key of the message to show. */
export function reviewErrorKey(error: {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): ReviewErrorKey {
  if (error.code === "CONFLICT") {
    const reason = error.details?.reason;
    if (typeof reason === "string" && CONFLICT_REASONS.has(reason as ReviewErrorKey)) {
      return reason as ReviewErrorKey;
    }
    return "generic";
  }
  if (error.code === "TENANT_READ_ONLY") return "read_only";
  if (error.code === "VALIDATION") {
    const fields = error.details?.fields;
    if (Array.isArray(fields) && fields.some((f) => (f as { path?: unknown }).path === "note")) {
      return "note_required";
    }
  }
  return "generic";
}

/** Errors after which the page must be reloaded: the handover changed under the office. */
export function isStale(key: ReviewErrorKey): boolean {
  return CONFLICT_REASONS.has(key);
}
