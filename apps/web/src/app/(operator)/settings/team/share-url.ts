/**
 * Server only: the "Share sign-in on WhatsApp" link for a lineman, worded in the lineman's own
 * language (their phone app's language), not the Owner's. Never contains the password.
 */
import { getTranslations } from "next-intl/server";
import { shareMessage, type Translate, whatsAppShareUrl } from "./share";

export async function linemanShareUrl(input: {
  readonly business: string;
  readonly login: string;
  readonly mobile: string | null;
  readonly language: "hi" | "en";
}): Promise<string> {
  const t = (await getTranslations({
    locale: input.language,
    namespace: "team",
  })) as unknown as Translate;
  const common = await getTranslations({ locale: input.language, namespace: "common" });
  const text = shareMessage(t, {
    business: input.business,
    app: common("app_name"),
    login: input.login,
  });
  return whatsAppShareUrl(input.mobile, text);
}
