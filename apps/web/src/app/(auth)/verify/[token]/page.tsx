import { Icon } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/app/(auth)/login/_components/auth-shell";
import { getSignupService } from "@/lib/auth/server";
import { verifySignupAction } from "./actions";
import { VerifyForm } from "./verify-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("signup.verify");
  // The token is in the URL: never send it on as a Referer, never index the page.
  return { title: t("title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * `/verify/<token>`: the link from the sign-up email. Opening it changes nothing (mail scanners
 * open links too); the tenant is created when the owner types their password and presses Start.
 */
export default async function VerifyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token: raw } = await params;
  const token = raw.slice(0, 64);
  const t = await getTranslations("signup.verify");
  const pending = await getSignupService().pending(token);
  if (!pending) {
    return (
      <AuthShell title={t("invalid_title")}>
        <div className="flex items-start gap-3 rounded-md border-hairline border-danger p-3 text-base text-danger">
          <Icon name="danger" className="mt-1 shrink-0" />
          <p>{t("invalid_body")}</p>
        </div>
        <div className="flex flex-col gap-2">
          <Link href="/login" className="min-h-touch-min py-2 text-base text-accent underline">
            {t("sign_in")}
          </Link>
          <Link href="/signup" className="min-h-touch-min py-2 text-base text-accent underline">
            {t("create_again")}
          </Link>
        </div>
      </AuthShell>
    );
  }
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <VerifyForm
        action={verifySignupAction}
        token={token}
        businessName={pending.businessName}
        email={pending.email}
      />
    </AuthShell>
  );
}
