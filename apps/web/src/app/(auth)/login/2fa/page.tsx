import { safeNextPath } from "@cb/core";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "../_components/auth-shell";
import { verifyTwoFactorAction } from "../actions";
import { TwoFactorForm } from "./two-factor-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.two_factor");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** `/login/2fa`: second step for 2FA users. The pending step lives in a short-lived signed cookie. */
export default async function TwoFactorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = Array.isArray(params.next) ? params.next[0] : params.next;
  const next = safeNextPath(raw) ?? undefined;
  const t = await getTranslations("auth.two_factor");
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <TwoFactorForm action={verifyTwoFactorAction} {...(next ? { next } : {})} />
    </AuthShell>
  );
}
