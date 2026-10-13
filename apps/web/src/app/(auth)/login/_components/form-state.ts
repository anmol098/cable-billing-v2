import type { AuthFailure } from "@cb/core";

/** The `auth.error.*` message keys a form can show. */
export type AuthErrorKey =
  | "invalid_credentials"
  | "rate_limited"
  | "role_not_allowed"
  | "account_disabled"
  | "invalid_code"
  | "two_factor_expired"
  | "invalid_token"
  | "invalid_password"
  | "passwords_differ"
  | "required"
  | "unexpected";

/** What a sign-in / reset form action returns to its form (never a password or a token). */
export interface AuthFormState {
  readonly error?: AuthErrorKey;
  /** For `rate_limited`: whole minutes to wait (at least 1). */
  readonly minutes?: number;
  /** The login typed, to keep it in the field after an error. */
  readonly login?: string;
}

const ERROR_KEYS: Record<AuthFailure["code"], AuthErrorKey> = {
  INVALID_CREDENTIALS: "invalid_credentials",
  RATE_LIMITED: "rate_limited",
  ROLE_NOT_ALLOWED: "role_not_allowed",
  ACCOUNT_DISABLED: "account_disabled",
  INVALID_CODE: "invalid_code",
  TWO_FACTOR_EXPIRED: "two_factor_expired",
  INVALID_TOKEN: "invalid_token",
  INVALID_PASSWORD: "invalid_password",
  UNAUTHENTICATED: "two_factor_expired",
};

/** An auth failure → the form's error (plus the wait time for rate limits). */
export function formStateFor(
  failure: AuthFailure,
  extra: Partial<AuthFormState> = {},
): AuthFormState {
  const error = ERROR_KEYS[failure.code];
  if (error !== "rate_limited") return { ...extra, error };
  const minutes = Math.max(1, Math.ceil((failure.retryAfterSeconds ?? 60) / 60));
  return { ...extra, error, minutes };
}

/** A form field as trimmed text ("" when missing or not text). */
export function field(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
