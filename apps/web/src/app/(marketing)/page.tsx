import { useLocale, useTranslations } from "next-intl";
import { LocaleSwitch } from "@/components/locale-switch";
import { setLocale } from "@/i18n/actions";

/** Placeholder home page. T-087 (marketing) replaces it with the real landing page. */
export default function HomePage() {
  const t = useTranslations();
  const locale = useLocale();
  return (
    <main className="flex flex-col gap-6 p-6">
      <h1 className="font-strong text-2xl">{t("common.app_name")}</h1>
      <p className="text-text-muted">{t("scaffold.home.placeholder")}</p>
      <LocaleSwitch current={locale} action={setLocale} />
    </main>
  );
}
