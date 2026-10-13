import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/app/(auth)/login/_components/auth-shell";
import { requestResetAction } from "./actions";
import { RequestResetForm } from "./request-form";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth.reset");
  return { title: t("title"), robots: { index: false, follow: false } };
}

/** `/reset`: ask for a password-reset link (owners and staff; linemen ask their owner). */
export default async function ResetRequestPage() {
  const t = await getTranslations("auth.reset");
  return (
    <AuthShell title={t("title")} description={t("description")}>
      <RequestResetForm action={requestResetAction} />
    </AuthShell>
  );
}
