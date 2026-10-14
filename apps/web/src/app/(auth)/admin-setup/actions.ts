"use server";

/**
 * The platform admin's one-time setup link (T-086d): "Start" shows a new authenticator key,
 * "Turn on and sign in" sets the password and turns on 2-step sign-in with the first code, using
 * up the link. Next.js checks every Server Action's Origin; `@cb/core`'s admin setup service does
 * the rest (link checks, rate limit, single use). `redirect()` is called outside `try`.
 */
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, postSignInPath } from "@cb/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { type AuthFormState, field, formStateFor } from "@/app/(auth)/login/_components/form-state";
import { getAdminSetupService } from "@/lib/auth/server";

/** What the setup form keeps between steps (never the password or the token). */
export interface AdminSetupState extends AuthFormState {
  /** Base32 key to type into the authenticator app. */
  readonly secret?: string;
  /** `otpauth://` link that opens the app. */
  readonly totpUri?: string;
}

function unexpected(event: string, error: unknown): AdminSetupState {
  console.error(event, error instanceof Error ? error.name : typeof error);
  return { error: "unexpected" };
}

export async function startAdminSetupAction(
  _previous: AdminSetupState,
  formData: FormData,
): Promise<AdminSetupState> {
  try {
    const result = await getAdminSetupService().start({
      token: field(formData, "token"),
      headers: await headers(),
    });
    if (!result.ok) return formStateFor(result.error);
    return { secret: result.value.secret, totpUri: result.value.totpUri };
  } catch (error) {
    return unexpected("auth.admin_setup_start_failed", error);
  }
}

export async function finishAdminSetupAction(
  previous: AdminSetupState,
  formData: FormData,
): Promise<AdminSetupState> {
  const keep = { secret: previous.secret, totpUri: previous.totpUri };
  const password = field(formData, "password");
  const confirm = field(formData, "confirm");
  const code = field(formData, "code");
  if (!password || !confirm || !code.trim()) return { ...keep, error: "required" };
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return { ...keep, error: "invalid_password" };
  }
  if (password !== confirm) return { ...keep, error: "passwords_differ" };
  let destination: string;
  try {
    const result = await getAdminSetupService().complete({
      token: field(formData, "token"),
      password,
      code,
      headers: await headers(),
    });
    if (!result.ok) return { ...keep, ...formStateFor(result.error) };
    destination = result.value.signedIn
      ? postSignInPath("platform_admin", undefined)
      : "/login?notice=admin_setup_done";
  } catch (error) {
    return { ...keep, ...unexpected("auth.admin_setup_finish_failed", error) };
  }
  redirect(destination);
}
