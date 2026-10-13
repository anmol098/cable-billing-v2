import type { Locale } from "@cb/i18n";
import type messages from "../../messages/en.json";

/** Typed keys: `useTranslations("common")("save")` fails to compile if the key does not exist. */
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: typeof messages;
  }
}
