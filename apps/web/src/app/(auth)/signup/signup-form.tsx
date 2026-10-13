"use client";

import { Icon } from "@cb/ui";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { type ReactNode, useActionState } from "react";
import {
  Message,
  PasswordField,
  SubmitButton,
  TextField,
} from "@/app/(auth)/login/_components/fields";
import type { SignupFieldErrorKey, SignupFormState } from "./form-state";
import { TurnstileWidget } from "./turnstile-widget";

type Action = (state: SignupFormState, formData: FormData) => Promise<SignupFormState>;

/** The hint under a field, or what is wrong with it (icon + colour + words). */
function FieldNote({ id, hint, error }: { id: string; hint?: string; error?: string | null }) {
  if (error) {
    return (
      <p id={id} className="flex items-start gap-2 text-base text-danger">
        <Icon name="danger" className="mt-1 shrink-0" />
        <span>{error}</span>
      </p>
    );
  }
  if (!hint) return null;
  return (
    <p id={id} className="text-sm text-text-muted">
      {hint}
    </p>
  );
}

function Field({
  id,
  hint,
  error,
  children,
}: {
  id: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {children}
      <FieldNote id={`${id}-note`} {...(hint ? { hint } : {})} error={error ?? null} />
    </div>
  );
}

/**
 * Sign-up (PLAN §12.3): business name, your name, mobile no., email, password, the person check,
 * one big button. After it: "check your email" (one job per screen). Works without client
 * JavaScript except the person check, which needs Cloudflare's script when it is switched on.
 */
export function SignupForm({ action, siteKey }: { action: Action; siteKey?: string }) {
  const t = useTranslations("signup");
  const locale = useLocale();
  const [state, formAction] = useActionState(action, {});

  if (state.sent) {
    return (
      <div className="flex flex-col gap-5">
        <Message tone="success">
          <span className="font-strong">{t("sent.title")}. </span>
          {t("sent.body", { email: state.values?.email ?? "" })}
        </Message>
        <p className="text-base text-text-muted">{t("sent.not_there")}</p>
        <Link href="/signup" className="min-h-touch-min py-2 text-base text-accent underline">
          {t("sent.different_email")}
        </Link>
      </div>
    );
  }

  const fieldError = (key: SignupFieldErrorKey | undefined) => (key ? t(`error.${key}`) : null);
  const errorText =
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error
        ? t(`error.${state.error}`)
        : null;
  const fields = state.fields ?? {};
  const values = state.values;
  const described = (id: string, hasNote: boolean) =>
    hasNote ? { "aria-describedby": `${id}-note` } : {};

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {errorText ? <Message tone="danger">{errorText}</Message> : null}
      <Field
        id="business_name"
        hint={t("form.business_name_hint")}
        error={fieldError(fields.business_name)}
      >
        <TextField
          id="business_name"
          name="business_name"
          label={t("form.business_name_label")}
          autoComplete="organization"
          required
          maxLength={120}
          defaultValue={values?.business_name ?? ""}
          invalid={Boolean(fields.business_name)}
          {...described("business_name", true)}
        />
      </Field>
      <Field id="owner_name" error={fieldError(fields.owner_name)}>
        <TextField
          id="owner_name"
          name="owner_name"
          label={t("form.owner_name_label")}
          autoComplete="name"
          required
          maxLength={120}
          defaultValue={values?.owner_name ?? ""}
          invalid={Boolean(fields.owner_name)}
          {...described("owner_name", Boolean(fields.owner_name))}
        />
      </Field>
      <Field id="mobile" hint={t("form.mobile_hint")} error={fieldError(fields.mobile)}>
        <TextField
          id="mobile"
          name="mobile"
          type="tel"
          inputMode="tel"
          label={t("form.mobile_label")}
          autoComplete="tel-national"
          required
          maxLength={20}
          defaultValue={values?.mobile ?? ""}
          invalid={Boolean(fields.mobile)}
          className="font-numeric text-lg"
          {...described("mobile", true)}
        />
      </Field>
      <Field id="email" hint={t("form.email_hint")} error={fieldError(fields.email)}>
        <TextField
          id="email"
          name="email"
          type="email"
          inputMode="email"
          label={t("form.email_label")}
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          maxLength={254}
          defaultValue={values?.email ?? ""}
          invalid={Boolean(fields.email)}
          {...described("email", true)}
        />
      </Field>
      <Field id="password" hint={t("form.password_hint")} error={fieldError(fields.password)}>
        <PasswordField
          id="password"
          name="password"
          label={t("form.password_label")}
          autoComplete="new-password"
          required
          maxLength={128}
          invalid={Boolean(fields.password)}
          {...described("password", true)}
        />
      </Field>
      {siteKey ? (
        <TurnstileWidget
          siteKey={siteKey}
          language={locale}
          label={t("form.person_check_label")}
          resetKey={state.attempt ?? 0}
        />
      ) : null}
      <SubmitButton icon="next" label={t("form.submit")} pendingLabel={t("form.submitting")} />
      <p className="flex flex-wrap items-center gap-x-2 text-base">
        <span className="text-text-muted">{t("form.have_account")}</span>
        <Link href="/login" className="min-h-touch-min py-2 text-accent underline">
          {t("form.sign_in")}
        </Link>
      </p>
    </form>
  );
}
