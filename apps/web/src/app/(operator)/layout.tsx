/**
 * The operator app shell (T-029): every Owner/Staff page renders inside it.
 *
 * - `getTenantContext()` is the real sign-in gate (no session → /login, platform admin → /admin);
 *   pages and Server Actions call it again (it is cached per request).
 * - Header: business name, language switch, account menu (sign out). Under it, the subscription
 *   banner slot. Sidebar from `md` up, bottom bar + "More" on phones; both list only the sections
 *   the role may see (`@/lib/nav`, T-025 capabilities).
 * - `ToastProvider` is mounted once here: pages call `useToast()`.
 */
import type { TenantRole } from "@cb/core";
import { ToastProvider } from "@cb/ui";
import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { roleCan } from "@/components/shell/access";
import { BottomNav } from "@/components/shell/bottom-nav";
import { SHELL_MAIN_CLASS } from "@/components/shell/layout-classes";
import { loadShellData } from "@/components/shell/shell-data";
import { ShellHeader } from "@/components/shell/shell-header";
import { SideNav } from "@/components/shell/side-nav";
import { bannerFor, SubscriptionBanner } from "@/components/shell/subscription-banner";
import { setLocale } from "@/i18n/actions";
import { signOutAction, signOutEverywhereAction } from "@/lib/auth/actions";
import { getTenantContext } from "@/lib/auth/session";
import { toNavLinks, visibleSections } from "@/lib/nav";

/** Web roles only: linemen never get a web session (T-026). */
function webRole(role: TenantRole): "owner" | "staff" {
  return role === "owner" ? "owner" : "staff";
}

export default async function OperatorLayout({ children }: { children: ReactNode }) {
  const ctx = await getTenantContext();
  const [data, locale, t, common, ui] = await Promise.all([
    loadShellData(ctx),
    getLocale(),
    getTranslations("shell"),
    getTranslations("common"),
    getTranslations("ui"),
  ]);
  const can = roleCan(ctx.role);
  const links = toNavLinks(visibleSections(can), (id) => t(`routes.${id}`));
  const banner = bannerFor(data.subscription, can("subscription.manage"));

  return (
    <ToastProvider closeLabel={common("close")} label={ui("notifications")}>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-bg focus:p-3 focus:text-text"
      >
        {t("skip_to_content")}
      </a>
      <div className="flex min-h-dvh flex-col">
        <ShellHeader
          operatorName={data.operatorName}
          userName={data.userName}
          userRole={webRole(ctx.role)}
          locale={locale}
          setLocale={setLocale}
          signOutAction={signOutAction}
          signOutEverywhereAction={signOutEverywhereAction}
        />
        <SubscriptionBanner banner={banner} locale={locale} />
        <div className="flex flex-1">
          <SideNav links={links} label={t("main_menu")} />
          <main id="main" className={SHELL_MAIN_CLASS}>
            {children}
          </main>
        </div>
        <BottomNav
          links={links}
          label={t("main_menu")}
          moreLabel={t("more")}
          moreMenuLabel={t("more_menu")}
        />
      </div>
    </ToastProvider>
  );
}
