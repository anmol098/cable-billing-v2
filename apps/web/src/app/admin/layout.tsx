/**
 * The platform admin console shell (T-086, PLAN §12.4): a header with the console's sections and
 * sign out. `getAdminContext()` is the gate (platform_admin + TOTP, re-checked in the database);
 * every page and Server Action below calls it again.
 */
import { Button, type IconName } from "@cb/ui";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { signOutAction } from "@/lib/auth/actions";
import { getAdminContext } from "./_lib/context";

export const dynamic = "force-dynamic";

const SECTIONS = [
  { key: "overview", href: "/admin", icon: "report" },
  { key: "tenants", href: "/admin/tenants", icon: "business" },
  { key: "jobs", href: "/admin/jobs", icon: "retry" },
  { key: "razorpay", href: "/admin/razorpay", icon: "subscription" },
  { key: "audit", href: "/admin/audit", icon: "audit" },
] as const satisfies readonly { key: string; href: string; icon: IconName }[];

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await getAdminContext();
  const t = await getTranslations("admin");
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-border border-b bg-bg">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
          <p className="mr-auto font-strong text-lg">{t("title")}</p>
          <form action={signOutAction}>
            <Button type="submit" variant="quiet" icon="logout">
              {t("nav.sign_out")}
            </Button>
          </form>
        </div>
        <nav aria-label={t("nav.label")} className="mx-auto max-w-6xl overflow-x-auto px-4 pb-2">
          <ul className="flex gap-1">
            {SECTIONS.map((s) => (
              <li key={s.key}>
                <Button asChild variant="quiet" icon={s.icon}>
                  <Link href={s.href}>{t(`nav.${s.key}`)}</Link>
                </Button>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-4 py-6">
        {children}
      </main>
    </div>
  );
}
