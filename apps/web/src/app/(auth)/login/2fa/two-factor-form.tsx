"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Message, SubmitButton, TextField } from "../_components/fields";
import type { AuthFormState } from "../_components/form-state";

type Action = (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;

/** The 6-digit code from the authenticator app (platform admins, after the password). */
export function TwoFactorForm({ action, next }: { action: Action; next?: string }) {
  const t = useTranslations("auth");
  const [state, formAction] = useActionState(action, {});
  const expired = state.error === "two_factor_expired";
  const errorText =
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error
        ? t(`error.${state.error}`)
        : null;
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {errorText ? <Message tone="danger">{errorText}</Message> : null}
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {expired ? null : (
        <>
          <TextField
            id="code"
            name="code"
            label={t("two_factor.code_label")}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            required
            className="font-numeric text-2xl"
            invalid={state.error === "invalid_code"}
          />
          <SubmitButton
            icon="success"
            label={t("two_factor.submit")}
            pendingLabel={t("two_factor.submitting")}
          />
        </>
      )}
      <Link href="/login" className="min-h-touch-min py-2 text-base text-accent underline">
        {t("two_factor.back")}
      </Link>
    </form>
  );
}
