/**
 * The Owner's back-dated new connection (T-045a) against `next start` and a real, migrated
 * database. The customer's bills for last month and this month are made; the business charges a
 * new connection's first month in full (D-18 `charge_full_month`).
 * - Staff: "Add connection" with a start day last month is refused ("Bills for … are already
 *   made"); nothing is saved.
 * - Owner: the same start day shows each month's effect with the numbers ("₹300 extra will be
 *   added to the next bill", twice; "In all: ₹600 more to pay."), asks why (saving without a reason
 *   is refused), then saves; the connection is on the tab and both bill changes are in Bills → Bill
 *   changes as "Next bill" with the reason.
 * - The form fits a 360px phone.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `adjustments.spec.ts`. Each seed
 * uses `newSeedId()`; dates are today's IST date (the server's real clock).
 */
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
  parseOperatorSettings,
  plans,
  subscriptions,
  users,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import {
  businessDate,
  businessDateOf,
  formatBusinessDate,
  type Period,
  periodLabel,
  periodOf,
  previousPeriod,
} from "@cb/domain";
import { expect, type Page, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e backdated add password 4321";
const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

test.describe("back-dated new connection", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");
  test.describe.configure({ mode: "serial" });

  let db: DbClient;
  let seed = "";
  let customerId = "";
  const login = (who: string) => `e2e-bda-${who}-${seed}`;
  const today = businessDateOf(new Date());
  const current = periodOf(today);
  const previous = previousPeriod(current);
  const started = previousPeriod(previous);
  /** The 10th of last month: a day in a month whose bills are made. */
  const backDay = businessDate(`${previous.slice(0, 8)}10`);
  const month = (p: Period) => periodLabel(p, "en", "long");

  test.beforeAll(async () => {
    seed = newSeedId();
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const operatorId = uuidv7();
    customerId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({
        id: operatorId,
        name: `Godavari Cable ${seed}`,
        settings: parseOperatorSettings({ mid_month_start_policy: "charge_full_month" }),
      });
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
          email: `e2e-bda-${role}-${seed}@cable.test`,
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
      await tx.insert(plans).values({
        id: uuidv7(),
        operatorId,
        name: "Basic",
        monthlyAmountPaise: 30_000,
      });
      await tx.insert(customers).values({
        id: customerId,
        operatorId,
        customerCode: `B-${seed}`,
        name: "Lakshmi Bai",
      });
      const assetId = uuidv7();
      const assignmentId = uuidv7();
      await tx.insert(vcAssets).values({ id: assetId, operatorId, vcNumber: `77${seed}11` });
      await tx.insert(vcAssignments).values({
        id: assignmentId,
        operatorId,
        vcAssetId: assetId,
        customerId,
        startDate: started,
        status: "active",
        rentalAmountPaise: 40_000,
      });
      await tx.insert(assignmentEvents).values({
        id: uuidv7(),
        operatorId,
        assignmentId,
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
          customerId,
          period: p,
          invoiceNumber: `INV-${p.slice(2, 4)}${p.slice(5, 7)}-${seed.slice(0, 4)}${i}`,
          openingBalancePaise: opening,
          chargesPaise: 40_000,
          totalDuePaise: opening + 40_000,
        });
        await tx.insert(invoiceLines).values({
          id: uuidv7(),
          operatorId,
          invoiceId,
          type: "rent",
          assignmentId,
          amountPaise: 40_000,
        });
        await tx.insert(ledgerEntries).values({
          id: uuidv7(),
          operatorId,
          customerId,
          type: "invoice",
          amountPaise: 40_000,
          invoiceId,
        });
        opening += 40_000;
      }
      await tx.insert(customerBalances).values({
        operatorId,
        customerId,
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

  const form = (page: Page) => page.locator("[data-form=add-connection]");
  const tab = () => `/customers/${customerId}/connections`;

  async function fillConnection(page: Page, vc: string) {
    await form(page).getByLabel("VC number").fill(vc);
    await form(page).getByLabel("Monthly rent").selectOption({ label: "Basic · ₹300" });
    await form(page).getByLabel("Start day").fill(backDay);
  }

  test("Staff are refused; the Owner sees each month's effect, gives a reason and saves", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(DESKTOP);
    const staffVc = `66${seed}22`;
    const ownerVc = `55${seed}33`;

    // Staff: a start day last month is refused; nothing is saved.
    await signIn(page, "staff");
    await page.goto(`${tab()}?add=1`);
    await fillConnection(page, staffVc);
    await expect(form(page).getByLabel("Why are you changing old bills?")).toHaveCount(0);
    await form(page).getByRole("button", { name: "Save connection" }).click();
    await expect(form(page)).toContainText(`Bills for ${month(current)} are already made.`);
    await page.goto(tab());
    await expect(page.locator(`[data-connection][data-vc="${staffVc}"]`)).toHaveCount(0);
    await page.context().clearCookies();

    // Owner: the effect month by month, then the reason.
    await signIn(page, "owner");
    await page.goto(`${tab()}?add=1`);
    await fillConnection(page, ownerVc);
    await expect(form(page)).toContainText(
      `New connection: ₹300 a month from ${formatBusinessDate(backDay, "en")}.`,
    );
    for (const p of [previous, current]) {
      await expect(form(page).locator(`[data-effect-month="${p}"]`)).toHaveText(
        `${month(p)}: ₹300 extra will be added to the next bill.`,
      );
    }
    await expect(form(page)).toContainText("In all: ₹600 more to pay.");
    await expect(form(page)).toContainText(`Bills up to ${month(current)} are already made.`);

    // Saving without a reason is refused.
    const save = form(page).getByRole("button", { name: "Save with bill changes" });
    await save.click();
    await expect(form(page)).toContainText("Write why (at least 3 letters).");
    await form(page)
      .getByLabel("Why are you changing old bills?")
      .fill("Box fitted last month, entered late");
    await save.click();
    await expect(page).toHaveURL(new RegExp(`${tab()}$`));
    await expect(page.getByText("Saved. The bill changes are made.").first()).toBeVisible();
    await expect(page.locator(`[data-connection][data-vc="${ownerVc}"]`)).toContainText(
      "₹300 a month",
    );

    // Bills → Bill changes: both months, waiting for the next bill, with the reason.
    await page.goto("/bills/adjustments");
    await expect(page.locator("[data-direction=debit]:visible")).toHaveCount(2);
    await expect(
      page.getByText("Box fitted last month, entered late").filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByText("Next bill", { exact: true }).filter({ visible: true }).first(),
    ).toBeVisible();
    await expect(page.getByTestId("adjustments-pending")).toContainText("₹600");
  });

  test("the Owner's add form with its effect fits a phone", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(PHONE);
    await signIn(page, "owner");
    await page.goto(`${tab()}?add=1`);
    await fillConnection(page, `44${seed}44`);
    await expect(form(page).locator("[data-effect-line=total]")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
