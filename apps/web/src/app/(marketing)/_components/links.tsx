import { LOGIN_PATH } from "@cb/core";
import { buttonClasses, cn, focusRing, Icon } from "@cb/ui";
import { useTranslations } from "next-intl";

/** Public pages (T-087). Plain `<a>` links: no client router, no prefetching on slow networks. */
export const MARKETING_PATHS = {
  home: "/",
  pricing: "/pricing",
  privacy: "/privacy",
  terms: "/terms",
  contact: "/contact",
} as const;

/** Self sign-up (T-027). */
export const SIGN_UP_PATH = "/signup";

/** Sign in (T-026). Signed-in users are sent on to their home from there. */
export const SIGN_IN_PATH = LOGIN_PATH;

/** Ask for a password reset link (T-026). */
export const RESET_PATH = "/reset";

/** An underlined text link with the focus ring and a touch-size hit area. */
export const TEXT_LINK = cn(
  "inline-flex min-h-touch-min items-center font-strong underline underline-offset-4",
  focusRing,
);

/** The one primary action of the public pages: start the free trial (icon + word). */
export function TrialButton() {
  const t = useTranslations("marketing.nav");
  return (
    <a href={SIGN_UP_PATH} className={buttonClasses({ size: "lg", className: "w-full sm:w-auto" })}>
      {t("start_trial")}
      <Icon name="next" className="shrink-0" />
    </a>
  );
}

/** "Already using Cable Billing? Sign in" */
export function SignInLine() {
  const t = useTranslations("marketing");
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-text-muted">
      <span>{t("home.already")}</span>
      <a href={SIGN_IN_PATH} className={cn(TEXT_LINK, "text-text")}>
        {t("nav.sign_in")}
      </a>
    </p>
  );
}

/** Page width and gutters shared by the header, footer and every public page. */
export const CONTAINER = "mx-auto w-full max-w-240 px-4";
