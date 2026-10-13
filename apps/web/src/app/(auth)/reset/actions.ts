"use server";

/**
 * Password reset by email (owners and staff, T-026). The request answer never says whether the
 * address has an account; the link is single use and expires after an hour.
 */
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@cb/core";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { type AuthFormState, field, formStateFor } from "@/app/(auth)/login/_components/form-state";
import { getAuthService } from "@/lib/auth/server";

export interface ResetRequestState extends AuthFormState {
  /** True once a request went through (whether or not the address has an account). */
  readonly sent?: boolean;
}

export async function requestResetAction(
  _previous: ResetRequestState,
  formData: FormData,
): Promise<ResetRequestState> {
  const email = field(formData, "email").trim().slice(0, 254);
  if (!email) return { error: "required" };
  try {
    const result = await getAuthService().requestPasswordReset({ email, headers: await headers() });
    if (!result.ok) return formStateFor(result.error);
  } catch (error) {
    console.error(
      "auth.reset_request_action_failed",
      error instanceof Error ? error.name : "unknown",
    );
    return { error: "unexpected" };
  }
  return { sent: true };
}

export async function resetPasswordAction(
  _previous: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const token = field(formData, "token");
  const password = field(formData, "password");
  const confirm = field(formData, "confirm");
  if (!password || !confirm) return { error: "required" };
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    return { error: "invalid_password" };
  }
  if (password !== confirm) return { error: "passwords_differ" };
  try {
    const result = await getAuthService().resetPassword({
      token,
      newPassword: password,
      headers: await headers(),
    });
    if (!result.ok) return formStateFor(result.error);
  } catch (error) {
    console.error("auth.reset_action_failed", error instanceof Error ? error.name : "unknown");
    return { error: "unexpected" };
  }
  redirect("/login?notice=password_changed");
}
