import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/**
 * Public pages (T-087): every page in English and Hindi answers 200, has its heading and raises no
 * console errors (CSP reports included); the sign-up and sign-in links work; nothing scrolls
 * sideways at 360px; the legal drafts say they are drafts.
 */

const PHONE = { width: 360, height: 740 };

type PageCase = {
  path: string;
  title: Record<"en" | "hi", string>;
  h1: Record<"en" | "hi", string>;
};

const PAGES: PageCase[] = [
  {
    path: "/",
    title: { en: "Cable Billing", hi: "केबल बिलिंग" },
    h1: { en: "Cable Billing", hi: "केबल बिलिंग" },
  },
  {
    path: "/pricing",
    title: { en: "Price · Cable Billing", hi: "कीमत · केबल बिलिंग" },
    h1: { en: "Price", hi: "कीमत" },
  },
  {
    path: "/privacy",
    title: { en: "Privacy policy · Cable Billing", hi: "प्राइवेसी पॉलिसी · केबल बिलिंग" },
    h1: { en: "Privacy policy", hi: "प्राइवेसी पॉलिसी" },
  },
  {
    path: "/terms",
    title: { en: "Terms of use · Cable Billing", hi: "इस्तेमाल की शर्तें · केबल बिलिंग" },
    h1: { en: "Terms of use", hi: "इस्तेमाल की शर्तें" },
  },
  {
    path: "/contact",
    title: { en: "Contact us · Cable Billing", hi: "हमसे बात करें · केबल बिलिंग" },
    h1: { en: "Contact us", hi: "हमसे बात करें" },
  },
];

async function useLocale(context: BrowserContext, baseURL: string | undefined, locale: string) {
  await context.addCookies([
    { name: "NEXT_LOCALE", value: locale, url: baseURL ?? "http://localhost:3100" },
  ]);
}

/** Console errors and uncaught exceptions (a CSP report-only violation is a console error). */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    // There is no favicon until the brand assets exist (H-02); the browser's own request 404s.
    if (message.location().url.endsWith("/favicon.ico")) return;
    if (message.type() === "error" || message.text().includes("Content Security Policy")) {
      errors.push(`${message.text()} (${message.location().url})`);
    }
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return errors;
}

for (const locale of ["en", "hi"] as const) {
  test.describe(`public pages in ${locale}`, () => {
    for (const { path, title, h1 } of PAGES) {
      test(`${path} renders`, async ({ page, context, baseURL }) => {
        await useLocale(context, baseURL, locale);
        const errors = collectErrors(page);
        const response = await page.goto(path);
        expect(response?.status()).toBe(200);
        await expect(page.locator("html")).toHaveAttribute("lang", locale);
        await expect(page).toHaveTitle(title[locale]);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1[locale]);
        await expect(page.getByRole("main")).toBeVisible();
        // The sign-in link is in the header of every page.
        await expect(page.locator('header a[href="/login"]')).toBeVisible();
        await page.evaluate(() => document.fonts.ready);
        expect(errors).toEqual([]);
      });
    }

    test("nothing scrolls sideways at 360px", async ({ page, context, baseURL }) => {
      await useLocale(context, baseURL, locale);
      await page.setViewportSize(PHONE);
      for (const { path } of PAGES) {
        await page.goto(path);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, path).toBe(0);
      }
    });
  });
}

test.describe("public page links", () => {
  test("Start free trial goes to /signup and Sign in opens the sign-in page", async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const trial = page.getByRole("link", { name: "Start free trial" }).first();
    await expect(trial).toHaveAttribute("href", "/signup");

    // /signup is T-027's page. Until it is merged the route does not exist; once it is, it must load.
    const signup = await request.get("/signup");
    test.info().annotations.push({ type: "signup status", description: String(signup.status()) });
    if (signup.status() !== 404) expect(signup.status()).toBe(200);

    await page.getByRole("banner").getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
  });

  test("footer links reach every public page", async ({ page }) => {
    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    for (const [name, path, h1] of [
      ["Price", "/pricing", "Price"],
      ["Privacy policy", "/privacy", "Privacy policy"],
      ["Terms of use", "/terms", "Terms of use"],
      ["Contact us", "/contact", "Contact us"],
    ] as const) {
      await footer.getByRole("link", { name }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(h1);
    }
    await page.getByRole("banner").getByRole("link", { name: "Cable Billing" }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test("with a session cookie the header says Open app (and still goes through /login)", async ({
    page,
    context,
    baseURL,
  }) => {
    await context.addCookies([
      {
        name: "cb.session_token",
        value: "not-a-real-session",
        url: baseURL ?? "http://localhost:3100",
      },
    ]);
    await page.goto("/");
    const open = page.getByRole("banner").getByRole("link", { name: "Open app" });
    await expect(open).toHaveAttribute("href", "/login");
    // The landing page itself is shown to signed-in users too (no redirect from `/`).
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cable Billing");
  });

  test("the language switch works on a public page", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("button", { name: "हिंदी" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("कीमत");
    await expect(page.getByTestId("price")).toHaveText("₹400");
  });

  test("the legal pages are marked as drafts and kept out of search results", async ({ page }) => {
    for (const path of ["/privacy", "/terms"]) {
      await page.goto(path);
      await expect(page.getByRole("note")).toContainText("Draft: for legal review");
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    }
  });

  test("contact says honestly when no support details are configured", async ({ page }) => {
    await page.goto("/contact");
    // CI and local runs have no SUPPORT_EMAIL; production requires it (env.ts).
    await expect(page.getByText("Contact details will be added here soon.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Get a new one" })).toHaveAttribute(
      "href",
      "/reset",
    );
  });
});
