/**
 * What the Bills Server Actions answer (T-047), and the mapping from a service error to the words
 * the Owner sees (`bills.error.*`). Pure, client-safe.
 */

export type RunErrorKey =
  | "forbidden"
  | "read_only"
  | "period"
  | "run_skipped"
  | "not_found"
  | "generic";

export type RunActionResult =
  | {
      readonly ok: true;
      /** `startBillingRun` / `retryFailedItems` outcomes. */
      readonly outcome: "started" | "already_running" | "nothing_to_retry";
    }
  | { readonly ok: false; readonly error: RunErrorKey };

/** A service error (code + details) → the key of the message to show. */
export function runErrorKey(error: {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}): RunErrorKey {
  switch (error.code) {
    case "FORBIDDEN":
      return "forbidden";
    case "TENANT_READ_ONLY":
      return "read_only";
    case "NOT_FOUND":
      return "not_found";
    case "VALIDATION":
      return "period";
    case "CONFLICT":
      return error.details?.reason === "run_skipped" ? "run_skipped" : "generic";
    default:
      return "generic";
  }
}
