import { expect, type Page, test } from "@playwright/test";

/** T-007 acceptance: /dev/ui renders in English and Hindi, and phones (360px) never scroll sideways. */

const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 900 };

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe("/dev/ui showcase", () => {
  test("English at 360px: every section, cards instead of the table, no sideways scroll", async ({
    page,
  }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/dev/ui");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("UI showcase");
    await expect(page).toHaveTitle("UI showcase · Cable Billing");
    await expect(page.locator("[data-section]")).toHaveCount(11);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // DataTable: cards under `sm`, the table hidden.
    await expect(page.locator('[data-view="cards"]')).toBeVisible();
    await expect(page.locator('[data-view="table"]')).toBeHidden();
    // The page's primary action is pinned to the bottom of the screen on phones.
    const action = page.getByRole("button", { name: "Add customer" }).first();
    const box = await action.boundingBox();
    expect(box && box.y + box.height).toBeGreaterThan(PHONE.height - 80);
  });

  test("switches to Hindi with EN | हिं and still fits 360px", async ({ page, context }) => {
    await page.setViewportSize(PHONE);
    await page.goto("/dev/ui");
    await page.getByRole("button", { name: "हिंदी" }).click();

    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("UI नमूने");
    await expect(page.getByRole("button", { name: "हिंदी" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const cookies = await context.cookies();
    expect(cookies.find((c) => c.name === "NEXT_LOCALE")?.value).toBe("hi");
    await expect(page.getByRole("heading", { name: "टेबल" })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // Overlays fit too.
    await page.getByRole("button", { name: "कनेक्शन बंद करें" }).last().click();
    const sheet = page.getByRole("alertdialog", { name: "यह कनेक्शन बंद करें?" });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText("₹450");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "रद्द करें" }).click();
    await expect(sheet).toBeHidden();
  });

  test("desktop: the table replaces the cards; composites work in the browser", async ({
    page,
  }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto("/dev/ui");
    await expect(page.locator('[data-view="table"]')).toBeVisible();
    await expect(page.locator('[data-view="cards"]')).toBeHidden();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // Row click → toast (icon + colour + word).
    await page.getByRole("table").getByRole("button", { name: "Sita Devi" }).click();
    await expect(page.getByText("Opened Sita Devi", { exact: true })).toBeVisible();

    // Stepper: Next is blocked by the required name, then moves on.
    const stepper = page.locator('[data-slot="stepper"]');
    await stepper.getByRole("button", { name: "Next" }).click();
    await expect(stepper.getByText("Step 1 of 3")).toBeVisible();
    await stepper.getByRole("textbox", { name: "Customer name" }).fill("Ramesh");
    await stepper.getByRole("button", { name: "Next" }).click();
    await expect(stepper.getByText("Step 2 of 3")).toBeVisible();
    await expect(stepper.getByRole("heading", { name: "Connections" })).toBeFocused();

    // Combobox: async search, arrows + Enter.
    const search = page.getByRole("combobox", { name: "Find customer" });
    await search.fill("ram");
    await expect(
      page.getByRole("listbox", { name: "Find customer" }).getByRole("option"),
    ).toHaveCount(2);
    await search.press("ArrowDown");
    await search.press("Enter");
    await expect(page.getByTestId("chosen")).toHaveText("Chosen: Ramesh Singh");

    // HelpTip: one sentence + its Hindi translation.
    await page.getByRole("button", { name: "Help: Due" }).click();
    await expect(page.getByText("Money the customer still has to pay.")).toBeVisible();
    await expect(page.locator('p[lang="hi"]')).toBeVisible();
  });

  test("raises no Content-Security-Policy reports", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (message.text().includes("Content Security Policy")) violations.push(message.text());
    });
    await page.goto("/dev/ui");
    await page.evaluate(() => document.fonts.ready);
    expect(violations).toEqual([]);
  });
});
