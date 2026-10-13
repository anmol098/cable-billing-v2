/** Locales shipped by Cable Billing (D-06). `en` is the source language every key is authored in. */
export const LOCALES = ["en", "hi"] as const;
export type Locale = (typeof LOCALES)[number];

/** The language every key is written in first; other locales must match its keys and placeholders. */
export const SOURCE_LOCALE: Locale = "en";

/** D-06: English is the default on the web, Hindi on Android. */
export const WEB_DEFAULT_LOCALE: Locale = "en";
export const ANDROID_DEFAULT_LOCALE: Locale = "hi";

/** Top-level key in `hi/<namespace>.json` listing machine-drafted keys the product owner must review (D-23). */
export const REVIEW_KEY = "_review";

/** Namespaces that are also emitted to Android `strings_generated.xml`. */
export function isAndroidNamespace(namespace: string): boolean {
  return namespace === "common" || namespace.startsWith("mobile_");
}

/** Namespace (file name) and key segment format. Snake case keeps Android resource names valid. */
export const NAME_PATTERN = /^[a-z][a-z0-9_]*$/;
