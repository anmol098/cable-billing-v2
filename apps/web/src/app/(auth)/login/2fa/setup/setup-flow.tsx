"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Message, PasswordField, SubmitButton, TextField } from "../../_components/fields";
import type { EnrolmentState } from "../../actions";

type Action = (state: EnrolmentState, formData: FormData) => Promise<EnrolmentState>;

/**
 * TOTP enrolment in two steps: (1) the password again → (2) the key to add to an authenticator
 * app, the backup codes (shown once), and a first code to turn 2FA on.
 */
export function SetupFlow({ start, confirm }: { start: Action; confirm: Action }) {
  const t = useTranslations("auth");
  const [started, startAction] = useActionState(start, {});
  const [confirmed, confirmAction] = useActionState(confirm, {});
  const enrolment = confirmed.secret ? confirmed : started;
  const errorOf = (state: EnrolmentState) =>
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error
        ? t(`error.${state.error}`)
        : null;

  if (!enrolment.secret) {
    const error = errorOf(started);
    return (
      <form action={startAction} className="flex flex-col gap-5" noValidate>
        {error ? <Message tone="danger">{error}</Message> : null}
        <PasswordField
          id="password"
          name="password"
          label={t("two_factor_setup.password_label")}
          autoComplete="current-password"
          required
          invalid={Boolean(started.error)}
        />
        <SubmitButton
          icon="next"
          label={t("two_factor_setup.start")}
          pendingLabel={t("two_factor_setup.starting")}
        />
      </form>
    );
  }

  const error = errorOf(confirmed);
  return (
    <form action={confirmAction} className="flex flex-col gap-5" noValidate>
      <p>{t("two_factor_setup.add_key")}</p>
      <div className="flex flex-col gap-2 rounded-md border-hairline border-border p-3">
        <p className="text-sm text-text-muted">{t("two_factor_setup.key_label")}</p>
        <p className="break-all font-numeric text-lg" data-testid="totp-secret">
          {enrolment.secret}
        </p>
        {enrolment.totpUri ? (
          <a href={enrolment.totpUri} className="min-h-touch-min py-2 text-accent underline">
            {t("two_factor_setup.open_in_app")}
          </a>
        ) : null}
      </div>
      {enrolment.backupCodes && enrolment.backupCodes.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h2 className="font-strong text-lg">{t("two_factor_setup.backup_title")}</h2>
          <p className="text-text-muted">{t("two_factor_setup.backup_description")}</p>
          <ul className="grid grid-cols-2 gap-2 font-numeric">
            {enrolment.backupCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <Message tone="danger">{error}</Message> : null}
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
        invalid={Boolean(confirmed.error)}
      />
      <SubmitButton
        icon="success"
        label={t("two_factor_setup.confirm")}
        pendingLabel={t("two_factor_setup.confirming")}
      />
    </form>
  );
}
