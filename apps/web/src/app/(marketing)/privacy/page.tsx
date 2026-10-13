import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalContent } from "../_components/legal";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.privacy");
  // A draft for legal review: reachable by link (Razorpay, Play Console), kept out of search results.
  return { title: t("title"), description: t("description"), robots: { index: false } };
}

/** `/privacy`: privacy policy, a DRAFT until a lawyer has reviewed it (T-087 notes). */
export default function PrivacyPage() {
  return <LegalContent doc="privacy" />;
}
