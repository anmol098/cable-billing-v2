/**
 * The money reports (T-080) against `next start` and a real, migrated database. One tenant:
 *
 * - Asha (North): an old due of ₹700 brought from the old app (a bill of four months ago), this
 *   month's ₹300 bill, ₹200 paid by UPI (it goes to the old bill first) → owes ₹800: ₹300 is
 *   0–30 days old, ₹500 over 90 days.
 * - Bina (South): this month's ₹400 bill, ₹1,000 cash → ₹600 credit.
 *
 * This month's bills are made by the real billing run and job worker; payments by T-046's
 * service. The Owner opens each report from the Reports menu and uses its filters; Staff can open
 * them too, and they fit a 360 px phone.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `bills.spec.ts`.
 */
import { randomBytes } from "node:crypto";
import {
  billingRunJob,
  createJobRegistry,
  createServiceRuntime,
  hashPassword,
  newRequestId,
  postPayment,
  resolveTenantContext,
  runJobWorker,
  silentLogger,
  startBillingRun,
} from "@cb/core";
import {
  accounts,
  areas,
  assignmentEvents,
  createDb,
  customerBalances,
  customers,
  type DbClient,
  invoices,
  ledgerEntries,
  operators,
  subscriptions,
  users,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { addDays, addPeriods, businessDateOf, istStartOfDay, periodOfInstant } from "@cb/domain";
import { type Browser, expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e reports password 4321";

test.describe("reports: dues and ageing, bill register", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const ownerLogin = `e2e-reports-owner-${run}`;
  const staffLogin = `e2e-reports-staff-${run}`;
  const period = periodOfInstant(new Date());
  const oldPeriod = addPeriods(period, -4);
  const yesterday = addDays(businessDateOf(new Date()), -1);
  let db: DbClient;
  let operatorId: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const runtime = createServiceRuntime({ db, logger: silentLogger });
    operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    const ownerId = uuidv7();
    const asha = uuidv7();
    const bina = uuidv7();
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Reports Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const [id, login, role, name] of [
        [ownerId, ownerLogin, "owner", "E2E Owner"],
        [uuidv7(), staffLogin, "staff", "E2E Staff"],
      ] as const) {
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name,
          login,
          email: `${login}@cable.test`,
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
      const north = uuidv7();
      const south = uuidv7();
      await tx.insert(areas).values([
        { id: north, operatorId, name: "North" },
        { id: south, operatorId, name: "South" },
      ]);
      for (const [id, code, name, areaId, rent] of [
        [asha, "A-1", "Asha Devi", north, 30_000],
        [bina, "B-2", "Bina Rao", south, 40_000],
      ] as const) {
        await tx.insert(customers).values({
          id,
          operatorId,
          customerCode: code,
          name,
          areaId,
          phone: "9876543210",
        });
        const assetId = uuidv7();
        await tx.insert(vcAssets).values({ id: assetId, operatorId, vcNumber: `VC-${code}` });
        const assignmentId = uuidv7();
        await tx.insert(vcAssignments).values({
          id: assignmentId,
          operatorId,
          vcAssetId: assetId,
          customerId: id,
          startDate: period,
          status: "active",
          rentalAmountPaise: rent,
        });
        await tx.insert(assignmentEvents).values({
          id: uuidv7(),
          operatorId,
          assignmentId,
          type: "activated",
          effectiveDate: period,
        });
      }
      // Asha's old due, brought from the old app (as the migration does): a bill four months ago.
      const madeAt = istStartOfDay(addDays(oldPeriod, 4));
      const oldBill = uuidv7();
      await tx.insert(invoices).values({
        id: oldBill,
        operatorId,
        customerId: asha,
        period: oldPeriod,
        invoiceNumber: `OLD-${run}`,
        kind: "opening_balance",
        openingBalancePaise: 0,
        chargesPaise: 70_000,
        totalDuePaise: 70_000,
        issuedAt: madeAt,
        legacySource: "legacy",
        legacyId: `a1-${run}`,
      });
      await tx.insert(ledgerEntries).values({
        id: uuidv7(),
        operatorId,
        customerId: asha,
        type: "opening_balance",
        amountPaise: 70_000,
        invoiceId: oldBill,
        at: madeAt,
      });
      await tx.insert(customerBalances).values({
        customerId: asha,
        operatorId,
        balancePaise: 70_000,
        oldestDuePeriod: oldPeriod,
      });
    });

    const owner = await resolveTenantContext(runtime, {
      userId: ownerId,
      channel: "web",
      requestId: newRequestId(),
    });
    if (!owner.ok) throw new Error(`owner context: ${owner.error.code}`);
    const started = await startBillingRun.call(runtime, owner.value, { period });
    if (!started.ok) throw new Error(`billing run: ${started.error.code}`);
    const report = await runJobWorker({
      db,
      registry: createJobRegistry([billingRunJob]),
      logger: silentLogger,
    });
    expect(report.failed).toBe(0);
    for (const [customerId, amountPaise, method] of [
      [asha, 20_000, "upi"],
      [bina, 100_000, "cash"],
    ] as const) {
      const paid = await postPayment.call(runtime, owner.value, {
        id: uuidv7(),
        customerId,
        amountPaise,
        method,
        ...(method === "upi" ? { upiReference: "123456789012" } : {}),
      });
      if (!paid.ok) throw new Error(`payment: ${paid.error.code}`);
    }
  });

  test.afterAll(async () => {
    await db?.end();
  });

  async function signIn(page: Page, login: string) {
    await page.goto("/login");
    await page.getByLabel("Mobile no., user name or email").fill(login);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/home$/);
  }

  async function signedIn(browser: Browser, login: string): Promise<Page> {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, login);
    return page;
  }

  test("the Owner reads the dues and ageing, filters it, and looks back to yesterday", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signIn(page, ownerLogin);
    await page.goto("/reports");
    await page.getByRole("link", { name: "Due list" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Due list");
    await expect(page.getByTestId("as-of")).toContainText("Numbers as of");

    const totals = page.getByTestId("dues-totals");
    await expect(totals.getByTestId("dues-totals-due")).toContainText("₹800");
    await expect(totals.getByTestId("dues-totals-due")).toContainText("1 customer");
    await expect(totals.getByTestId("dues-totals-credit")).toContainText("₹600");
    await expect(totals.getByTestId("dues-totals-net")).toContainText("₹200");
    await expect(page.getByTestId("bucket-d0_30-amount")).toHaveText("₹300");
    await expect(page.getByTestId("bucket-d90_plus-amount")).toHaveText("₹500");
    await expect(page.getByTestId("bucket-d31_60-amount")).toHaveText("₹0");

    const byArea = page.getByRole("table", { name: "Due by area" });
    await expect(byArea.getByRole("row")).toHaveCount(4);
    await expect(byArea.getByRole("row").nth(1)).toContainText("North₹800 due · 1 customer");
    await expect(byArea.getByRole("row").nth(3)).toContainText("Total₹800 due · 1 customer");

    const list = page.getByRole("table", { name: "Customers who owe" });
    await expect(list.getByRole("row")).toHaveCount(2);
    await expect(list.getByRole("row").nth(1)).toContainText("Asha Devi");
    await expect(list.getByRole("row").nth(1)).toContainText("₹800");
    await expect(list.getByRole("row").nth(1)).toContainText("Over 90 days");
    await expect(page.getByTestId("dues-list-totals-amount")).toContainText("₹800");

    // Over 90 days only → still Asha.
    await page.getByTestId("bucket-d90_plus").click();
    await expect(page).toHaveURL(/age=d90_plus/);
    const old = page.getByRole("table", { name: "Customers who owe" });
    await expect(old).toContainText("Asha");
    // The list shows the over-90-days part, and its total equals the card.
    await expect(old.getByRole("row").nth(1)).toContainText("₹500of ₹800 due");
    await expect(page.getByTestId("dues-list-totals-amount")).toContainText("₹500");

    // South: nobody owes; then the customers with credit.
    await page.goto("/reports/dues");
    await page.getByRole("combobox", { name: /^Area/ }).selectOption({ label: "South" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/area=/);
    await expect(page.getByText("Nobody owes money here.")).toBeVisible();
    await expect(page.getByTestId("dues-totals-credit")).toContainText("₹600");
    await page.getByRole("combobox", { name: /^Show/ }).selectOption("advance");
    await page.getByRole("button", { name: "Show" }).click();
    const credit = page.getByRole("table", { name: "Customers with credit" });
    await expect(credit.getByRole("row").nth(1)).toContainText("Bina Rao");
    await expect(credit.getByRole("row").nth(1)).toContainText("₹600");

    // As of the end of yesterday: only the old ₹700 due (nothing of today counts).
    await page.goto("/reports/dues");
    await page.locator('input[type="date"][name="date"]').fill(yesterday);
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(new RegExp(`date=${yesterday}`));
    await expect(page.getByTestId("as-of")).toContainText("Numbers as of the end of");
    await expect(page.getByTestId("dues-totals-due")).toContainText("₹700");
    await expect(page.getByTestId("dues-totals-credit")).toContainText("₹0");
    await expect(page.getByTestId("bucket-d90_plus-amount")).toHaveText("₹700");

    // A row opens the customer.
    await page.goto("/reports/dues");
    await page.getByRole("table", { name: "Customers who owe" }).getByRole("link").first().click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
  });

  test("the Owner reads the bill register over months, filters it and opens a bill", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signIn(page, ownerLogin);
    await page.goto("/reports");
    await page.getByRole("link", { name: "Bills report" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bills report");
    await expect(page.getByTestId("as-of")).toContainText("Numbers as of");
    // Default: the last three months (this month's two bills).
    await expect(page.getByTestId("bills-totals-count")).toContainText("2 bills");
    await expect(page.getByTestId("bills-totals-billed")).toContainText("₹700");

    await page.getByRole("combobox", { name: /^From month/ }).selectOption(oldPeriod);
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(new RegExp(`from=${oldPeriod}`));
    await expect(page.getByTestId("bills-totals-count")).toContainText("3 bills");
    await expect(page.getByTestId("bills-totals-billed")).toContainText("₹1,400");
    await expect(page.getByTestId("bills-totals-paid")).toContainText("₹600");
    await expect(page.getByTestId("bills-totals-due")).toContainText("₹800");
    const table = page.getByRole("table", { name: "Bills" });
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(table).toContainText("Old due");

    await page.getByRole("combobox", { name: /^Paid\?/ }).selectOption("unpaid");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page.getByTestId("bills-totals-count")).toContainText("1 bill");
    await expect(page.getByTestId("bills-totals-billed")).toContainText("₹300");
    await page.getByRole("table", { name: "Bills" }).getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Bill /);
  });

  test("Staff can open the reports; they fit a phone", async ({ browser }) => {
    test.setTimeout(90_000);
    const staff = await signedIn(browser, staffLogin);
    await staff.setViewportSize({ width: 360, height: 800 });
    for (const [path, title] of [
      ["/reports/dues", "Due list"],
      [`/reports/bills?from=${oldPeriod}&to=${period}`, "Bills report"],
    ] as const) {
      await staff.goto(path);
      await expect(staff.getByRole("heading", { level: 1 })).toHaveText(title);
      const overflow = await staff.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await expect(staff.getByTestId("bills-totals-due")).toContainText("₹800");
    await staff.context().close();
  });
});
