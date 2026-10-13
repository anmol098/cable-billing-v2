import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("GET /api/health reports ok with a version", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ status: "ok", checks: { db: { status: "not_configured" } } });
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("responses carry the security headers", async ({ request }) => {
    const headers = (await request.get("/")).headers();
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(headers["content-security-policy-report-only"]).toContain("default-src 'self'");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("home renders in English by default and switches to Hindi via the cookie", async ({
    page,
    context,
  }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cable Billing");
    await expect(page).toHaveTitle("Cable Billing");

    await page.getByRole("button", { name: "हिंदी" }).click();

    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("केबल बिलिंग");
    await expect(page.getByRole("button", { name: "हिंदी" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === "NEXT_LOCALE")?.value).toBe("hi");
    expect(page.url()).not.toContain("/hi");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
  });

  test("Hindi renders in Noto Sans Devanagari and amounts use tabular figures", async ({
    page,
  }) => {
    await page.goto("/dev/type");
    const hindi = page.getByTestId("hindi-sample");
    await expect(hindi).toContainText("केबल बिलिंग");

    // The self-hosted Devanagari face is actually downloaded and used for the Hindi text.
    const devanagari = await page.evaluate(async () => {
      await document.fonts.ready;
      const loaded = [...document.fonts]
        .filter((face) => face.status === "loaded")
        .map((face) => face.family.replaceAll('"', ""));
      return {
        loaded,
        family: getComputedStyle(document.querySelector('[data-testid="hindi-sample"]') as Element)
          .fontFamily,
      };
    });
    expect(devanagari.loaded).toContain("Noto Sans Devanagari");
    expect(devanagari.loaded).toContain("Inter");
    expect(devanagari.family).toMatch(/^Inter, "Noto Sans Devanagari"/);

    // Same digit count, different digits: with tabular figures the widths are identical.
    const amounts = page.getByTestId("amount");
    await expect(amounts.nth(2)).toHaveText("₹1,11,111");
    await expect(amounts.nth(3)).toHaveText("₹8,88,888");
    const style = await amounts
      .first()
      .evaluate((el) => getComputedStyle(el).fontFeatureSettings.replaceAll('"', ""));
    expect(style).toContain("tnum");
    const widthOf = async (index: number) => (await amounts.nth(index).boundingBox())?.width ?? 0;
    const ones = await widthOf(2);
    const eights = await widthOf(3);
    expect(ones).toBeGreaterThan(0);
    expect(ones).toBeCloseTo(eights, 1);

    // Control: with tabular figures switched off, Inter's proportional "1" is narrower than "8",
    // so the equal widths above really come from `tnum`.
    await page.evaluate(() => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-testid="amount"]')) {
        el.style.fontFeatureSettings = '"tnum" 0';
      }
    });
    expect(await widthOf(2)).toBeLessThan((await widthOf(3)) - 1);
  });

  test("pages raise no Content-Security-Policy reports", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) violations.push(message.text());
    });
    await page.goto("/");
    await page.goto("/dev/type");
    await page.evaluate(() => document.fonts.ready);
    expect(violations).toEqual([]);
  });
});
