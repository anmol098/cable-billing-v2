/**
 * Settings → Plans (T-031) against `next start` and a real, migrated database: the Owner adds a
 * plan, changes its rent (asked first: the plan's connections keep the old rent), hides it (not
 * offered when adding a connection) and shows it again; Staff and a read-only Owner see the list
 * read-only.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `settings.spec.ts`. Each run seeds
 * its own operators and users with random names.
 */
import { randomBytes } from "node:crypto";
import { hashPassword } from "@cb/core";
import {
  accounts,
  createDb,
  customers,
  type DbClient,
  operators,
  plans,
  type SubscriptionStatus,
  subscriptions,
  users,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e plans password 4321";
const PHONE = { width: 360, height: 800 };

test.describe("settings: plans", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const login = (who: string) => `e2e-plans-${who}-${run}`;
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
      await tx.insert(operators).values({ id: operatorId, name: `${name} Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status,
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      await tx
        .insert(plans)
        .values({ id: uuidv7(), operatorId, name: "Sports", monthlyAmountPaise: 40_000 });
      for (const [who, role] of people) {
        const id = uuidv7();
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${who}`,
          login: login(who),
          email: `e2e-plans-${who}-${run}@cable.test`,
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

  /** One customer with one connection on `planId` at `rentalPaise` (as T-034 would store it). */
  async function seedConnection(operatorId: string, planId: string, rentalPaise: number) {
    const assignmentId = uuidv7();
    await db.withTenant(operatorId, async (tx) => {
      const customerId = uuidv7();
      const vcAssetId = uuidv7();
      await tx
        .insert(customers)
        .values({ id: customerId, operatorId, customerCode: `P-${run}`, name: "Plan customer" });
      await tx.insert(vcAssets).values({ id: vcAssetId, operatorId, vcNumber: `PL${run}` });
      await tx.insert(vcAssignments).values({
        id: assignmentId,
        operatorId,
        vcAssetId,
        customerId,
        startDate: "2026-09-01",
        planId,
        rentalAmountPaise: rentalPaise,
      });
    });
    return assignmentId;
  }

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    await seedTenant("Plans", "active", [
      ["owner", "owner"],
      ["staff", "staff"],
    ]);
    await seedTenant("Locked plans", "read_only", [["locked-owner", "owner"]]);
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

  test("the Owner adds a plan, changes its rent, hides it and shows it again", async ({ page }) => {
    test.setTimeout(120_000);
    const operatorId = operatorIds.Plans ?? "";
    await signIn(page, "owner");

    await page.goto("/settings");
    await page
      .getByRole("navigation", { name: "Pages in Settings" })
      .getByRole("link", { name: "Plans" })
      .click();
    await expect(page).toHaveURL(/\/settings\/plans$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plans");
    const list = page.getByRole("list", { name: "Plans" });
    await expect(list.getByRole("listitem")).toHaveCount(1);

    // Add: rupees in, paise stored; a tidy name.
    await page.getByRole("button", { name: "Add plan" }).click();
    let dialog = page.getByRole("dialog", { name: "Add plan" });
    await dialog.getByLabel("Plan name").fill("  Basic   pack ");
    await dialog.getByLabel("Rent each month").fill("250");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(toast(page, "Plan added")).toBeVisible();
    await expect(dialog).toBeHidden();
    const basic = list.getByRole("listitem").filter({ hasText: "Basic pack" });
    await expect(basic).toContainText("₹250");
    await expect(basic).toContainText("No connections");
    // Cheapest first.
    await expect(list.getByRole("listitem").first()).toContainText("Basic pack");

    // The same name again (any capitals) is refused.
    await page.getByRole("button", { name: "Add plan" }).click();
    dialog = page.getByRole("dialog", { name: "Add plan" });
    await dialog.getByLabel("Plan name").fill("BASIC PACK");
    await dialog.getByLabel("Rent each month").fill("300");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog.getByText("Another plan already has this name.")).toBeVisible();
    await dialog.getByRole("button", { name: "Close" }).click();

    // RLS limits these reads to the tenant's rows.
    const plansNow = () => db.withTenant(operatorId, (tx) => tx.select().from(plans));
    const plan = (await plansNow()).find((p) => p.name === "Basic pack");
    expect(plan).toMatchObject({ monthlyAmountPaise: 25_000, status: "active" });
    const assignmentId = await seedConnection(operatorId, plan?.id ?? "", 25_000);
    await page.reload();
    await expect(basic).toContainText("1 connection");

    // A new rent: asked first, with the connection that keeps the old rent.
    await page.getByRole("button", { name: "Change: Basic pack" }).click();
    dialog = page.getByRole("dialog", { name: "Change plan" });
    await expect(dialog.getByLabel("Rent each month")).toHaveValue("250");
    await dialog.getByLabel("Rent each month").fill("300");
    await dialog.getByRole("button", { name: "Save" }).click();
    const confirm = page.getByRole("dialog", { name: "Change the rent to ₹300?" });
    await expect(confirm).toContainText(
      "1 connection is on this plan. It keeps paying ₹250 a month.",
    );
    await expect(confirm).toContainText("Bills already made do not change.");
    await confirm.getByRole("button", { name: "Save new rent" }).click();
    await expect(toast(page, "Plan saved")).toBeVisible();
    await expect(basic).toContainText("₹300");

    const repriced = (await plansNow()).find((p) => p.id === plan?.id);
    expect(repriced?.monthlyAmountPaise).toBe(30_000);
    const connection = (
      await db.withTenant(operatorId, (tx) => tx.select().from(vcAssignments))
    ).find((a) => a.id === assignmentId);
    expect(connection).toMatchObject({ planId: plan?.id, rentalAmountPaise: 25_000 });

    // Hide: its connection keeps it; it goes to the end and is not offered for new connections.
    await page.getByRole("button", { name: "Hide: Basic pack" }).click();
    const sheet = page.getByRole("alertdialog", { name: "Hide Basic pack?" });
    await expect(sheet).toContainText("Its 1 connection keeps it and its rent.");
    await sheet.getByRole("button", { name: "Hide plan" }).click();
    await expect(toast(page, "Plan hidden")).toBeVisible();
    await expect(basic).toContainText("Hidden");
    await expect(list.getByRole("listitem").last()).toContainText("Basic pack");

    await page.goto("/customers/new");
    await page.getByLabel("Name").fill("Plan check");
    await page.getByRole("button", { name: "Next" }).click();
    const rent = page.getByLabel("Monthly rent");
    await expect(rent.locator("option", { hasText: "Sports · ₹400" })).toHaveCount(1);
    await expect(rent.locator("option", { hasText: "Basic pack" })).toHaveCount(0);

    await page.goto("/settings/plans");
    await page.getByRole("button", { name: "Show again: Basic pack" }).click();
    await expect(toast(page, "Plan shown again")).toBeVisible();
    await expect(basic).not.toContainText("Hidden");

    // RLS limits this read to the tenant's rows.
    const audit = await db.withTenant(operatorId, (tx) =>
      tx.query.auditEvents.findMany({ columns: { action: true } }),
    );
    const actions = audit.map((a) => a.action);
    for (const action of ["plans.create", "plans.update", "plans.retire", "plans.restore"]) {
      expect(actions, action).toContain(action);
    }

    // Phone width: no sideways scroll.
    await page.setViewportSize(PHONE);
    await page.goto("/settings/plans");
    await expect(page.getByRole("button", { name: "Add plan" })).toBeVisible();
    await expectNoSideways(page);
  });

  test("Staff see the plans read-only", async ({ page }) => {
    await signIn(page, "staff");
    await page.goto("/settings/plans");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Plans");
    await expect(page.getByRole("status").filter({ hasText: "Only the owner" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Plans" }).getByRole("listitem")).not.toHaveCount(
      0,
    );
    await expect(page.getByRole("button", { name: "Add plan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^(Hide|Change|Show again): / })).toHaveCount(0);
  });

  test("a read-only Owner sees why plans can't be changed", async ({ page }) => {
    await signIn(page, "locked-owner");
    await page.goto("/settings/plans");
    await expect(
      page.getByRole("status").filter({ hasText: "Pay for the app" }).first(),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Add plan" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Hide: Sports" })).toHaveCount(0);
  });
});
