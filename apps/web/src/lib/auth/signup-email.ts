/**
 * Sign-up emails (T-027) in the language the sign-up form was shown in, words from the `signup`
 * namespace: the "confirm your email" link, or "you already have an account" (sent instead when
 * the email already has one, so the page never tells strangers who has an account). Plain text.
 */
import type { AuthEmailMessage, SignupEmail } from "@cb/core";
import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";

const MESSAGES = { en, hi } as const;

export function renderSignupEmail(email: SignupEmail): AuthEmailMessage {
  const t = createTranslator({
    locale: email.language,
    messages: MESSAGES[email.language],
    namespace: "signup.email",
  });
  const appName = MESSAGES[email.language].common.app_name;
  if (email.kind === "verify") {
    const text = [
      t("verify_intro"),
      "",
      t("verify_action", { hours: email.expiresInHours }),
      email.verifyUrl,
      "",
      t("verify_ignore"),
      "",
      appName,
    ].join("\n");
    return { to: email.to, subject: t("verify_subject"), text };
  }
  const text = [
    t("existing_intro"),
    "",
    t("existing_sign_in"),
    email.signInUrl,
    "",
    t("existing_reset"),
    email.resetUrl,
    "",
    t("existing_ignore"),
    "",
    appName,
  ].join("\n");
  return { to: email.to, subject: t("existing_subject"), text };
}
