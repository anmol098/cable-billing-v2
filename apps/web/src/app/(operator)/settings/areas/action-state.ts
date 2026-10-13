/**
 * What the area Server Actions return (T-030), and the mapping from a service error to the words
 * the page shows. Pure: used by the actions, the client list and the tests.
 */

/** `settings.areas.error.*` keys. */
export type AreaErrorKey =
  | "required"
  | "too_long"
  | "bad_characters"
  | "name_taken"
  | "name_taken_hidden"
  | "not_found"
  | "not_owner"
  | "tenant_read_only"
  | "unexpected";

export type AreaActionResult = { readonly ok: true } | { readonly ok: false; error: AreaErrorKey };

/** A service error, as the Server Action sees it. */
export interface AreaServiceError {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** A failed area service call → the words to show. */
export function areaErrorKey(error: AreaServiceError): AreaErrorKey {
  switch (error.code) {
    case "VALIDATION": {
      const fields = Array.isArray(error.details?.fields) ? error.details.fields : [];
      const first = fields[0] as { path?: unknown; code?: unknown } | undefined;
      if (first?.path !== "name") return "unexpected";
      if (first.code === "too_small") return "required";
      if (first.code === "too_big") return "too_long";
      return "bad_characters";
    }
    case "CONFLICT":
      // `name_taken` from the service, or the unique index when two saves race.
      return error.details?.archived === true ? "name_taken_hidden" : "name_taken";
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
