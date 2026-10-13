import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, resolveLocale, TIME_ZONE } from "./config";

/**
 * next-intl request config (wired in `next.config.ts`). The locale comes from the cookie only;
 * messages are the generated `apps/web/messages/<locale>.json` (source: packages/i18n).
 */
export default getRequestConfig(async ({ locale: requested }) => {
  // `requested` is set when a caller asks for a specific locale, e.g. getTranslations({ locale: "hi" }).
  const locale = resolveLocale(requested ?? (await cookies()).get(LOCALE_COOKIE)?.value);
  const messages = (await import(`../../messages/${locale}.json`)).default;
  return { locale, messages, timeZone: TIME_ZONE };
});
