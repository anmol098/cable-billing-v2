import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/app/(auth)/login/_components/auth-shell";
import { resetPasswordAction } from "../actions";
import { NewPasswordForm } from "./new-password-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.reset_new");
  // The token is in the URL: never send it on as a Referer, never index the page.
  return { title: t("title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * `/reset/<token>`: the link from the reset email. The token is checked (and used up) only when
 * the new password is saved, so opening the link twice is harmless.
 */
export default async function NewPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = await getTranslations("auth.reset_new");
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <NewPasswordForm action={resetPasswordAction} token={token.slice(0, 128)} />
    </AuthShell>
  );
}
