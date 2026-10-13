import type { SignupFailure, SignupField, SignupFieldProblem } from "@cb/core";

/** The `signup.error.*` keys a field can show. */
export type SignupFieldErrorKey =
  | "required"
  | "too_long"
  | "mobile_invalid"
  | "email_invalid"
  | "password_too_short"
  | "password_too_long";

/** The `signup.error.*` keys shown at the top of the form. */
export type SignupFormErrorKey =
  | "fix_fields"
  | "rate_limited"
  | "person_check_failed"
  | "email_failed"
  | "unexpected";

/** What the typed fields were (to keep them after an error). Never the password. */
export interface SignupValues {
  readonly business_name: string;
  readonly owner_name: string;
  readonly mobile: string;
  readonly email: string;
}

/** What the sign-up Server Action returns to its form. */
export interface SignupFormState {
  /** The link was emailed: show "check your email". */
  readonly sent?: boolean;
  readonly error?: SignupFormErrorKey;
  /** For `rate_limited`: whole minutes to wait (at least 1). */
  readonly minutes?: number;
  readonly fields?: Partial<Record<SignupField, SignupFieldErrorKey>>;
  readonly values?: SignupValues;
  /** Changes on every answer, so the person check gets a fresh token (each works once). */
  readonly attempt?: number;
}

function fieldErrorKey(field: SignupField, problem: SignupFieldProblem): SignupFieldErrorKey {
  if (problem === "required") return "required";
  if (field === "mobile") return "mobile_invalid";
  if (field === "email") return "email_invalid";
  if (field === "password")
    return problem === "too_long" ? "password_too_long" : "password_too_short";
  return "too_long";
}

/** A sign-up failure → what the form shows. */
export function signupFormStateFor(
  failure: SignupFailure,
  values: SignupValues,
  attempt: number,
): SignupFormState {
  switch (failure.code) {
    case "VALIDATION": {
      const fields: Partial<Record<SignupField, SignupFieldErrorKey>> = {};
      for (const [field, problem] of Object.entries(failure.fields) as [
        SignupField,
        SignupFieldProblem,
      ][]) {
        fields[field] = fieldErrorKey(field, problem);
      }
      return { error: "fix_fields", fields, values, attempt };
    }
    case "RATE_LIMITED":
      return {
        error: "rate_limited",
        minutes: Math.max(1, Math.ceil(failure.retryAfterSeconds / 60)),
        values,
        attempt,
      };
    case "BOT_CHECK_FAILED":
      return { error: "person_check_failed", values, attempt };
    case "EMAIL_FAILED":
      return { error: "email_failed", values, attempt };
    default:
      return { error: "unexpected", values, attempt };
  }
}
