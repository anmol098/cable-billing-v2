import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/app/(auth)/login/_components/auth-shell";
import { Message } from "@/app/(auth)/login/_components/fields";
import { getAdminSetupService } from "@/lib/auth/server";
import { finishAdminSetupAction, startAdminSetupAction } from "../actions";
import { AdminSetupFlow } from "./setup-flow";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.admin_setup");
  // The token is in the URL: never send it on as a Referer, never index the page.
  return { title: t("title"), robots: { index: false, follow: false }, referrer: "no-referrer" };
}

/**
 * `/admin-setup/<token>` (T-086d): the one-time link a new platform admin gets from the
 * `admin:create` command. Opening it changes nothing; the key is made only when "Start" is
 * pressed (a POST), and the link is used up when the password and first code are saved.
 */
export default async function AdminSetupPage({ params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.slice(0, 128);
  const t = await getTranslations("auth.admin_setup");
  const link = await getAdminSetupService().inspect(token);
  return (
    <AuthShell title={t("title")} description={link ? t("description") : undefined}>
      {link ? (
        <AdminSetupFlow
          token={token}
          email={link.email}
          start={startAdminSetupAction}
          finish={finishAdminSetupAction}
        />
      ) : (
        <div data-admin-setup="invalid">
          <Message tone="danger">{t("invalid")}</Message>
        </div>
      )}
    </AuthShell>
  );
}
