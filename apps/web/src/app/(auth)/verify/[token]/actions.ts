"use server";

/**
 * Confirming a sign-up (T-027): the link's token + the password chosen at sign-up → the tenant is
 * provisioned (idempotent: a second tab or a retry gets the same tenant) → the owner is signed in
 * with the same password (T-026 sign-in: session gate, cookie, audit) → /home.
 * `redirect()` is called outside `try` (it works by throwing).
 */
import { LOGIN_PATH, postSignInPath } from "@cb/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { field } from "@/app/(auth)/login/_components/form-state";
import { getAuthService, getSignupService } from "@/lib/auth/server";

export interface VerifyFormState {
  readonly error?:
    | "wrong_password"
    | "account_exists"
    | "invalid_link"
    | "rate_limited"
    | "required"
    | "unexpected";
  /** For `rate_limited`: whole minutes to wait (at least 1). */
  readonly minutes?: number;
}

export async function verifySignupAction(
  _previous: VerifyFormState,
  formData: FormData,
): Promise<VerifyFormState> {
  const token = field(formData, "token");
  const password = field(formData, "password");
  if (!password) return { error: "required" };
  let destination: string;
  try {
    const requestHeaders = await headers();
    const result = await getSignupService().complete({ token, password, headers: requestHeaders });
    if (!result.ok) {
      switch (result.error.code) {
        case "WRONG_PASSWORD":
          return { error: "wrong_password" };
        case "ACCOUNT_EXISTS":
          return { error: "account_exists" };
        case "INVALID_LINK":
          return { error: "invalid_link" };
        case "RATE_LIMITED":
          return {
            error: "rate_limited",
            minutes: Math.max(1, Math.ceil(result.error.retryAfterSeconds / 60)),
          };
        default:
          return { error: "unexpected" };
      }
    }
    const signedIn = await getAuthService().signIn({
      login: result.value.email,
      password,
      headers: requestHeaders,
    });
    // The tenant exists either way; if signing in fails (e.g. too many tries), sign in by hand.
    destination =
      signedIn.ok && signedIn.value.status === "signed_in"
        ? postSignInPath(signedIn.value.role, undefined)
        : LOGIN_PATH;
  } catch (error) {
    console.error("signup.verify_action_failed", error instanceof Error ? error.name : "unknown");
    return { error: "unexpected" };
  }
  redirect(destination);
}
