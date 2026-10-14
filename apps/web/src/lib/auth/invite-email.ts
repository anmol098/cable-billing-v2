/**
 * The staff invitation email (T-032): the Owner added a staff member and chose "Email them a link".
 * It carries the same single-use link as a password reset (T-026), worded as an invitation, in the
 * staff member's language. Words from the `team` namespace. Plain text.
 */
import type { AuthEmailMessage, PasswordResetEmail, PasswordResetInvite } from "@cb/core";
import { createTranslator } from "next-intl";
import en from "../../../messages/en.json";
import hi from "../../../messages/hi.json";

const MESSAGES = { en, hi } as const;

export function renderInviteEmail(
  email: PasswordResetEmail & { readonly invite: PasswordResetInvite },
): AuthEmailMessage {
  const t = createTranslator({
    locale: email.language,
    messages: MESSAGES[email.language],
    namespace: "team.email",
  });
  const app = MESSAGES[email.language].common.app_name;
  const values = { business: email.invite.businessName, app, login: email.invite.login };
  const text = [
    t("invite_intro", values),
    "",
    t("invite_action", { minutes: email.expiresInMinutes }),
    email.resetUrl,
    "",
    t("invite_later"),
    "",
    app,
  ].join("\n");
  return { to: email.to, subject: t("invite_subject", values), text };
}
