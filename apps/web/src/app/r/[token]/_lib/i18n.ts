/**
 * Language of the public receipt page (D-06: Hindi + English). The customer has no account, so:
 * `?lang=hi|en` in the URL (the switch links on the page, or a link made in a given language),
 * else the operator's default language (`settings.default_language`, Hindi unless changed).
 * Generic pages (link not working, too many tries, error) don't know the operator and show both
 * languages, so they look the same whatever the token.
 *
 * Words come from the `receipt` namespace of the generated next-intl messages (`apps/web/messages`).
 */
import type { Locale } from "@cb/i18n";
import { createTranslator } from "next-intl";
import en from "../../../../../messages/en.json";
import hi from "../../../../../messages/hi.json";

export type ReceiptTranslator = ReturnType<typeof translatorFor>;

const MESSAGES = { en, hi } as const;

export function translatorFor(locale: Locale) {
  return createTranslator({ locale, messages: MESSAGES[locale], namespace: "receipt" });
}

/** `?lang=` when it names a supported language, else `undefined`. */
export function requestedLocale(url: URL): Locale | undefined {
  const lang = url.searchParams.get("lang");
  return lang === "hi" || lang === "en" ? lang : undefined;
}

/** The page language: the URL's choice, else the operator's default. */
export function receiptLocale(url: URL, operatorDefault: Locale): Locale {
  return requestedLocale(url) ?? operatorDefault;
}

/** Hindi first: the common case for cable customers, and the app's default on Android. */
export const GENERIC_PAGE_LOCALES: readonly Locale[] = ["hi", "en"];
