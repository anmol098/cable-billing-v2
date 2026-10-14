/**
 * What the plan-change / back-dated change screen sends and gets back (T-045). Client-safe: plain
 * data only (no `@cb/core` runtime import), so the client form and the Server Actions share it.
 */

export type ChangeKind = "plan" | "suspend" | "reactivate" | "disconnect";

export const STOP_REASONS = [
  "not_paying",
  "customer_asked",
  "moved_away",
  "box_problem",
  "other",
] as const;
export type StopReasonCode = (typeof STOP_REASONS)[number];

export interface ChangeInput {
  readonly assignmentId: string;
  readonly effectiveDate: string;
  readonly kind: ChangeKind;
  /** plan: an active plan … */
  readonly planId?: string | null;
  /** … or an own amount (paise). */
  readonly rentalPaise?: number | null;
  /** suspend (optional) / disconnect (required). */
  readonly stopReason?: StopReasonCode | null;
}

/** One month of the effect (mirrors `@cb/core` `MonthEffectView`). */
export interface MonthEffectData {
  readonly period: string;
  readonly scope: "change_month" | "later_month";
  readonly outcome:
    | { readonly kind: "none"; readonly reason: string }
    | { readonly kind: "debit" | "credit"; readonly amountPaise: number };
  readonly chargedBeforePaise: number;
  readonly chargedAfterPaise: number;
}

/** Mirrors `@cb/core` `ConnectionChangePreview` (what the form shows). */
export interface PreviewData {
  readonly kind: ChangeKind;
  readonly fromRentalPaise: number;
  readonly toRentalPaise: number;
  readonly noChange: boolean;
  readonly backDated: boolean;
  readonly latestBilledPeriod: string | null;
  readonly months: readonly MonthEffectData[];
  readonly totalPaise: number;
}

/** The `adjustments` namespace `error.*` keys a change can end with. */
export type ChangeErrorKey =
  | "generic"
  | "in_future"
  | "too_old"
  | "before_start"
  | "before_last_change"
  | "retired"
  | "plan_or_amount"
  | "amount"
  | "invalid_transition"
  | "billed_period"
  | "not_allowed"
  | "read_only"
  | "not_found"
  | "reason"
  | "stop_reason";

export type PreviewResult =
  | { readonly ok: true; readonly preview: PreviewData }
  | { readonly ok: false; readonly error: ChangeErrorKey };

export type SaveResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ChangeErrorKey };

interface ErrorLike {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}

const DATE_CODES = new Set(["in_future", "too_old", "before_start", "before_last_change"]);

/** A service error → the message key (never shows ids or raw messages). */
export function changeErrorKey(error: ErrorLike): ChangeErrorKey {
  switch (error.code) {
    case "FORBIDDEN":
      return "not_allowed";
    case "TENANT_READ_ONLY":
      return "read_only";
    case "NOT_FOUND":
      return "not_found";
    case "CONFLICT": {
      const reason = error.details?.reason;
      if (reason === "billed_period") return "billed_period";
      if (reason === "invalid_transition") return "invalid_transition";
      return "generic";
    }
    case "VALIDATION": {
      const fields = Array.isArray(error.details?.fields)
        ? (error.details.fields as { path?: unknown; code?: unknown }[])
        : [];
      for (const field of fields) {
        const path = String(field.path ?? "");
        const code = String(field.code ?? "");
        if (path.endsWith("effectiveDate") && DATE_CODES.has(code)) return code as ChangeErrorKey;
        if (path === "reason") return "reason";
        if (path.endsWith("stopReason")) return "stop_reason";
        if (path.endsWith("planId")) return code === "retired" ? "retired" : "plan_or_amount";
        if (path.endsWith("rentalPaise")) return "amount";
      }
      return "generic";
    }
    default:
      return "generic";
  }
}
