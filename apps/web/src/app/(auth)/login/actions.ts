"use server";

/**
 * Sign-in Server Actions (T-026). Next.js checks the Origin of every Server Action (CSRF); the
 * auth service does the rest (rate limits, role/status gate, cookies via `nextCookies()`).
 * `redirect()` is called outside `try` (it works by throwing).
 */
import { postSignInPath, TWO_FACTOR_SETUP_PATH, TWO_FACTOR_VERIFY_PATH } from "@cb/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getAuthService } from "@/lib/auth/server";
import { type AuthFormState, field, formStateFor } from "./_components/form-state";

const UNEXPECTED: AuthFormState = { error: "unexpected" };

/** Logs the failure (no input values) and tells the user to try again. */
function unexpected(event: string, error: unknown): AuthFormState {
  console.error(event, error instanceof Error ? error.name : typeof error);
  return UNEXPECTED;
}

export async function signInAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const login = field(formData, "login").trim().slice(0, 254);
  const password = field(formData, "password");
  const next = field(formData, "next");
  if (!login || !password) return { error: "required", login };
  let destination: string;
  try {
    const result = await getAuthService().signIn({ login, password, headers: await headers() });
    if (!result.ok) return formStateFor(result.error, { login });
    const outcome = result.value;
    if (outcome.status === "two_factor_required") {
      destination = next
        ? `${TWO_FACTOR_VERIFY_PATH}?${new URLSearchParams({ next })}`
        : TWO_FACTOR_VERIFY_PATH;
    } else if (outcome.twoFactorEnrolmentRequired) {
      destination = TWO_FACTOR_SETUP_PATH;
    } else {
      destination = postSignInPath(outcome.role, next);
    }
  } catch (error) {
    return { ...unexpected("auth.sign_in_action_failed", error), login };
  }
  redirect(destination);
}

export async function verifyTwoFactorAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const code = field(formData, "code");
  if (!code.trim()) return { error: "required" };
  let destination: string;
  try {
    const result = await getAuthService().verifyTwoFactor({ code, headers: await headers() });
    if (!result.ok) return formStateFor(result.error);
    destination = postSignInPath(result.value.role, field(formData, "next"));
  } catch (error) {
    return unexpected("auth.two_factor_action_failed", error);
  }
  redirect(destination);
}

/** Step 1 of TOTP enrolment: the password again → the key and backup codes (shown once). */
export interface EnrolmentState extends AuthFormState {
  readonly secret?: string;
  readonly totpUri?: string;
  readonly backupCodes?: readonly string[];
}

export async function startEnrolmentAction(
  _previous: EnrolmentState,
  formData: FormData,
): Promise<EnrolmentState> {
  const password = field(formData, "password");
  if (!password) return { error: "required" };
  try {
    const result = await getAuthService().startTwoFactorEnrolment({
      password,
      headers: await headers(),
    });
    if (!result.ok) return formStateFor(result.error);
    return {
      secret: result.value.secret,
      totpUri: result.value.totpUri,
      backupCodes: result.value.backupCodes,
    };
  } catch (error) {
    return unexpected("auth.enrolment_start_failed", error);
  }
}

/** Step 2: a first code from the app turns 2FA on; then on to /admin. */
export async function confirmEnrolmentAction(
  previous: EnrolmentState,
  formData: FormData,
): Promise<EnrolmentState> {
  const code = field(formData, "code");
  if (!code.trim()) return { ...previous, error: "required" };
  let destination: string;
  try {
    const result = await getAuthService().confirmTwoFactorEnrolment({
      code,
      headers: await headers(),
    });
    if (!result.ok) return { ...previous, ...formStateFor(result.error) };
    destination = postSignInPath(result.value.role, undefined);
  } catch (error) {
    return { ...previous, ...unexpected("auth.enrolment_confirm_failed", error) };
  }
  redirect(destination);
}
