import type { Locale } from "@cb/i18n";
import { useTranslations } from "next-intl";

type Props = {
  /** The locale the page is rendered in; its button is shown as selected. */
  current: Locale;
  /** Normally the `setLocale` server action from `@/i18n/actions`. */
  action: (formData: FormData) => void | Promise<void>;
};

const OPTIONS = [
  { locale: "en", label: "language_english" },
  { locale: "hi", label: "language_hindi" },
] as const;

/**
 * Scaffold language switch: one tap, each language named in its own script.
 * T-007's `LanguageSwitch` composite replaces the markup; keep `setLocale` as the action.
 */
export function LocaleSwitch({ current, action }: Props) {
  const t = useTranslations("common");
  const tScaffold = useTranslations("scaffold.home");
  return (
    <form action={action} className="flex gap-2" aria-label={tScaffold("language")}>
      {OPTIONS.map(({ locale, label }) => {
        const selected = locale === current;
        return (
          <button
            key={locale}
            type="submit"
            name="locale"
            value={locale}
            lang={locale}
            aria-pressed={selected}
            className={
              selected
                ? "min-h-touch-min rounded-md border-hairline border-accent bg-accent px-4 text-on-accent"
                : "min-h-touch-min rounded-md border-hairline border-border bg-bg px-4 text-text"
            }
          >
            {t(label)}
          </button>
        );
      })}
    </form>
  );
}
