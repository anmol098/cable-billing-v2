/**
 * The password-reset email in the user's language (`users.language`), words from the `auth`
 * namespace. Plain text: short, works in every mail app.
 */
import type { AuthEmailMessage, PasswordResetEmail } from "@cb/core";
import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";

const MESSAGES = { en, hi } as const;

export function renderResetEmail(email: PasswordResetEmail): AuthEmailMessage {
  const t = createTranslator({
    locale: email.language,
    messages: MESSAGES[email.language],
    namespace: "auth.email",
  });
  const text = [
    t("reset_intro"),
    "",
    t("reset_action", { minutes: email.expiresInMinutes }),
    email.resetUrl,
    "",
    t("reset_ignore"),
    "",
    MESSAGES[email.language].common.app_name,
  ].join("\n");
  return { to: email.to, subject: t("reset_subject"), text };
}
