"use client";

import { useTranslations } from "next-intl";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  Message,
  PasswordField,
  SubmitButton,
  TextField,
} from "@/app/(auth)/login/_components/fields";
import type { AdminSetupState } from "./actions";

type Action = (state: AdminSetupState, formData: FormData) => Promise<AdminSetupState>;
type Check = (token: string) => Promise<{ readonly email: string } | null>;
type Link =
  | { readonly kind: "checking" }
  | { readonly kind: "invalid" }
  | { readonly kind: "ready"; readonly token: string; readonly email: string };

/**
 * The setup link's steps (T-086d). The token comes from the URL fragment (`#…`, never sent to the
 * server); it is taken out of the address bar at once and sent only in Server Action bodies.
 * (1) the link is checked; (2) Start → a new key for the authenticator app; (3) the new password
 * two times and the first 6-digit code → 2-step sign-in is on, signed in. A used, expired or
 * unknown link shows one sentence and no form. If the key was replaced elsewhere, Start again.
 */
export function AdminSetupFlow({
  check,
  start,
  finish,
  passwordMinLength,
  passwordMaxLength,
}: {
  check: Check;
  start: Action;
  finish: Action;
  passwordMinLength: number;
  passwordMaxLength: number;
}) {
  const t = useTranslations("auth");
  const [link, setLink] = useState<Link>({ kind: "checking" });
  const token = useRef<string | null>(null);
  const [started, startAction] = useActionState(start, {});
  const [finished, finishAction] = useActionState(finish, {});

  useEffect(() => {
    if (token.current === null) {
      token.current = window.location.hash.replace(/^#/, "");
      if (window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
    const value = token.current;
    if (!value) {
      setLink({ kind: "invalid" });
      return;
    }
    let live = true;
    check(value).then(
      (result) => {
        if (live)
          setLink(
            result ? { kind: "ready", token: value, email: result.email } : { kind: "invalid" },
          );
      },
      () => {
        if (live) setLink({ kind: "invalid" });
      },
    );
    return () => {
      live = false;
    };
  }, [check]);

  const errorOf = (state: AdminSetupState) =>
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error
        ? t(`error.${state.error}`)
        : null;

  if (link.kind === "checking") {
    return (
      <p role="status" className="text-text-muted">
        {t("admin_setup.starting")}
      </p>
    );
  }
  const deadLink =
    link.kind === "invalid" ||
    started.error === "invalid_token" ||
    finished.error === "invalid_token";
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
        {link.email}
      </p>
    </div>
  );
  // An answer about this key (an older key's answers no longer apply after a new Start).
  const current = started.keyId !== undefined && finished.keyId === started.keyId;
  const keyChanged = current && finished.error === "setup_key_changed";

  if (!started.secret || keyChanged) {
    const error = keyChanged ? t("error.setup_key_changed") : errorOf(started);
    return (
      <form action={startAction} className="flex flex-col gap-5" noValidate>
        {account}
        {error ? <Message tone="danger">{error}</Message> : null}
        <p>{t("admin_setup.start_intro")}</p>
        <input type="hidden" name="token" value={link.token} />
        <SubmitButton
          icon="next"
          label={t("admin_setup.start")}
          pendingLabel={t("admin_setup.starting")}
        />
      </form>
    );
  }

  const error = current ? errorOf(finished) : null;
  return (
    <form action={finishAction} className="flex flex-col gap-5" noValidate>
      {account}
      <p>{t("two_factor_setup.add_key")}</p>
      <div className="flex flex-col gap-2 rounded-md border-hairline border-border p-3">
        <p className="text-sm text-text-muted">{t("two_factor_setup.key_label")}</p>
        <p className="break-all font-numeric text-lg" data-testid="totp-secret">
          {started.secret}
        </p>
        {started.totpUri ? (
          <a href={started.totpUri} className="min-h-touch-min py-2 text-accent underline">
            {t("two_factor_setup.open_in_app")}
          </a>
        ) : null}
      </div>
      {error ? <Message tone="danger">{error}</Message> : null}
      <input type="hidden" name="token" value={link.token} />
      <input type="hidden" name="keyId" value={started.keyId ?? ""} />
      <PasswordField
        id="password"
        name="password"
        label={t("admin_setup.password_label")}
        autoComplete="new-password"
        minLength={passwordMinLength}
        maxLength={passwordMaxLength}
        required
        invalid={
          current && (finished.error === "invalid_password" || finished.error === "required")
        }
      />
      <PasswordField
        id="confirm"
        name="confirm"
        label={t("admin_setup.confirm_label")}
        autoComplete="new-password"
        minLength={passwordMinLength}
        maxLength={passwordMaxLength}
        required
        invalid={current && finished.error === "passwords_differ"}
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
        invalid={current && finished.error === "invalid_code"}
      />
      <SubmitButton
        icon="success"
        label={t("admin_setup.submit")}
        pendingLabel={t("admin_setup.submitting")}
      />
    </form>
  );
}
