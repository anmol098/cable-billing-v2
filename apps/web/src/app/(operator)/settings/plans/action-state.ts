/**
 * What the plan Server Actions return (T-031), and the mapping from a service error to the words
 * the page shows. Pure: used by the actions, the client list and the tests.
 */

/** Largest monthly rent of a plan, in paise (₹1,00,000; `PLAN_AMOUNT_MAX_PAISE` in @cb/core). */
export const MAX_PLAN_PAISE = 10_000_000;

/** `plans.error.*` keys. */
export type PlanErrorKey =
  | "required"
  | "too_long"
  | "bad_characters"
  | "amount_required"
  | "amount_invalid"
  | "name_taken"
  | "name_taken_show"
  | "not_found"
  | "not_owner"
  | "tenant_read_only"
  | "unexpected";

/** Which box of the plan dialog an error belongs to (`null`: the whole action). */
export function planErrorField(error: PlanErrorKey): "name" | "amount" | null {
  switch (error) {
    case "required":
    case "too_long":
    case "bad_characters":
    case "name_taken":
      return "name";
    case "amount_required":
    case "amount_invalid":
      return "amount";
    default:
      return null;
  }
}

export type PlanActionResult =
  /** `changed: false`: the values were the same, nothing was saved. */
  | { readonly ok: true; readonly changed?: boolean }
  | { readonly ok: false; readonly error: PlanErrorKey };

/** A service error, as the Server Action sees it. */
export interface PlanServiceError {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * A failed plan service call → the words to show. `showing`: the call was "Show again", where a
 * name clash means an active plan took the name meanwhile.
 */
export function planErrorKey(error: PlanServiceError, showing = false): PlanErrorKey {
  switch (error.code) {
    case "VALIDATION": {
      const fields = Array.isArray(error.details?.fields) ? error.details.fields : [];
      const first = fields[0] as { path?: unknown; code?: unknown } | undefined;
      if (first?.path === "monthlyAmountPaise") return "amount_invalid";
      if (first?.path !== "name") return "unexpected";
      if (first.code === "too_small") return "required";
      if (first.code === "too_big") return "too_long";
      return "bad_characters";
    }
    case "CONFLICT":
      // `name_taken` from the service, or the unique index when two saves race.
      return showing ? "name_taken_show" : "name_taken";
    case "NOT_FOUND":
      return "not_found";
    case "FORBIDDEN":
      return "not_owner";
    case "TENANT_READ_ONLY":
      return "tenant_read_only";
    default:
      return "unexpected";
  }
}
