"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import {
  Message,
  PasswordField,
  SubmitButton,
  TextField,
} from "@/app/(auth)/login/_components/fields";
import type { AdminSetupState } from "../actions";

type Action = (state: AdminSetupState, formData: FormData) => Promise<AdminSetupState>;

/**
 * The setup link's two steps (T-086d): (1) Start → a new key for the authenticator app;
 * (2) the new password two times and the first 6-digit code → 2-step sign-in is on, signed in.
 * A used, expired or unknown link shows one sentence and no form.
 */
export function AdminSetupFlow({
  token,
  email,
  start,
  finish,
}: {
  token: string;
  email: string;
  start: Action;
  finish: Action;
}) {
  const t = useTranslations("auth");
  const [started, startAction] = useActionState(start, {});
  const [finished, finishAction] = useActionState(finish, {});
  const key = finished.secret ? finished : started;
  const deadLink = started.error === "invalid_token" || finished.error === "invalid_token";
  const errorOf = (state: AdminSetupState) =>
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error
        ? t(`error.${state.error}`)
        : null;

  if (deadLink) {
    return (
      <div data-admin-setup="invalid">
        <Message tone="danger">{t("admin_setup.invalid")}</Message>
      </div>
    );
  }

  const account = (
    <div className="flex flex-col gap-1">
      <p className="text-sm text-text-muted">{t("admin_setup.account_label")}</p>
      <p className="break-all text-lg" data-testid="admin-setup-account">
        {email}
      </p>
    </div>
  );

  if (!key.secret) {
    const error = errorOf(started);
    return (
      <form action={startAction} className="flex flex-col gap-5" noValidate>
        {account}
        {error ? <Message tone="danger">{error}</Message> : null}
        <p>{t("admin_setup.start_intro")}</p>
        <input type="hidden" name="token" value={token} />
        <SubmitButton
          icon="next"
          label={t("admin_setup.start")}
          pendingLabel={t("admin_setup.starting")}
        />
      </form>
    );
  }

  const error = errorOf(finished);
  return (
    <form action={finishAction} className="flex flex-col gap-5" noValidate>
      {account}
      <p>{t("two_factor_setup.add_key")}</p>
      <div className="flex flex-col gap-2 rounded-md border-hairline border-border p-3">
        <p className="text-sm text-text-muted">{t("two_factor_setup.key_label")}</p>
        <p className="break-all font-numeric text-lg" data-testid="totp-secret">
          {key.secret}
        </p>
        {key.totpUri ? (
          <a href={key.totpUri} className="min-h-touch-min py-2 text-accent underline">
            {t("two_factor_setup.open_in_app")}
          </a>
        ) : null}
      </div>
      {error ? <Message tone="danger">{error}</Message> : null}
      <input type="hidden" name="token" value={token} />
      <PasswordField
        id="password"
        name="password"
        label={t("admin_setup.password_label")}
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        required
        invalid={finished.error === "invalid_password" || finished.error === "required"}
      />
      <PasswordField
        id="confirm"
        name="confirm"
        label={t("admin_setup.confirm_label")}
        autoComplete="new-password"
        minLength={8}
        maxLength={128}
        required
        invalid={finished.error === "passwords_differ"}
      />
      <TextField
        id="code"
        name="code"
        label={t("two_factor_setup.code_label")}
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        required
        className="font-numeric text-2xl"
        invalid={finished.error === "invalid_code"}
      />
      <SubmitButton
        icon="success"
        label={t("admin_setup.submit")}
        pendingLabel={t("admin_setup.submitting")}
      />
    </form>
  );
}
