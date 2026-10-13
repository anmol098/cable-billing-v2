"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Message, PasswordField, SubmitButton, TextField } from "./_components/fields";
import type { AuthFormState } from "./_components/form-state";

type Action = (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;

/**
 * Login: one field for "mobile no., user name or email", the password with Show/Hide, one big
 * Sign in button. Works without client JavaScript (plain form post to the Server Action).
 */
export function LoginForm({ action, next }: { action: Action; next?: string }) {
  const t = useTranslations("auth");
  const [state, formAction] = useActionState(action, {});
  const errorText =
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error
        ? t(`error.${state.error}`)
        : null;
  const credentialsWrong = state.error === "invalid_credentials" || state.error === "required";
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {errorText ? <Message tone="danger">{errorText}</Message> : null}
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <TextField
        id="login"
        name="login"
        label={t("login.login_label")}
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        defaultValue={state.login ?? ""}
        invalid={credentialsWrong}
      />
      <PasswordField
        id="password"
        name="password"
        label={t("login.password_label")}
        autoComplete="current-password"
        required
        invalid={credentialsWrong}
      />
      <SubmitButton icon="next" label={t("login.submit")} pendingLabel={t("login.submitting")} />
      <Link href="/reset" className="min-h-touch-min py-2 text-base text-accent underline">
        {t("login.forgot_password")}
      </Link>
      <p className="text-sm text-text-muted">{t("login.lineman_hint")}</p>
    </form>
  );
}
