import { postSignInPath, TWO_FACTOR_SETUP_PATH } from "@cb/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/app/(auth)/login/_components/auth-shell";
import { clientEnv } from "@/env";
import { getWebSession } from "@/lib/auth/session";
import { signUpAction } from "./actions";
import { SignupForm } from "./signup-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("signup.form");
  return { title: t("title"), description: t("description") };
}

/**
 * `/signup` (D-15, PLAN §12.3): a new owner creates their account and gets 30 days free. Already
 * signed in → straight to your home.
 */
export default async function SignupPage() {
  const session = await getWebSession();
  if (session) {
    redirect(
      session.twoFactorEnrolmentRequired
        ? TWO_FACTOR_SETUP_PATH
        : postSignInPath(session.role, undefined),
    );
  }
  const t = await getTranslations("signup.form");
  const siteKey = clientEnv.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <SignupForm action={signUpAction} {...(siteKey ? { siteKey } : {})} />
    </AuthShell>
  );
}
