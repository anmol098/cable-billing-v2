import { screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { Showcase } from "./showcase";

const env = vi.hoisted(() => ({ VERCEL_ENV: undefined as string | undefined }));

vi.mock("@/env", () => ({ serverEnv: env }));
vi.mock("@/i18n/actions", () => ({ setLocale: vi.fn() }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
}));
vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () => (key: string) => `[${key}]`,
}));

const SECTIONS = [
  "buttons",
  "fields",
  "numbers",
  "cards",
  "empty",
  "table",
  "dialogs",
  "toasts",
  "stepper",
  "help",
  "search",
];

describe("/dev/ui page", () => {
  beforeEach(() => {
    env.VERCEL_ENV = undefined;
  });

  it("is a 404 in production", async () => {
    env.VERCEL_ENV = "production";
    const { default: DevUiPage } = await import("./page");
    await expect(DevUiPage()).rejects.toThrow("404");
  });

  it.each(["preview", undefined])("renders the showcase when VERCEL_ENV=%s", async (value) => {
    env.VERCEL_ENV = value;
    const { default: DevUiPage } = await import("./page");
    const element = await DevUiPage();
    expect(element.props).toMatchObject({
      locale: "en",
      helpTranslation: { text: "[help.text]", lang: "hi" },
    });
  });
});

describe("Showcase", () => {
  it.each([
    ["en", "UI showcase", "Find customer"],
    ["hi", "UI नमूने", "ग्राहक खोजें"],
  ] as const)("renders every section in %s", (locale, title, search) => {
    const other = locale === "hi" ? "en" : "hi";
    renderWithIntl(
      <Showcase
        locale={locale}
        localeAction={vi.fn()}
        helpTranslation={{ text: "other", lang: other }}
      />,
      locale,
    );
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeInTheDocument();
    const sections = [...document.querySelectorAll<HTMLElement>("[data-section]")];
    expect(sections.map((section) => section.dataset.section)).toEqual(SECTIONS);
    for (const section of sections) {
      expect(within(section).getByRole("heading", { level: 2 }).textContent).not.toBe("");
    }
    expect(screen.getByRole("combobox", { name: search })).toBeInTheDocument();
    // The language switch shows EN | हिं and marks the current language.
    const current = screen.getByRole("button", {
      name: locale === "hi" ? "हिंदी" : "English",
    });
    expect(current).toHaveAttribute("aria-pressed", "true");
    // No raw message keys leaked (a missing key renders as its path).
    expect(document.body.textContent).not.toMatch(/dev_ui\.|ui\.[a-z_]+|common\.[a-z_]+/);
  });
});
