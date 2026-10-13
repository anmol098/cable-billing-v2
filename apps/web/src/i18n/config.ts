import { LOCALES, type Locale, WEB_DEFAULT_LOCALE } from "@cb/i18n";

/** The web keeps the language in a cookie, never in the URL (D-06). next-intl's default name. */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** One year: the choice should survive until the user changes it. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Business dates and times are shown in IST (CLAUDE.md "Time"). */
export const TIME_ZONE = "Asia/Kolkata";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** A cookie value → a supported locale, falling back to English (the web default, D-06). */
export function resolveLocale(value: string | undefined): Locale {
  return isLocale(value) ? value : WEB_DEFAULT_LOCALE;
}
