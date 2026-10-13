"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { Message, SubmitButton, TextField } from "@/app/(auth)/login/_components/fields";
import type { ResetRequestState } from "./actions";

type Action = (state: ResetRequestState, formData: FormData) => Promise<ResetRequestState>;

/** "Forgot password": one email field. The answer is the same for every address. */
export function RequestResetForm({ action }: { action: Action }) {
  const t = useTranslations("auth");
  const [state, formAction] = useActionState(action, {});
  if (state.sent) {
    return (
      <div className="flex flex-col gap-5">
        <Message tone="success">
          <span className="font-strong">{t("reset.sent_title")}. </span>
          {t("reset.sent")}
        </Message>
        <Link href="/login" className="min-h-touch-min py-2 text-base text-accent underline">
          {t("reset.back")}
        </Link>
      </div>
    );
  }
  const errorText =
    state.error === "rate_limited"
      ? t("error.rate_limited", { minutes: state.minutes ?? 1 })
      : state.error
        ? t(`error.${state.error}`)
        : null;
  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      {errorText ? <Message tone="danger">{errorText}</Message> : null}
      <TextField
        id="email"
        name="email"
        type="email"
        label={t("reset.email_label")}
        autoComplete="email"
        inputMode="email"
        required
        invalid={state.error === "required"}
      />
      <SubmitButton icon="next" label={t("reset.submit")} pendingLabel={t("reset.submitting")} />
      <p className="text-sm text-text-muted">{t("reset.lineman_hint")}</p>
      <Link href="/login" className="min-h-touch-min py-2 text-base text-accent underline">
        {t("reset.back")}
      </Link>
    </form>
  );
}
