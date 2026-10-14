import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * The EN | हिं switch (T-087b): each button's accessible name starts with its visible text (WCAG
 * 2.5.3), and an English page does not download the Devanagari web face just to draw "हिं" (the
 * other language's button uses the device font). Hindi pages still load and use the face.
 */

/** The Devanagari subset of Noto Sans Devanagari (≈120 KB). Its `latin-ext` file is the `₹` face. */
const DEVANAGARI_FACE = /noto_sans_devanagari_devanagari/i;

async function useLocale(context: BrowserContext, baseURL: string | undefined, locale: string) {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: locale, url: baseURL ?? "http://localhost:3100" },
  ]);
}

/** Every font file the page requests, collected from before navigation. */
function collectFonts(page: Page): string[] {
  const fonts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "font") fonts.push(new URL(request.url()).pathname);
  });
  return fonts;
}

/** Waits until the page has laid out its text and every font it needs has loaded. */
async function settle(page: Page) {
  await page.waitForLoadState("load");
  await page.evaluate(() => document.fonts.ready);
}

for (const path of ["/", "/pricing", "/login"]) {
  test(`${path} in English requests no Devanagari font; the switch names contain its text`, async ({
    page,
    context,
    baseURL,
  }) => {
    await useLocale(context, baseURL, "en");
    const fonts = collectFonts(page);
    await page.goto(path);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    const hindi = page.getByRole("button", { name: "हिं, हिंदी", exact: true });
    const english = page.getByRole("button", { name: "EN, English", exact: true });
    await expect(hindi).toHaveText("हिं");
    await expect(english).toHaveText("EN");
    await settle(page);

    expect(fonts.length).toBeGreaterThan(0);
    expect(fonts.filter((url) => DEVANAGARI_FACE.test(url))).toEqual([]);
    const loaded = await page.evaluate(() =>
      [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
    );
    expect(loaded.map((family) => family.replaceAll('"', ""))).not.toContain(
      "Noto Sans Devanagari",
    );

    // "हिं" is drawn in the device font; English text stays in the page font.
    const familyOf = (locator: typeof hindi) =>
      locator.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(await familyOf(hindi)).toMatch(/^system-ui\b/);
    expect(await familyOf(english)).toMatch(/^Inter, "Noto Sans Devanagari"/);
  });
}

test("a Hindi page still downloads Noto Sans Devanagari and draws हिं and its text in it", async ({
  page,
  context,
  baseURL,
}) => {
  await useLocale(context, baseURL, "hi");
  const fonts = collectFonts(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "hi");
  const hindi = page.getByRole("button", { name: "हिं, हिंदी", exact: true });
  await expect(hindi).toHaveAttribute("aria-pressed", "true");
  await settle(page);

  expect(fonts.filter((url) => DEVANAGARI_FACE.test(url))).toHaveLength(1);
  const loaded = await page.evaluate(() =>
    [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
  );
  expect(loaded.map((family) => family.replaceAll('"', ""))).toContain("Noto Sans Devanagari");
  for (const locator of [hindi, page.getByRole("heading", { level: 1 })]) {
    expect(await locator.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(
      /^Inter, "Noto Sans Devanagari"/,
    );
  }
  // The other language's button uses the device font (Inter is loaded anyway on every page).
  const english = page.getByRole("button", { name: "EN, English", exact: true });
  expect(await english.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(/^system-ui\b/);
});
