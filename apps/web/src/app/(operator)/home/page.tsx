// Home skeleton (T-029). T-083 replaces this file: dashboard tiles, alerts and the checklist's
// real `done` flags (setupStepsFor(can, done)) plus the app step's Play Store link / QR.
import { EmptyState } from "@cb/ui";
import { getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { placeholderMetadata } from "@/components/shell/placeholder-page";
import { SetupChecklist, setupStepsFor } from "@/components/shell/setup-checklist";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getTenantContext } from "@/lib/auth/session";

export const generateMetadata = () => placeholderMetadata("home");

export default async function HomePage() {
  const ctx = await getTenantContext();
  const t = await getTranslations("shell");
  return (
    <div className="flex flex-col gap-6" data-placeholder="home">
      <ShellPageHeader title={t("routes.home")} />
      <SetupChecklist steps={setupStepsFor(roleCan(ctx.role))} />
      <EmptyState icon="home" message={t("coming_soon")} />
    </div>
  );
}
