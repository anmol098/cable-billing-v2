import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { HomeContent } from "./_components/home-content";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("marketing.home");
  // The title stays the product name (the root layout's default).
  return { description: t("description") };
}

/** `/`: the landing page (T-087). */
export default function HomePage() {
  return <HomeContent />;
}
