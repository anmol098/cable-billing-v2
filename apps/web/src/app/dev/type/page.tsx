import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { serverEnv } from "@/env";

/**
 * Developer check page (T-005 acceptance): Hindi renders in Noto Sans Devanagari and amounts use
 * tabular figures. Hidden in production. The Playwright smoke test measures it.
 */
export const metadata: Metadata = { robots: { index: false } };

/** Whole rupees with Indian grouping (₹1,23,456). T-006's `Amount` component takes over. */
const rupees = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const formatPaise = (paise: bigint) => rupees.format(paise / 100n);

/** `11111100` and `88888800` paise have the same digit count: tabular figures make them equal width. */
const SAMPLE_PAISE = [0n, 9_900n, 11_111_100n, 88_888_800n, 12_345_600n] as const;

/** The same `common` words shown in both languages. */
const SAMPLE_KEYS = [
  "app_name",
  "collect",
  "cash",
  "due",
  "saved_on_phone",
  "hand_over_cash",
] as const;

export default async function TypeSamplePage() {
  if (serverEnv.VERCEL_ENV === "production") notFound();
  const t = await getTranslations("scaffold.type_sample");
  const common = await getTranslations("common");
  const hindi = await getTranslations({ locale: "hi", namespace: "common" });
  const english = await getTranslations({ locale: "en", namespace: "common" });

  return (
    <main className="flex flex-col gap-8 p-6">
      <h1 className="font-strong text-2xl">{t("title")}</h1>

      <section className="flex flex-col gap-2">
        <h2 className="font-strong text-lg">{t("hindi")}</h2>
        <ul lang="hi" data-testid="hindi-sample" className="flex flex-col gap-1 text-xl">
          {SAMPLE_KEYS.map((key) => (
            <li key={key}>{hindi(key)}</li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-strong text-lg">{t("english")}</h2>
        <ul lang="en" className="flex flex-col gap-1 text-xl">
          {SAMPLE_KEYS.map((key) => (
            <li key={key}>{english(key)}</li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="font-strong text-lg">{t("amounts")}</h2>
        <ul data-testid="amount-sample" className="flex flex-col items-end gap-1">
          {SAMPLE_PAISE.map((paise) => (
            <li key={paise.toString()}>
              <span data-testid="amount" className="font-numeric font-strong text-amount">
                {common("amount", { amount: formatPaise(paise) })}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
