import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@cb/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/app/(auth)/login/_components/auth-shell";
import {
  checkAdminSetupLinkAction,
  finishAdminSetupAction,
  startAdminSetupAction,
} from "./actions";
import { AdminSetupFlow } from "./setup-flow";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.admin_setup");
  return { title: t("title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * `/admin-setup#<token>` (T-086d): the one-time link a new platform admin gets from the
 * `admin:create` command. The token is in the fragment, so the server never sees it here: this
 * page is the same for everyone, and the browser checks the link and runs the setup through
 * Server Actions (the token goes in their POST bodies). The key is made only when "Start" is
 * pressed, and the link is used up when the password and first code are saved.
 */
export default async function AdminSetupPage() {
  const t = await getTranslations("auth.admin_setup");
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <AdminSetupFlow
        check={checkAdminSetupLinkAction}
        start={startAdminSetupAction}
        finish={finishAdminSetupAction}
        passwordMinLength={PASSWORD_MIN_LENGTH}
        passwordMaxLength={PASSWORD_MAX_LENGTH}
      />
    </AuthShell>
  );
}
