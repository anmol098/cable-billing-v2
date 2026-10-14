/**
 * Shapes and pure helpers of the Bill changes pages (T-045). Client-safe (no `@cb/core` runtime
 * import).
 */

export type ManualDirection = "debit" | "credit";

export interface ManualInput {
  /** Made once when the form opens (a UUID), reused on retries. */
  readonly id: string;
  readonly customerId: string;
  readonly direction: ManualDirection;
  readonly amountPaise: number;
  readonly reason: string;
}

export type ManualErrorKey =
  | "generic"
  | "customer"
  | "direction"
  | "manual_amount"
  | "reason"
  | "not_allowed"
  | "read_only"
  | "not_found"
  | "id_reused";

export type ManualResult =
  | { readonly ok: true; readonly adjustmentId: string }
  | { readonly ok: false; readonly error: ManualErrorKey };

interface ErrorLike {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

/** A service error → the `adjustments.error.*` key. */
export function manualErrorKey(error: ErrorLike): ManualErrorKey {
  switch (error.code) {
    case "FORBIDDEN":
      return "not_allowed";
    case "TENANT_READ_ONLY":
      return "read_only";
    case "NOT_FOUND":
      return "not_found";
    case "CONFLICT":
      return error.details?.reason === "id_reused" ? "id_reused" : "generic";
    case "VALIDATION": {
      const fields = Array.isArray(error.details?.fields)
        ? (error.details.fields as { path?: unknown }[])
        : [];
      const paths = fields.map((f) => String(f.path ?? ""));
      if (paths.includes("customerId")) return "customer";
      if (paths.includes("direction")) return "direction";
      if (paths.includes("amountPaise")) return "manual_amount";
      if (paths.includes("reason")) return "reason";
      return "generic";
    }
    default:
      return "generic";
  }
}

/** A random UUIDv7-shaped id for the form (the server only needs a UUID). */
export function newFormId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ms = Math.floor(now);
  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const ADJUSTMENT_SOURCES = [
  "plan_change",
  "mid_month_start",
  "manual",
  "migration",
] as const;
export const ADJUSTMENT_STATES = ["pending", "billed", "credit"] as const;
