import { postSignInPath } from "@cb/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getWebSession } from "@/lib/auth/session";
import { AuthShell } from "../../_components/auth-shell";
import { confirmEnrolmentAction, startEnrolmentAction } from "../../actions";
import { SetupFlow } from "./setup-flow";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.two_factor_setup");
  return { title: t("title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * `/login/2fa/setup`: TOTP enrolment, required for platform admins before /admin (PLAN §9.2).
 * Needs a signed-in session; once 2FA is on, it sends the user home.
 */
export default async function TwoFactorSetupPage() {
  const session = await getWebSession();
  if (!session) redirect("/login");
  if (session.twoFactorEnabled) redirect(postSignInPath(session.role, undefined));
  const t = await getTranslations("auth.two_factor_setup");
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <SetupFlow start={startEnrolmentAction} confirm={confirmEnrolmentAction} />
    </AuthShell>
  );
}
