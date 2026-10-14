/**
 * What the Owner's "Add connection" (T-045a) sends and gets back. Client-safe: plain data only (no
 * `@cb/core` runtime import), so the client form, the Server Actions and the tests share it.
 */
import type { ConnectionFormState, ConnectionFormValues } from "../_parts/form-state";
import { OWN_AMOUNT } from "../_parts/form-state";
import type { ChangeErrorKey, MonthEffectData } from "../_plan-change/results";

/** The money facts of a new connection: its rent (plan or own amount) and start day. */
export interface AddPreviewInput {
  readonly planId?: string;
  readonly rentalPaise?: number;
  readonly startDate: string;
}

/** Mirrors `@cb/core` `AddConnectionPreview` (what the form shows). */
export interface AddPreviewData {
  readonly startDate: string;
  readonly rentalPaise: number;
  /** The start day reaches back into a billed month: the Owner's flow, with a reason. */
  readonly backDated: boolean;
  readonly latestBilledPeriod: string | null;
  readonly months: readonly MonthEffectData[];
  readonly totalPaise: number;
}

export type AddPreviewResult =
  | { readonly ok: true; readonly preview: AddPreviewData }
  | { readonly ok: false; readonly error: ChangeErrorKey };

/** The add form's state: T-034's, plus the reason box of a back-dated add. */
export interface BackDatedAddFormState extends ConnectionFormState {
  /** What was typed in the reason box (kept after an error). */
  readonly reason?: string;
  /** The reason is missing or too short. */
  readonly reasonMissing?: boolean;
}

/** The fewest letters of a reason (the core's `ADJUSTMENT_LIMITS.reasonMin`). */
export const REASON_MIN = 3;
/** The most letters of a reason (the core's `ADJUSTMENT_LIMITS.reasonMax`). */
export const REASON_MAX = 200;

/**
 * The preview input for what is typed so far, or null while the rent or the day is missing or
 * wrong (the VC number does not change the money).
 */
export function previewInputFrom(values: ConnectionFormValues): AddPreviewInput | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.startDate)) return null;
  if (values.rentChoice === "") return null;
  if (values.rentChoice === OWN_AMOUNT) {
    if (!/^[0-9]{1,12}$/.test(values.rentalPaise)) return null;
    const paise = Number(values.rentalPaise);
    if (!Number.isSafeInteger(paise) || paise % 100 !== 0) return null;
    return { rentalPaise: paise, startDate: values.startDate };
  }
  return { planId: values.rentChoice, startDate: values.startDate };
}

/** A preview failure → the message key (`adjustments` namespace `error.*`). */
export function previewErrorKey(error: {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>> | undefined;
}): ChangeErrorKey {
  if (error.code === "VALIDATION" && Array.isArray(error.details?.fields)) {
    for (const field of error.details.fields as { path?: unknown; code?: unknown }[]) {
      if (field.path === "startDate") {
        return field.code === "in_future" || field.code === "too_old" ? field.code : "generic";
      }
      if (field.path === "planId") return field.code === "retired" ? "retired" : "plan_or_amount";
      if (field.path === "rentalPaise") return "amount";
    }
  }
  if (error.code === "FORBIDDEN") return "not_allowed";
  if (error.code === "TENANT_READ_ONLY") return "read_only";
  // NOT_FOUND (a plan of another business, a customer that is gone), CONFLICT (customer closed).
  return "generic";
}
