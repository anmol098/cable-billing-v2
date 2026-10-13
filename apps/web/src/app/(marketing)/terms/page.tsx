import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { LegalContent } from "../_components/legal";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.terms");
  // A draft for legal review: reachable by link (Razorpay, Play Console), kept out of search results.
  return { title: t("title"), description: t("description"), robots: { index: false } };
}

/** `/terms`: terms of use, a DRAFT until a lawyer has reviewed it (T-087 notes). */
export default function TermsPage() {
  return <LegalContent doc="terms" />;
}
