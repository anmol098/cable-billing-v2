import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PricingContent } from "../_components/pricing-content";
import { marketingFacts } from "../_lib/facts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.pricing");
  return { title: t("title"), description: t("description", marketingFacts()) };
}

/** `/pricing`: ₹400 + GST a month, unlimited customers, 30 days free (D-20, D-22). */
export default function PricingPage() {
  return <PricingContent />;
}
