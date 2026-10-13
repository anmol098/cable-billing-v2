import type { Locale } from "@cb/i18n";
import { LanguageSwitch } from "@cb/ui";
import { useTranslations } from "next-intl";

type Props = {
  /** The locale the page is rendered in; its button is shown as selected. */
  current: Locale;
  /** Normally the `setLocale` server action from `@/i18n/actions`. */
  action: (formData: FormData) => void | Promise<void>;
};

/**
 * The app's language switch: T-007's `LanguageSwitch` (EN | हिं, each language named in its own
 * script) with the words from i18n. Pass `setLocale` as the action.
 */
export function LocaleSwitch({ current, action }: Props) {
  const common = useTranslations("common");
  const ui = useTranslations("ui");
  return (
    <LanguageSwitch
      label={ui("language")}
      value={current}
      action={action}
      options={[
        { value: "en", short: ui("language_short_en"), name: common("language_english") },
        { value: "hi", short: ui("language_short_hi"), name: common("language_hindi") },
      ]}
    />
  );
}
