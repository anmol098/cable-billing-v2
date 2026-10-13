import type { Locale } from "@cb/i18n";
import { type RenderResult, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import en from "../../messages/en.json";
import hi from "../../messages/hi.json";

const MESSAGES = { en, hi } as const;

/** Renders `ui` with the real generated messages for `locale`, as the root layout does. */
export function renderWithIntl(ui: ReactElement, locale: Locale = "en"): RenderResult {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="Asia/Kolkata">
      {ui}
    </NextIntlClientProvider>,
  );
}
