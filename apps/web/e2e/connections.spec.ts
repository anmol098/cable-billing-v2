/**
 * Connections (VC) lifecycle (T-034) against `next start` and a real, migrated database: add a
 * customer with a connection in the 3 steps, stop → start again → remove with the effect in plain
 * words, then reuse the removed VC on another customer (refused on the same day, accepted from the
 * next), with the old connection staying on the old customer. Also the phone layout and 404 for
 * another business's customer.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `customers.spec.ts`. Each run seeds
 * its own operators with random names. Dates are today's IST date (the server's real clock).
 */
import { randomBytes } from "node:crypto";
import { hashPassword } from "@cb/core";
import {
  accounts,
  createDb,
  customerBalances,
  customers,
  type DbClient,
  operators,
  plans,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import {
  addDays,
  businessDateOf,
  formatBusinessDate,
  nextPeriod,
  periodLabel,
  periodOf,
} from "@cb/domain";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e connections password 4321";
const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

test.describe("connections", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const login = (who: string) => `e2e-conn-${who}-${run}`;
  let db: DbClient;
  const ids = { asha: uuidv7(), otherTenantCustomer: uuidv7() };
  // A number unique to this run (the same VC at another operator is a different VC anyway).
  const VC = `77${run.replace(/[a-f]/g, "1").slice(0, 6)} 1122`;
  const VC_TYPED_AGAIN = VC.replace(/ /g, "-");

  async function seedTenant(
    name: string,
    people: ReadonlyArray<readonly [who: string, role: "owner" | "staff"]>,
    seed?: (
      tx: Parameters<Parameters<DbClient["withTenant"]>[1]>[0],
      operatorId: string,
    ) => Promise<void>,
  ) {
    const operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `${name} ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const [who, role] of people) {
        const id = uuidv7();
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${who}`,
          login: login(who),
          email: `e2e-conn-${who}-${run}@cable.test`,
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
      await seed?.(tx, operatorId);
    });
  }

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    await seedTenant(
      "Ganga Cable",
      [
        ["owner", "owner"],
        ["staff", "staff"],
      ],
      async (tx, operatorId) => {
        await tx.insert(plans).values([
          { operatorId, name: "Basic", monthlyAmountPaise: 25_000 },
          { operatorId, name: "Gold", monthlyAmountPaise: 45_000 },
        ]);
        await tx.insert(customers).values({
          id: ids.asha,
          operatorId,
          customerCode: "G-1",
          name: "Asha Verma",
        });
      },
    );
    await seedTenant("Yamuna Cable", [["other-owner", "owner"]], async (tx, operatorId) => {
      await tx.insert(customers).values({
        id: ids.otherTenantCustomer,
        operatorId,
        customerCode: "G-1",
        name: "Other Asha",
      });
      await tx
        .insert(customerBalances)
        .values({ operatorId, customerId: ids.otherTenantCustomer, balancePaise: 10_000 });
    });
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

  const heading = (page: Page) => page.getByRole("heading", { level: 1 });
  const card = (page: Page, vc: string) => page.locator(`[data-connection][data-vc="${vc}"]`);

  test("add with a connection; stop, start again, remove; reuse the VC on another customer", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    const today = businessDateOf(new Date());
    const tomorrow = addDays(today, 1);
    const nextMonth = periodLabel(nextPeriod(periodOf(today)), "en");
    await page.setViewportSize(DESKTOP);
    await signIn(page, "staff");

    // 1. Add customer: step 2 takes the VC and a plan; Check & save shows it.
    await page.goto("/customers/new");
    await page.getByLabel("Name").fill("Vinod Yadav");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    await page.getByLabel("VC number").fill(VC);
    await page.getByLabel("Monthly rent").selectOption({ label: "Basic · ₹250" });
    await expect(page.getByLabel("Start day")).toHaveValue(today);
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.locator("[data-check=connection]")).toContainText(
      `${VC} · ₹250 a month · from ${formatBusinessDate(today, "en")}`,
    );
    await page.getByRole("button", { name: "Save customer" }).click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
    await expect(heading(page)).toHaveText("Vinod Yadav");
    const vinodUrl = page.url();
    await expect(page.locator("[data-summary-part]").first()).toBeVisible();

    // 2. The Connections tab shows it as Active with its start in the history.
    const tabs = page.getByRole("navigation", { name: "Customer pages" });
    await tabs.getByRole("link", { name: "Connections (VC)" }).click();
    await expect(page).toHaveURL(/\/connections$/);
    await expect(heading(page)).toHaveText("Vinod Yadav");
    const vinodCard = card(page, VC);
    await expect(vinodCard).toHaveAttribute("data-status", "active");
    await expect(vinodCard).toContainText("₹250 a month");
    await expect(vinodCard).toContainText("Plan: Basic");
    await expect(vinodCard.locator("[data-event=activated]")).toContainText("Started");

    // 3. Stop: the sheet says the effect in plain words.
    await vinodCard.getByRole("button", { name: "Stop" }).click();
    let sheet = page.getByRole("alertdialog", { name: `Stop set-top box ${VC}?` });
    await expect(sheet).toContainText(`Rent stops from ${nextMonth}.`);
    await sheet.getByLabel("Why? (if you know)").selectOption({ label: "Not paying" });
    await sheet.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText("Connection stopped.", { exact: true })).toBeVisible();
    await expect(vinodCard).toHaveAttribute("data-status", "suspended");
    await expect(vinodCard).toContainText("Still on today. Stops from tomorrow.");
    await expect(vinodCard.locator("[data-event=suspended]")).toContainText("Not paying");

    // 4. Start again.
    await vinodCard.getByRole("button", { name: "Start again" }).click();
    sheet = page.getByRole("alertdialog", { name: `Start set-top box ${VC} again?` });
    await expect(sheet).toContainText(`Rent starts again from ${nextMonth}.`);
    await sheet.getByRole("button", { name: "Start again" }).click();
    await expect(page.getByText("Connection started again.", { exact: true })).toBeVisible();
    await expect(vinodCard).toHaveAttribute("data-status", "active");

    // 5. Remove: a reason is required; the VC is free from tomorrow.
    await vinodCard.getByRole("button", { name: "Remove" }).click();
    sheet = page.getByRole("alertdialog", { name: `Remove set-top box ${VC} for good?` });
    await expect(sheet).toContainText(
      `The box can go to another customer from ${formatBusinessDate(tomorrow, "en")}.`,
    );
    await sheet.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Choose a reason.", { exact: true })).toBeVisible();
    await sheet.getByLabel("Why?", { exact: true }).selectOption({ label: "Moved away" });
    await sheet.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Connection removed.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Old connections" })).toBeVisible();
    await expect(vinodCard).toHaveAttribute("data-status", "disconnected");
    await expect(vinodCard.getByRole("button")).toHaveCount(0);

    // 6. Reuse on Asha: refused today (Vinod still has it during today), accepted from tomorrow.
    await page.goto(`/customers/${ids.asha}/connections`);
    await expect(heading(page)).toHaveText("Asha Verma");
    await page.getByRole("link", { name: "Add connection" }).click();
    await expect(page).toHaveURL(/\?add=1$/);
    await page.getByLabel("VC number").fill(VC_TYPED_AGAIN);
    await page.getByLabel("Monthly rent").selectOption({ label: "Own amount" });
    await page.getByLabel("Rent (₹ a month)").fill("300");
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect(
      page.getByText(
        new RegExp(
          `This VC is with Vinod Yadav \\(code \\d+\\) until ${formatBusinessDate(today, "en")}\\. It can start here from ${formatBusinessDate(tomorrow, "en")}\\.`,
        ),
      ),
    ).toBeVisible();
    await expect(page.getByLabel("VC number")).toHaveValue(VC_TYPED_AGAIN);
    await page.getByLabel("Monthly rent").selectOption({ label: "Own amount" });
    await page.getByLabel("Rent (₹ a month)").fill("300");
    await page.getByLabel("Start day").fill(tomorrow);
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect(page.getByText("Connection added.", { exact: true })).toBeVisible();
    const ashaCard = card(page, VC);
    await expect(ashaCard).toHaveAttribute("data-status", "active");
    await expect(ashaCard).toContainText("₹300 a month");
    await expect(ashaCard).toContainText(`Starts on ${formatBusinessDate(tomorrow, "en")}.`);

    // 7. The old connection and its history stay with Vinod.
    await page.goto(`${vinodUrl}/connections`);
    await expect(card(page, VC)).toHaveAttribute("data-status", "disconnected");
    await expect(card(page, VC).locator("[data-event]")).toHaveCount(4);
  });

  test("phone (360px): the tab fits; another business's customer answers 404", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(PHONE);
    await signIn(page, "owner");
    await page.goto(`/customers/${ids.asha}/connections`);
    await expect(heading(page)).toHaveText("Asha Verma");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    const other = await page.goto(`/customers/${ids.otherTenantCustomer}/connections`);
    expect(other?.status()).toBe(404);
    const madeUp = await page.goto(`/customers/${uuidv7()}/connections`);
    expect(madeUp?.status()).toBe(404);
  });
});
