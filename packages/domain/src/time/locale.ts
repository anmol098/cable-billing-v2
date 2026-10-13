/**
 * The languages the domain can label things in (D-06). Same values as `@cb/i18n`'s `Locale`;
 * `@cb/domain` does not import `@cb/i18n` so it stays dependency-free.
 */
export const DISPLAY_LOCALES = ["en", "hi"] as const;

export type DisplayLocale = (typeof DISPLAY_LOCALES)[number];
