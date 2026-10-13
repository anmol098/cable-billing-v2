import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { serverEnv } from "@/env";
import { ContactContent } from "../_components/contact-content";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.contact");
  return { title: t("title"), description: t("description") };
}

/** `/contact`: support email and phone from `SUPPORT_EMAIL` / `SUPPORT_PHONE`. */
export default function ContactPage() {
  return <ContactContent email={serverEnv.SUPPORT_EMAIL} phone={serverEnv.SUPPORT_PHONE} />;
}
