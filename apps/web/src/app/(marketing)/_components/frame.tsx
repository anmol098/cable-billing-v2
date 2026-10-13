import type { Locale } from "@cb/i18n";
import { buttonClasses, cn, focusRing } from "@cb/ui";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { LocaleSwitch } from "@/components/locale-switch";
import { CONTAINER, MARKETING_PATHS, SIGN_IN_PATH, TEXT_LINK } from "./links";

type FrameProps = {
  /** A session cookie is present: the sign-in link reads "Open app" (it still goes to /login). */
  signedIn: boolean;
  locale: Locale;
  /** The `setLocale` server action. */
  localeAction: (formData: FormData) => void | Promise<void>;
  children: ReactNode;
};

/**
 * The frame of every public page: product name, Price, Sign in / Open app and the language switch
 * on top; the page; links to the price, legal and contact pages at the bottom. Server-rendered,
 * no client JavaScript of its own (the language switch is a plain form).
 */
export function MarketingFrame({ signedIn, locale, localeAction, children }: FrameProps) {
  const t = useTranslations("marketing.nav");
  const common = useTranslations("common");
  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-bg focus:p-3 focus:text-text"
      >
        {t("skip")}
      </a>
      <div className="flex min-h-dvh flex-col">
        <header className="border-b-hairline border-border">
          <div
            className={cn(
              CONTAINER,
              "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3",
            )}
          >
            <a
              href={MARKETING_PATHS.home}
              className={cn("rounded-sm font-strong text-lg", focusRing)}
            >
              {common("app_name")}
            </a>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <nav aria-label={t("main")} className="flex items-center gap-4">
                <a href={MARKETING_PATHS.pricing} className={TEXT_LINK}>
                  {t("pricing")}
                </a>
                <a href={SIGN_IN_PATH} className={buttonClasses({ variant: "secondary" })}>
                  {signedIn ? t("open_app") : t("sign_in")}
                </a>
              </nav>
              <LocaleSwitch current={locale} action={localeAction} />
            </div>
          </div>
        </header>
        <main id="main" className={cn(CONTAINER, "flex-1 py-8")}>
          {children}
        </main>
        <footer className="border-t-hairline border-border bg-surface">
          <nav aria-label={t("footer")} className={cn(CONTAINER, "py-4")}>
            <ul className="flex flex-wrap gap-x-6 gap-y-1">
              {(["pricing", "privacy", "terms", "contact"] as const).map((page) => (
                <li key={page}>
                  <a href={MARKETING_PATHS[page]} className={cn(TEXT_LINK, "font-regular")}>
                    {t(page)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </footer>
      </div>
    </>
  );
}
