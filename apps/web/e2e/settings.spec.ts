/**
 * Settings → Business details and Areas (T-030) against `next start` and a real, migrated
 * database: the Owner edits the profile (and the header and database follow) and adds, renames,
 * hides and shows areas; Staff and a read-only Owner see the same pages read-only.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `shell.spec.ts`. Each run seeds
 * its own operators and users with random names.
 */
import { randomBytes } from "node:crypto";
import { hashPassword } from "@cb/core";
import {
  accounts,
  areas,
  createDb,
  type DbClient,
  operators,
  type SubscriptionStatus,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e settings password 4321";
const PHONE = { width: 360, height: 800 };

test.describe("settings: business details and areas", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const login = (who: string) => `e2e-settings-${who}-${run}`;
  const business = (name: string) => `${name} Cable ${run}`;
  const operatorIds: Record<string, string> = {};
  let db: DbClient;

  async function seedTenant(
    name: string,
    status: SubscriptionStatus,
    people: ReadonlyArray<readonly [who: string, role: "owner" | "staff"]>,
  ) {
    const operatorId = uuidv7();
    operatorIds[name] = operatorId;
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: business(name) });
      await tx.insert(subscriptions).values({
        operatorId,
        status,
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      await tx.insert(areas).values({ id: uuidv7(), operatorId, name: "Old market" });
      for (const [who, role] of people) {
        const id = uuidv7();
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${who}`,
          login: login(who),
          email: `e2e-settings-${who}-${run}@cable.test`,
          language: "en",
        });
        await tx.insert(accounts).values({
          id: uuidv7(),
          userId: id,
          accountId: id,
          providerId: "credential",
          password: hash,
        });
      }
    });
  }

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    await seedTenant("Settings", "active", [
      ["owner", "owner"],
      ["staff", "staff"],
    ]);
    await seedTenant("Locked", "read_only", [["locked-owner", "owner"]]);
  });

  test.afterAll(async () => {
    await db?.end();
  });

  async function signIn(page: Page, who: string) {
    await page.goto("/login");
    await page.getByLabel("Mobile no., user name or email").fill(login(who));
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/home$/);
  }

  /** A toast (Radix also renders a hidden copy for screen readers, so take the first). */
  const toast = (page: Page, text: string) => page.getByText(text, { exact: true }).first();

  async function expectNoSideways(page: Page) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal scroll on ${page.url()}`).toBeLessThanOrEqual(0);
  }

  test("the Owner edits the business details and manages areas", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, "owner");

    // Business details: reached from the Settings menu.
    await page.goto("/settings");
    await page
      .getByRole("navigation", { name: "Pages in Settings" })
      .getByRole("link", { name: "Business details" })
      .click();
    await expect(page).toHaveURL(/\/settings\/profile$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Business details");

    await page.getByLabel("Business name").fill(`  New   ${business("Settings")} `);
    await page.getByLabel("Office phone").fill("call me");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Please fix" })).toHaveText(
      "Please fix the boxes marked in red.",
    );
    await expect(page.getByLabel("Office phone")).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Office phone").fill("+91 98765 43210");
    await page.getByLabel("Receipt message").fill("Thank you! Pay by the 10th.");
    await page.getByLabel("Bill number start").fill("cb");
    await expect(page.getByText(/Example: CB-\d{4}-00001/)).toBeVisible();
    await page.getByRole("radio", { name: /English/ }).click();
    await page.getByRole("radio", { name: /Charge the full month/ }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Saved")).toBeVisible();
    await expect(page.getByLabel("Business name")).toHaveValue(`New ${business("Settings")}`);
    await expect(page.getByLabel("Bill number start")).toHaveValue("CB");
    // The header (every page) shows the new name.
    await expect(page.locator("header").getByText(`New ${business("Settings")}`)).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Office phone")).toHaveValue("+919876543210");
    await expect(page.getByRole("radio", { name: /Charge the full month/ })).toBeChecked();

    const row = await db.withTenant(operatorIds.Settings ?? "", (tx) =>
      tx.query.operators.findFirst({ columns: { phone: true, settings: true } }),
    );
    expect(row?.phone).toBe("+919876543210");
    expect(row?.settings).toMatchObject({
      office_phone: "+919876543210",
      receipt_footer: "Thank you! Pay by the 10th.",
      invoice_prefix: "CB",
      default_language: "en",
      mid_month_start_policy: "charge_full_month",
    });

    // Areas.
    await page.goto("/settings/areas");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Areas");
    const list = page.getByRole("list", { name: "Areas" });
    await expect(list.getByRole("listitem")).toHaveCount(1);

    await page.getByRole("button", { name: "Add area" }).click();
    let dialog = page.getByRole("dialog", { name: "Add area" });
    await dialog.getByLabel("Area name").fill("  Station   road ");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Area added")).toBeVisible();
    await expect(dialog).toBeHidden();
    await expect(list.getByText("Station road", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Add area" }).click();
    dialog = page.getByRole("dialog", { name: "Add area" });
    await dialog.getByLabel("Area name").fill("STATION ROAD");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Another area already has this name.")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();

    await page.getByRole("button", { name: "Change name: Station road" }).click();
    dialog = page.getByRole("dialog", { name: "Change area name" });
    await dialog.getByLabel("Area name").fill("Station Road East");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Name changed")).toBeVisible();
    await expect(list.getByText("Station Road East", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Hide: Old market" }).click();
    const sheet = page.getByRole("alertdialog", { name: "Hide Old market?" });
    await expect(sheet).toContainText("No customer has it.");
    await sheet.getByRole("button", { name: "Hide area" }).click();
    await expect(toast(page, "Area hidden")).toBeVisible();
    const oldMarket = list.getByRole("listitem").filter({ hasText: "Old market" });
    await expect(oldMarket).toContainText("Hidden");
    // Hidden areas go to the end of the list.
    await expect(list.getByRole("listitem").last()).toContainText("Old market");

    await page.getByRole("button", { name: "Show again: Old market" }).click();
    await expect(toast(page, "Area shown again")).toBeVisible();
    await expect(oldMarket).not.toContainText("Hidden");

    // RLS limits both reads to this tenant's rows.
    const audit = await db.withTenant(operatorIds.Settings ?? "", (tx) =>
      tx.query.auditEvents.findMany({ columns: { action: true } }),
    );
    const actions = audit.map((a) => a.action);
    for (const action of [
      "operators.update_profile",
      "areas.create",
      "areas.rename",
      "areas.archive",
      "areas.restore",
    ]) {
      expect(actions, action).toContain(action);
    }

    // Phone width: no sideways scroll, Save/Add pinned above the bottom bar.
    await page.setViewportSize(PHONE);
    for (const path of ["/settings/profile", "/settings/areas"]) {
      await page.goto(path);
      await expectNoSideways(page);
    }
  });

  test("Staff see business details and areas read-only", async ({ page }) => {
    await signIn(page, "staff");
    await page.goto("/settings/profile");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Business details");
    await expect(page.getByRole("status").filter({ hasText: "Only the owner" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);

    await page.goto("/settings/areas");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Areas");
    await expect(page.getByRole("list", { name: "Areas" }).getByRole("listitem")).not.toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Add area" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Hide|Change name|Show again/ })).toHaveCount(0);
  });

  test("a read-only Owner sees why the pages can't be changed", async ({ page }) => {
    await signIn(page, "locked-owner");
    await page.goto("/settings/profile");
    await expect(
      page.getByRole("status").filter({ hasText: "Pay for the app" }).first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await page.goto("/settings/areas");
    await expect(page.getByRole("button", { name: "Add area" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hide: Old market" })).toHaveCount(0);
  });
});
