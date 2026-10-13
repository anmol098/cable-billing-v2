import { getLocale, getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import { LocaleSwitch } from "@/components/locale-switch";
import { setLocale } from "@/i18n/actions";

/**
 * The frame of every sign-in screen (login, 2FA, password reset): the product name and the
 * language switch on top, then one narrow column with the title and the one job of the screen
 * (PLAN §2.2: one screen = one job; language one tap away).
 */
export async function AuthShell({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const locale = await getLocale();
  const common = await getTranslations("common");
  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="flex items-center justify-between gap-4 border-b-hairline border-border px-4 py-3">
        <p className="font-strong text-lg">{common("app_name")}</p>
        <LocaleSwitch current={locale} action={setLocale} />
      </header>
      <main className="mx-auto flex w-full max-w-112 flex-col gap-6 px-4 py-8">
        <div className="flex flex-col gap-2">
          <h1 className="font-strong text-2xl">{title}</h1>
          {description ? <p className="text-text-muted">{description}</p> : null}
        </div>
        {children}
      </main>
    </div>
  );
}
