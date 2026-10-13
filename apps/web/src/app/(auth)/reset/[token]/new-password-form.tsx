"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Message, PasswordField, SubmitButton } from "@/app/(auth)/login/_components/fields";
import type { AuthFormState } from "@/app/(auth)/login/_components/form-state";

type Action = (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;

/** Set a new password from a reset link: the password two times, then Save. */
export function NewPasswordForm({ action, token }: { action: Action; token: string }) {
  const t = useTranslations("auth");
  const [state, formAction] = useActionState(action, {});
  const errorText =
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error
        ? t(`error.${state.error}`)
        : null;
  const badLink = state.error === "invalid_token";
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {errorText ? <Message tone="danger">{errorText}</Message> : null}
      {badLink ? (
        <Link href="/reset" className="min-h-touch-min py-2 text-base text-accent underline">
          {t("reset.title")}
        </Link>
      ) : (
        <>
          <input type="hidden" name="token" value={token} />
          <PasswordField
            id="password"
            name="password"
            label={t("reset_new.password_label")}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            invalid={state.error === "invalid_password" || state.error === "required"}
          />
          <PasswordField
            id="confirm"
            name="confirm"
            label={t("reset_new.confirm_label")}
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
            invalid={state.error === "passwords_differ"}
          />
          <SubmitButton
            icon="success"
            label={t("reset_new.submit")}
            pendingLabel={t("reset_new.submitting")}
          />
        </>
      )}
    </form>
  );
}
