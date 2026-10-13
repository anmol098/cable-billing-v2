/**
 * Customer Bills and History tabs (T-049) against `next start` and a real, migrated database. One
 * tenant whose customer has this month's bill (the real billing run and job worker), a cash
 * payment, and a UPI payment the Owner undid (T-046 services, called here as the app would).
 *
 * Open the customer → Bills tab (the bill, part paid) → History tab (every line with its balance,
 * the cancelled payment and its reason, the closing balance = the customer's balance) → the
 * printable statement (operator's language) → another tenant's customer is a 404 → phone width.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `shell.spec.ts`.
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
  reversePayment,
  runJobWorker,
  silentLogger,
  startBillingRun,
} from "@cb/core";
import {
  accounts,
  assignmentEvents,
  createDb,
  customerBalances,
  customers,
  type DbClient,
  operators,
  subscriptions,
  users,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { periodLabel, periodOfInstant } from "@cb/domain";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e statement password 4321";

test.describe("customer bills and history", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const ownerLogin = `e2e-stmt-owner-${run}`;
  const staffLogin = `e2e-stmt-staff-${run}`;
  const period = periodOfInstant(new Date());
  const month = periodLabel(period, "en", "long");
  const customerId = uuidv7();
  const otherCustomerId = uuidv7();
  let db: DbClient;
  let operatorId: string;

  async function seedOperator(id: string, name: string, people: [string, "owner" | "staff"][]) {
    const hash = await hashPassword(PASSWORD);
    const userIds: Record<string, string> = {};
    await db.withTenant(id, async (tx) => {
      await tx.insert(operators).values({ id, name: `${name} ${run}` });
      await tx.insert(subscriptions).values({
        operatorId: id,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const [login, role] of people) {
        const userId = uuidv7();
        userIds[login] = userId;
        await tx.insert(users).values({
          id: userId,
          operatorId: id,
          role,
          name: `E2E ${role}`,
          login,
          email: `${login}@cable.test`,
          language: "en",
        });
        await tx.insert(accounts).values({
          id: uuidv7(),
          userId,
          accountId: userId,
          providerId: "credential",
          password: hash,
        });
      }
    });
    return userIds;
  }

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    operatorId = uuidv7();
    const people = await seedOperator(operatorId, "Statement Cable", [
      [ownerLogin, "owner"],
      [staffLogin, "staff"],
    ]);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(customers).values({
        id: customerId,
        operatorId,
        customerCode: "S-1",
        name: "Asha Devi",
        phone: "9876543210",
      });
      const assetId = uuidv7();
      await tx.insert(vcAssets).values({ id: assetId, operatorId, vcNumber: `VC-S1-${run}` });
      const assignmentId = uuidv7();
      await tx.insert(vcAssignments).values({
        id: assignmentId,
        operatorId,
        vcAssetId: assetId,
        customerId,
        startDate: period,
        status: "active",
        rentalAmountPaise: 50_000,
      });
      await tx.insert(assignmentEvents).values({
        id: uuidv7(),
        operatorId,
        assignmentId,
        type: "activated",
        effectiveDate: period,
      });
    });
    // Another business with a customer of its own.
    const otherId = uuidv7();
    await seedOperator(otherId, "Other Cable", []);
    await db.withTenant(otherId, (tx) =>
      tx.insert(customers).values({
        id: otherCustomerId,
        operatorId: otherId,
        customerCode: "S-1",
        name: "Other Customer",
      }),
    );

    // This month's bill (₹500), ₹200 cash, ₹100 UPI that the Owner undoes.
    const runtime = createServiceRuntime({ db, logger: silentLogger });
    const ownerId = people[ownerLogin] ?? "";
    const context = await resolveTenantContext(runtime, {
      userId: ownerId,
      channel: "web",
      requestId: newRequestId(),
    });
    if (!context.ok) throw new Error(`owner context: ${context.error.code}`);
    const owner = context.value;
    const started = await startBillingRun.call(runtime, owner, { period });
    if (!started.ok) throw new Error(`start: ${started.error.code}`);
    const report = await runJobWorker({
      db,
      registry: createJobRegistry([billingRunJob]),
      logger: silentLogger,
    });
    expect(report.failed).toBe(0);
    const cash = await postPayment.call(runtime, owner, {
      id: uuidv7(),
      customerId,
      amountPaise: 20_000,
      method: "cash",
    });
    if (!cash.ok) throw new Error(`cash: ${cash.error.code}`);
    const upiId = uuidv7();
    const upi = await postPayment.call(runtime, owner, {
      id: upiId,
      customerId,
      amountPaise: 10_000,
      method: "upi",
      upiReference: "123456789012",
    });
    if (!upi.ok) throw new Error(`upi: ${upi.error.code}`);
    const undone = await reversePayment.call(runtime, owner, {
      paymentId: upiId,
      reason: "Wrong customer",
    });
    if (!undone.ok) throw new Error(`reverse: ${undone.error.code}`);
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

  const balanceNow = async () => {
    const rows = await db.withTenant(operatorId, (tx) => tx.select().from(customerBalances));
    return rows.find((row) => row.customerId === customerId)?.balancePaise ?? 0;
  };

  test("open a customer → Bills tab → History tab with the cancelled payment → print", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    expect(await balanceNow()).toBe(30_000);
    await signIn(page, ownerLogin);
    await page.goto(`/customers/${customerId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Asha Devi");
    const tabs = page.getByRole("navigation", { name: "Customer pages" });

    // Bills tab.
    await tabs.getByRole("link", { name: "Bills" }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${customerId}/bills$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Asha Devi");
    await expect(page.getByTestId("bills-due")).toContainText("₹300");
    await expect(page.getByText("1 bill", { exact: true })).toBeVisible();
    await expect(page.getByTestId("bills-billed")).toHaveText("₹500");
    await expect(page.getByTestId("bills-paid")).toHaveText("₹200");
    const table = page.getByRole("table", { name: "Bills of this customer" });
    await expect(table.getByRole("row")).toHaveCount(2);
    await expect(table.getByRole("row").nth(1)).toContainText(month);
    await expect(table.getByTestId("bill-pay-state")).toHaveText("Part paid");

    // History tab: every line, the cancelled payment with its reason, balance = the customer's.
    await tabs.getByRole("link", { name: "History" }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${customerId}/history$`));
    await expect(page.getByRole("heading", { level: 2, name: "Account history" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Last 3 months" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    const lines = page.getByTestId("statement-line");
    await expect(lines).toHaveCount(4);
    await expect(lines.nth(0)).toContainText(`Bill for ${month}`);
    await expect(lines.nth(0).getByTestId("line-amount")).toHaveText("+₹500");
    await expect(lines.nth(1)).toContainText("Paid in cash");
    await expect(lines.nth(1).getByTestId("line-balance")).toContainText("₹300");
    await expect(lines.nth(2)).toContainText("Paid by UPI");
    await expect(lines.nth(2).getByTestId("cancelled-later")).toHaveText("Cancelled later");
    await expect(lines.nth(3)).toHaveAttribute("data-type", "payment_reversal");
    await expect(lines.nth(3)).toContainText("Payment cancelled");
    await expect(lines.nth(3)).toContainText("Why: Wrong customer");
    await expect(lines.nth(3).getByTestId("line-amount")).toHaveText("+₹100");
    await expect(page.getByTestId("statement-headline")).toHaveText("Due now");
    await expect(page.getByTestId("statement-closing")).toContainText("₹300");
    await expect(page.getByTestId("sum-undone")).toContainText("+₹100");
    await expect(page.getByRole("alert")).toHaveCount(0);

    // Everything: same closing balance, no "Balance before".
    await page.getByRole("link", { name: "Everything" }).click();
    await expect(page).toHaveURL(/\?range=all$/);
    await expect(page.getByTestId("statement-closing")).toContainText("₹300");
    await expect(page.getByTestId("sum-opening")).toHaveCount(0);

    // The printable statement, in the operator's language (Hindi by default).
    const href = await page.getByRole("link", { name: "Print statement" }).getAttribute("href");
    expect(href).toBe(`/customers/${customerId}/history/print?range=all&auto=1`);
    const print = await page.request.get(String(href).replace("&auto=1", ""));
    expect(print.status()).toBe(200);
    const html = await print.text();
    expect(html).toContain('<html lang="hi">');
    expect(html).toContain("size:A4 portrait");
    expect(html).toContain("Asha Devi");
    expect(html).toContain("खाते का हिसाब");
    expect(html).toContain("पेमेंट रद्द");
    expect(html).toContain("₹300 बाकी");

    // Typed dates that make no sense fall back to the last 3 months, saying so.
    await page.goto(`/customers/${customerId}/history?from=2026-13-01`);
    await expect(page.getByRole("alert")).toContainText("Check the dates.");
    await expect(page.getByTestId("statement-line")).toHaveCount(4);

    // Another business's customer and made-up ids are 404s, tabs and print alike.
    for (const path of [
      `/customers/${otherCustomerId}/bills`,
      `/customers/${otherCustomerId}/history`,
      `/customers/${uuidv7()}/history`,
      `/customers/not-a-uuid/bills`,
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
    const otherPrint = await page.request.get(`/customers/${otherCustomerId}/history/print`);
    expect(otherPrint.status()).toBe(404);
  });

  test("Staff read both tabs; they fit a phone in English and Hindi", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await signIn(page, staffLogin);
    for (const tab of ["bills", "history"]) {
      await page.goto(`/customers/${customerId}/${tab}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Asha Devi");
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, tab).toBeLessThanOrEqual(0);
    }
    await expect(page.getByTestId("statement-line")).toHaveCount(4);
    // Hindi.
    await page
      .context()
      .addCookies([{ name: "NEXT_LOCALE", value: "hi", url: new URL(page.url()).origin }]);
    await page.reload();
    await expect(page.getByTestId("statement-headline")).toHaveText("अभी बाकी");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
