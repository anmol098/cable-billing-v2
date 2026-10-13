"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Message, PasswordField, SubmitButton } from "@/app/(auth)/login/_components/fields";
import type { VerifyFormState } from "./actions";

type Action = (state: VerifyFormState, formData: FormData) => Promise<VerifyFormState>;

/**
 * "Start Cable Billing": shows the business and email being confirmed, asks for the password
 * chosen at sign-up, one big Start button.
 */
export function VerifyForm({
  action,
  token,
  businessName,
  email,
}: {
  action: Action;
  token: string;
  businessName: string;
  email: string;
}) {
  const t = useTranslations("signup");
  const [state, formAction] = useActionState(action, {});
  const errorText =
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error === "wrong_password"
        ? t("verify.wrong_password")
        : state.error === "account_exists"
          ? t("verify.account_exists")
          : state.error === "invalid_link"
            ? t("verify.invalid_body")
            : state.error === "required"
              ? t("error.required")
              : state.error
                ? t("error.unexpected")
                : null;
  const showSignIn = state.error === "account_exists" || state.error === "invalid_link";
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {errorText ? <Message tone="danger">{errorText}</Message> : null}
      <dl className="flex flex-col gap-3 rounded-md border-hairline border-border p-4">
        <div className="flex flex-col gap-1">
          <dt className="text-sm text-text-muted">{t("verify.business_label")}</dt>
          <dd className="font-strong text-lg">{businessName}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-sm text-text-muted">{t("verify.email_label")}</dt>
          <dd className="break-all text-lg">{email}</dd>
        </div>
      </dl>
      <input type="hidden" name="token" value={token} />
      <PasswordField
        id="password"
        name="password"
        label={t("verify.password_label")}
        autoComplete="current-password"
        required
        maxLength={128}
        invalid={state.error === "wrong_password" || state.error === "required"}
      />
      <SubmitButton icon="next" label={t("verify.submit")} pendingLabel={t("verify.submitting")} />
      {showSignIn ? (
        <Link href="/login" className="min-h-touch-min py-2 text-base text-accent underline">
          {t("verify.sign_in")}
        </Link>
      ) : null}
    </form>
  );
}
