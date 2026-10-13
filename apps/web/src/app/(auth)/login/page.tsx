import { postSignInPath, safeNextPath, TWO_FACTOR_SETUP_PATH } from "@cb/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getWebSession } from "@/lib/auth/session";
import { AuthShell } from "./_components/auth-shell";
import { Message } from "./_components/fields";
import { signInAction } from "./actions";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.login");
  return { title: t("title"), robots: { index: false, follow: false } };
}

const NOTICES = ["signed_out", "session_ended", "password_changed"] as const;
type Notice = (typeof NOTICES)[number];

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `/login`: owners, staff and platform admins. Already signed in → straight to your home. */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(first(params.next)) ?? undefined;
  const session = await getWebSession();
  if (session) {
    redirect(
      session.twoFactorEnrolmentRequired
        ? TWO_FACTOR_SETUP_PATH
        : postSignInPath(session.role, next),
    );
  }
  const t = await getTranslations("auth");
  const notice = first(params.notice);
  const shownNotice = NOTICES.includes(notice as Notice) ? (notice as Notice) : null;
  return (
    <AuthShell title={t("login.title")} description={t("login.description")}>
      {shownNotice ? <Message tone="success">{t(`notice.${shownNotice}`)}</Message> : null}
      <LoginForm action={signInAction} {...(next ? { next } : {})} />
    </AuthShell>
  );
}
