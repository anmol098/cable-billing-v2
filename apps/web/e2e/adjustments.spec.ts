/**
 * Bill changes (T-045) against `next start` and a real, migrated database:
 * - a plan change dated into a month whose bills are made: Staff see "ask the owner" and can't
 *   save; the Owner sees each month's effect with the numbers, writes why and saves; the bill
 *   changes appear in Bills → Bill changes as "Next bill";
 * - a plan change today: the effect preview ("₹… extra will be added to the next bill"), saved;
 * - the Owner's own "New bill change" (take money off, with a reason) appears as "Taken off";
 * - the list fits a 360px phone; Staff get 404 for the Owner-only pages.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `connections.spec.ts`. Each run
 * seeds its own operator with random names; the bills are seeded as the billing run stores them.
 * Dates are today's IST date (the server's real clock).
 */
import { randomBytes } from "node:crypto";
import { hashPassword } from "@cb/core";
import {
  accounts,
  assignmentEvents,
  createDb,
  customerBalances,
  customers,
  type DbClient,
  invoiceLines,
  invoices,
  ledgerEntries,
  operators,
  plans,
  subscriptions,
  users,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { businessDateOf, periodLabel, periodOf, previousPeriod } from "@cb/domain";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e adjustments password 4321";
const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

test.describe("bill changes", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");
  test.describe.configure({ mode: "serial" });

  const run = randomBytes(4).toString("hex");
  const login = (who: string) => `e2e-adj-${who}-${run}`;
  let db: DbClient;
  const ids = { meena: uuidv7(), assignment: uuidv7(), gold: uuidv7() };
  const VC = `88${run.replace(/[a-f]/g, "2").slice(0, 6)}3344`;
  const today = businessDateOf(new Date());
  const current = periodOf(today);
  const previous = previousPeriod(current);
  const started = previousPeriod(previous);
  const month = (p: typeof current) => periodLabel(p, "en", "long");

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Narmada Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const role of ["owner", "staff"] as const) {
        const id = uuidv7();
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${role}`,
          login: login(role),
          email: `e2e-adj-${role}-${run}@cable.test`,
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
      const basic = uuidv7();
      await tx.insert(plans).values([
        { id: basic, operatorId, name: "Basic", monthlyAmountPaise: 40_000 },
        { id: ids.gold, operatorId, name: "Gold", monthlyAmountPaise: 45_000 },
      ]);
      await tx.insert(customers).values({
        id: ids.meena,
        operatorId,
        customerCode: `M-${run}`,
        name: "Meena Devi",
      });
      const assetId = uuidv7();
      await tx.insert(vcAssets).values({ id: assetId, operatorId, vcNumber: VC });
      await tx.insert(vcAssignments).values({
        id: ids.assignment,
        operatorId,
        vcAssetId: assetId,
        customerId: ids.meena,
        startDate: started,
        status: "active",
        planId: basic,
        rentalAmountPaise: 40_000,
      });
      await tx.insert(assignmentEvents).values({
        id: uuidv7(),
        operatorId,
        assignmentId: ids.assignment,
        type: "activated",
        effectiveDate: started,
        at: new Date(`${started}T06:00:00Z`),
      });
      // Last month's and this month's bills, stored as the billing run stores them.
      let opening = 0;
      for (const [i, p] of [previous, current].entries()) {
        const invoiceId = uuidv7();
        await tx.insert(invoices).values({
          id: invoiceId,
          operatorId,
          customerId: ids.meena,
          period: p,
          invoiceNumber: `INV-${p.slice(2, 4)}${p.slice(5, 7)}-${run.slice(0, 4)}${i}`,
          openingBalancePaise: opening,
          chargesPaise: 40_000,
          totalDuePaise: opening + 40_000,
        });
        await tx.insert(invoiceLines).values({
          id: uuidv7(),
          operatorId,
          invoiceId,
          type: "rent",
          assignmentId: ids.assignment,
          amountPaise: 40_000,
        });
        await tx.insert(ledgerEntries).values({
          id: uuidv7(),
          operatorId,
          customerId: ids.meena,
          type: "invoice",
          amountPaise: 40_000,
          invoiceId,
        });
        opening += 40_000;
      }
      await tx.insert(customerBalances).values({
        operatorId,
        customerId: ids.meena,
        balancePaise: 80_000,
        oldestDuePeriod: previous,
      });
    });
  });

  test.afterAll(async () => {
    await db?.end();
  });

  async function signIn(page: Page, who: "owner" | "staff") {
    await page.goto("/login");
    await page.getByLabel("Mobile no., user name or email").fill(login(who));
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/home$/);
  }

  const form = (page: Page) => page.locator("[data-change-form]");
  const tab = `/customers/${ids.meena}/connections`;

  test("Staff can't change a billed month; the Owner does it with a reason and sees it in Bill changes", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(DESKTOP);

    // Staff: the preview says the month is billed; saving is not possible.
    await signIn(page, "staff");
    await page.goto(tab);
    await page
      .locator(`[data-connection][data-vc="${VC}"]`)
      .getByRole("link", { name: "Change plan" })
      .click();
    await expect(page).toHaveURL(/\?change=/);
    await form(page).getByLabel("New plan").selectOption({ label: "Gold · ₹450" });
    await form(page).getByLabel("From which day?").fill(previous);
    await expect(form(page)).toContainText("Ask the owner to change it from this day.");
    await expect(form(page).getByRole("button", { name: "Save new plan" })).toBeDisabled();
    const staffList = await page.goto("/bills/adjustments");
    expect(staffList?.status()).toBe(404);
    const staffNew = await page.goto("/bills/adjustments/new");
    expect(staffNew?.status()).toBe(404);
    await page.context().clearCookies();

    // Owner: each billed month gets ₹50 extra, with a reason.
    await signIn(page, "owner");
    await page.goto(`${tab}?change=${ids.assignment}`);
    await form(page).getByLabel("New plan").selectOption({ label: "Gold · ₹450" });
    await form(page).getByLabel("From which day?").fill(previous);
    await expect(form(page)).toContainText("New rent: ₹450 a month (was ₹400).");
    await expect(form(page)).toContainText(
      `${month(previous)}: ₹50 extra will be added to the next bill.`,
    );
    await expect(form(page)).toContainText(
      `${month(current)}: ₹50 extra will be added to the next bill.`,
    );
    await expect(form(page)).toContainText("In all: ₹100 more to pay.");
    const save = form(page).getByRole("button", { name: "Save with bill changes" });
    await expect(save).toBeDisabled();
    await form(page)
      .getByLabel("Why are you changing old bills?")
      .fill("Upgraded last month, entered late");
    await save.click();
    await expect(page).toHaveURL(new RegExp(`${tab}$`));
    await expect(page.getByText("Saved. The bill changes are made.").first()).toBeVisible();
    await expect(page.locator(`[data-connection][data-vc="${VC}"]`)).toContainText("₹450 a month");

    // Bills → Bill changes: two rows waiting for the next bill, with the reason.
    await page.goto("/bills/adjustments");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bill changes");
    const rows = page.locator("[data-direction=debit]:visible");
    await expect(rows).toHaveCount(2);
    await expect(
      page.getByText("Upgraded last month, entered late").filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Next bill", { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("adjustments-pending")).toContainText("₹100");
  });

  test("Owner: a plan change today shows its effect; a new bill change takes money off", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(DESKTOP);
    await signIn(page, "owner");

    // Back to Basic today: this month's rent nets back to ₹400 (₹50 less).
    await page.goto(`${tab}?change=${ids.assignment}`);
    await form(page).getByLabel("New plan").selectOption({ label: "Basic · ₹400" });
    await expect(form(page)).toContainText(
      `${month(current)}: ₹50 less. It is taken off what the customer owes.`,
    );
    await form(page).getByRole("button", { name: "Save new plan" }).click();
    await expect(page.getByText("New plan saved.").first()).toBeVisible();
    await expect(page.locator(`[data-connection][data-vc="${VC}"]`)).toContainText("₹400 a month");

    // New bill change for Meena: take ₹100 off, with why.
    await page.goto(`/bills/adjustments/new?customer=${ids.meena}`);
    await expect(page.locator("[data-chosen-customer]")).toHaveText("Meena Devi");
    await page.getByRole("radio", { name: /Take money off/ }).click();
    await page.getByLabel("Amount (₹)").fill("100");
    await page.getByLabel("Why?").fill("Cable was cut for 10 days");
    await expect(page.locator("[data-manual-summary]")).toHaveText(
      "₹100 will be taken off what Meena Devi owes.",
    );
    await page.getByRole("button", { name: "Save bill change" }).click();
    await expect(page).toHaveURL(/\/bills\/adjustments$/);
    await expect(page.getByText("Cable was cut for 10 days").filter({ visible: true })).toHaveCount(
      1,
    );
    await expect(page.locator("[data-direction=credit]:visible")).toHaveCount(2);

    // Phone: the list fits.
    await page.setViewportSize(PHONE);
    await page.goto("/bills/adjustments");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
