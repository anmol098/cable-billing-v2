/**
 * `/home` (T-083, PLAN §12.1 "Home", §12.3, BRD §12 "Operator dashboard"): how today and this
 * month are going, numbers first. One read (`dashboard.home`, one snapshot) gives today's cash and
 * UPI, this month's bills and money taken, the total due, the latest bill run, what needs checking
 * (handovers, payments, missed bill runs, the free trial) and the setup checklist's done flags.
 * The one primary action is "Take payment". Owner and Staff (`dashboard.view`); the checklist and
 * the links follow the role's capabilities.
 */
import { homeDashboard } from "@cb/core";
import type { DisplayLocale } from "@cb/domain";
import { Button, cn, PAGE_ACTION_CLEARANCE } from "@cb/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { roleCan } from "@/components/shell/access";
import { ShellPageHeader } from "@/components/shell/shell-page-header";
import { getServerRuntime } from "@/lib/auth/server";
import { getTenantContext } from "@/lib/auth/session";
import { canSeeRoute, findRoute } from "@/lib/nav";
import { HomeView } from "./_components/home-view";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shell");
  return { title: t("routes.home") };
}

export default async function HomePage() {
  const ctx = await getTenantContext();
  const can = roleCan(ctx.role);
  const [result, locale, t, shell] = await Promise.all([
    homeDashboard.call(getServerRuntime(), ctx, {}),
    getLocale(),
    getTranslations("home"),
    getTranslations("shell"),
  ]);
  if (!result.ok) throw new Error(`dashboard.home failed: ${result.error.code}`);

  const takePayment = canSeeRoute("payments_new", can) ? (
    <Button asChild size="lg" icon="collect">
      <Link href={findRoute("payments_new")?.path ?? "/payments/new"} data-action="take-payment">
        {t("take_payment")}
      </Link>
    </Button>
  ) : undefined;

  return (
    <div className={cn("flex flex-col gap-6", takePayment && PAGE_ACTION_CLEARANCE)}>
      <ShellPageHeader
        title={shell("routes.home")}
        description={t("page_description")}
        {...(takePayment ? { action: takePayment } : {})}
      />
      <HomeView view={result.value} can={can} locale={locale as DisplayLocale} />
    </div>
  );
}
