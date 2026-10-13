/**
 * What the business profile Server Action returns to its form (T-030), and the mapping from a
 * service error to the words the form shows. Pure: no server imports, so the client form and the
 * tests can use it.
 */

/** The form's field names (= the `operators.update_profile` input keys). */
export const PROFILE_FIELDS = [
  "name",
  "phone",
  "address",
  "receiptFooter",
  "invoicePrefix",
  "defaultLanguage",
  "midMonthStartPolicy",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

/** `settings.profile.error.*` keys shown under a field. */
export type ProfileFieldErrorKey =
  | "required"
  | "too_long"
  | "bad_characters"
  | "phone_invalid"
  | "prefix_invalid"
  | "choose_one";

/** `settings.profile.error.*` keys shown at the top of the form. */
export type ProfileFormErrorKey = "fix_fields" | "not_owner" | "tenant_read_only" | "unexpected";

/** The typed values, sent back so the form keeps them after an error. */
export type ProfileValues = Readonly<Record<ProfileField, string>>;

export interface ProfileFormState {
  /** Saved: how many fields changed (0: "Nothing changed"). Changes on every save. */
  readonly saved?: {
    readonly changed: number;
    readonly at: number;
    /** The values as stored (tidied: spaces, capitals), to show in the form. */
    readonly values: ProfileValues;
  };
  readonly error?: ProfileFormErrorKey;
  readonly fields?: Partial<Record<ProfileField, ProfileFieldErrorKey>>;
  readonly values?: ProfileValues;
}

/** The stored profile → the form's text values (`null` → ""). */
export function profileValuesOf(profile: {
  readonly name: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly receiptFooter: string | null;
  readonly invoicePrefix: string;
  readonly defaultLanguage: string;
  readonly midMonthStartPolicy: string;
}): ProfileValues {
  return {
    name: profile.name,
    phone: profile.phone ?? "",
    address: profile.address ?? "",
    receiptFooter: profile.receiptFooter ?? "",
    invoicePrefix: profile.invoicePrefix,
    defaultLanguage: profile.defaultLanguage,
    midMonthStartPolicy: profile.midMonthStartPolicy,
  };
}

/** A service error, as the Server Action sees it (code + optional field issues). */
export interface ProfileServiceError {
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

function isProfileField(value: unknown): value is ProfileField {
  return typeof value === "string" && (PROFILE_FIELDS as readonly string[]).includes(value);
}

/** One Zod issue (path + code from `validationError`) → the words under that field. */
export function fieldErrorKey(field: ProfileField, code: string): ProfileFieldErrorKey {
  if (field === "defaultLanguage" || field === "midMonthStartPolicy") return "choose_one";
  if (code === "too_small") return "required";
  if (code === "too_big") return "too_long";
  if (code === "custom") return "bad_characters";
  if (field === "phone") return "phone_invalid";
  if (field === "invoicePrefix") return "prefix_invalid";
  return "bad_characters";
}

/** A failed `operators.update_profile` call → what the form shows. */
export function profileFormStateFor(
  error: ProfileServiceError,
  values: ProfileValues,
): ProfileFormState {
  switch (error.code) {
    case "VALIDATION": {
      const fields: Partial<Record<ProfileField, ProfileFieldErrorKey>> = {};
      const issues = Array.isArray(error.details?.fields) ? error.details.fields : [];
      for (const issue of issues as { path?: unknown; code?: unknown }[]) {
        const field = typeof issue.path === "string" ? issue.path.split(".")[0] : undefined;
        // The first problem of a field is the one to fix first.
        if (isProfileField(field) && fields[field] === undefined) {
          fields[field] = fieldErrorKey(field, String(issue.code ?? ""));
        }
      }
      return { error: "fix_fields", fields, values };
    }
    case "FORBIDDEN":
      return { error: "not_owner", values };
    case "TENANT_READ_ONLY":
      return { error: "tenant_read_only", values };
    default:
      return { error: "unexpected", values };
  }
}
