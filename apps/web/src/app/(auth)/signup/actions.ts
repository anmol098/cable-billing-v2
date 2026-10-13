"use server";

/**
 * Self sign-up Server Action (T-027). Next.js checks the Origin of every Server Action (CSRF);
 * the sign-up service does the rest (field checks, rate limits, Turnstile, the pending sign-up and
 * the email). The answer never says whether the email already has an account.
 */
import { TURNSTILE_RESPONSE_FIELD } from "@cb/core";
import { headers } from "next/headers";
import { getLocale } from "next-intl/server";
import { field } from "@/app/(auth)/login/_components/form-state";
import { resolveLocale } from "@/i18n/config";
import { getSignupService } from "@/lib/auth/server";
import { type SignupFormState, type SignupValues, signupFormStateFor } from "./form-state";

export async function signUpAction(
  previous: SignupFormState,
  formData: FormData,
): Promise<SignupFormState> {
  const attempt = (previous.attempt ?? 0) + 1;
  const values: SignupValues = {
    business_name: field(formData, "business_name").slice(0, 200),
    owner_name: field(formData, "owner_name").slice(0, 200),
    mobile: field(formData, "mobile").slice(0, 30),
    email: field(formData, "email").slice(0, 300),
  };
  try {
    const result = await getSignupService().start({
      businessName: values.business_name,
      ownerName: values.owner_name,
      mobile: values.mobile,
      email: values.email,
      password: field(formData, "password"),
      language: resolveLocale(await getLocale()),
      botToken: field(formData, TURNSTILE_RESPONSE_FIELD),
      headers: await headers(),
    });
    if (!result.ok) return signupFormStateFor(result.error, values, attempt);
  } catch (error) {
    console.error("signup.action_failed", error instanceof Error ? error.name : typeof error);
    return { error: "unexpected", values, attempt };
  }
  return { sent: true, values: { ...values, email: values.email.trim().toLowerCase() }, attempt };
}
