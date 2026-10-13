import type { Locale } from "@cb/i18n";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { serverEnv } from "@/env";
import { setLocale } from "@/i18n/actions";
import { Showcase } from "./showcase";

/**
 * /dev/ui: every primitive and composite from @cb/ui with real i18n words (T-007). Switch the
 * language with the EN | हिं switch at the top. Hidden in production (404), like /dev/type.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("dev_ui");
  return { title: t("title"), robots: { index: false } };
}

export default async function DevUiPage() {
  if (serverEnv.VERCEL_ENV === "production") notFound();
  const locale = await getLocale();
  const other: Locale = locale === "hi" ? "en" : "hi";
  const otherT = await getTranslations({ locale: other, namespace: "dev_ui" });
  return (
    <Showcase
      locale={locale}
      localeAction={setLocale}
      helpTranslation={{ text: otherT("help.text"), lang: other }}
    />
  );
}
