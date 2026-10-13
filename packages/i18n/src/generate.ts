import { renderAndroidXml } from "./android";
import { buildAndroidEntries, buildWebMessages, type Catalog, stableJson } from "./catalog";
import { LOCALES, type Locale } from "./locales";

export interface GeneratedFile {
  /** Path relative to the repository root. */
  path: string;
  content: string;
}

export const WEB_MESSAGES_DIR = "apps/web/messages";
export const ANDROID_RES_DIR = "apps/android/app/src/main/res";

/** English is Android's default resource folder; Hindi (the default app locale) is `values-hi`. */
export function androidValuesDir(locale: Locale): string {
  return locale === "en" ? "values" : `values-${locale}`;
}

/** Every generated file, in a fixed order, from a catalog that passed `validateCatalog`. */
export function generateFiles(catalog: Catalog): GeneratedFile[] {
  const web = LOCALES.map((locale) => ({
    path: `${WEB_MESSAGES_DIR}/${locale}.json`,
    content: stableJson(buildWebMessages(catalog, locale)),
  }));
  const android = LOCALES.map((locale) => ({
    path: `${ANDROID_RES_DIR}/${androidValuesDir(locale)}/strings_generated.xml`,
    content: renderAndroidXml(
      buildAndroidEntries(catalog, locale),
      `packages/i18n/messages/${locale}`,
    ),
  }));
  return [...web, ...android];
}
