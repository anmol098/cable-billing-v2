/**
 * The same month in Hindi, on a 360px phone (T-088), against `next start` and a real, migrated
 * database: a Hindi-speaking Owner of a business that is already set up (seeded: business, trial,
 * the Owner) signs in in Hindi, adds a plan and a customer with a connection, makes the month's
 * bills, takes ₹200 cash at the counter, and Home, the bill, the customer's history and the due
 * list all say ₹100 is due. Every word is looked up in the app's own Hindi messages (no Hindi is
 * copied into the test), and no page scrolls sideways.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like bills.spec.ts.
 */
import { hashPassword } from "@cb/core";
import { accounts, createDb, type DbClient, operators, subscriptions, users, uuidv7 } from "@cb/db";
import { periodLabel, periodOfInstant } from "@cb/domain";
import { expect, test } from "@playwright/test";
import { expectNoSideways, journeyIp, runJobs, words } from "./_support/journey";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e hindi journey 4321";

test.describe("journey in Hindi on a phone", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const t = words("hi");
  const period = periodOfInstant(new Date());
  const month = periodLabel(period, "hi", "long");

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let run = "";
  let login = "";
  let db: DbClient;

  test.beforeAll(async () => {
    run = newSeedId();
    login = `e2e-hindi-owner-${run}`;
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const operatorId = uuidv7();
    const ownerId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `हिंदी केबल ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "trialing",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      await tx.insert(users).values({
        id: ownerId,
        operatorId,
        role: "owner",
        name: "सुनीता",
        login,
        email: `${login}@cable.test`,
        language: "hi",
      });
      await tx.insert(accounts).values({
        id: uuidv7(),
        userId: ownerId,
        accountId: ownerId,
        providerId: "credential",
        password: hash,
      });
    });
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("plan → customer → bills → cash at the counter → the same ₹100 due everywhere", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const context = await browser.newContext({
      viewport: { width: 360, height: 800 },
      extraHTTPHeaders: { "x-real-ip": journeyIp(run) },
    });
    const page = await context.newPage();
    const heading = page.getByRole("heading", { level: 1 });

    await test.step("sign in in Hindi", async () => {
      await page.goto("/login");
      await page.getByRole("button", { name: t("common.language_hindi") }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "hi");
      await page.getByLabel(t("auth.login.login_label")).fill(login);
      await page.getByLabel(t("auth.login.password_label"), { exact: true }).fill(PASSWORD);
      await page.getByRole("button", { name: t("auth.login.submit") }).click();
      await expect(page).toHaveURL(/\/home$/);
      await expect(page.getByRole("region", { name: t("shell.checklist.title") })).toContainText(
        t("shell.checklist.progress", { done: 0, total: 4 }),
      );
      await expectNoSideways(page);
    });

    await test.step("add a plan", async () => {
      await page.goto("/settings/plans");
      await expect(heading).toHaveText(t("shell.routes.settings_plans"));
      await page
        .getByRole("button", { name: t("plans.add") })
        .first()
        .click();
      const dialog = page.getByRole("dialog", { name: t("plans.add_title") });
      await dialog.getByLabel(t("plans.name_label")).fill("बेसिक");
      await dialog.getByLabel(t("plans.amount_label")).fill("300");
      await dialog.getByRole("button", { name: t("plans.save") }).click();
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("list", { name: t("plans.list_label") })).toContainText("बेसिक");
      await expectNoSideways(page);
    });

    let customerUrl = "";
    await test.step("add a customer with a connection from the 1st", async () => {
      await page.goto("/customers/new");
      await expect(
        page.getByText(t("customers.new.progress", { current: 1, total: 3 })),
      ).toBeVisible();
      await page.getByLabel(t("customers.field.name"), { exact: true }).fill("रमेश कुमार");
      await page.getByLabel(t("customers.field.phone"), { exact: true }).fill("98111 22233");
      await page.getByRole("button", { name: t("common.next") }).click();
      await expect(
        page.getByText(t("customers.new.progress", { current: 2, total: 3 })),
      ).toBeVisible();
      await page.getByLabel(t("connections.form.vc_label")).fill(`H1-${run}`);
      await page.getByLabel(t("connections.form.rent_label")).selectOption({
        label: t("connections.form.plan_option", { name: "बेसिक", amount: "300" }),
      });
      await page.getByLabel(t("connections.form.start_label")).fill(period);
      await page.getByRole("button", { name: t("common.next") }).click();
      await expectNoSideways(page);
      await page.getByRole("button", { name: t("customers.new.save") }).click();
      await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
      await expect(heading).toHaveText("रमेश कुमार");
      customerUrl = new URL(page.url()).pathname;
    });

    await test.step("make the month's bills", async () => {
      await page.goto("/bills");
      await page.getByRole("link", { name: t("bills.this_month.preview") }).click();
      await expect(page.getByTestId("preview-will-bill")).toHaveText(
        t("bills.preview.will_bill", { count: 1 }),
      );
      await expect(page.getByTestId("preview-total")).toHaveText("₹300");
      await expectNoSideways(page);
      await page.getByRole("button", { name: t("bills.run.button") }).click();
      await page
        .getByRole("alertdialog", { name: t("bills.run.confirm_title", { month }) })
        .getByRole("button", { name: t("bills.run.confirm"), exact: true })
        .click();
      await expect(page.getByTestId("run-summary")).toContainText(
        t("bills.status.in_progress", { month }),
      );
      await runJobs(db);
      await expect(page.getByTestId("run-summary")).toContainText(
        t("bills.status.completed", { month }),
        { timeout: 20_000 },
      );
      await expect(page.getByTestId("run-created")).toHaveText("1");
    });

    await test.step("₹200 cash at the counter", async () => {
      await page.goto(customerUrl);
      await page
        .getByRole("link", { name: t("customers.profile.take_payment") })
        .first()
        .click();
      await expect(page.getByTestId("due-now")).toHaveText("₹300");
      await page.getByRole("textbox", { name: t("payments.new.amount_label") }).fill("200");
      await page.getByRole("button", { name: t("payments.new.next") }).click();
      await page.getByRole("button", { name: t("payments.method.cash") }).click();
      await expect(page.getByTestId("confirm-summary")).toHaveText(
        t("payments.new.confirm_summary", {
          amount: "₹200",
          method: t("payments.method.cash"),
          name: "रमेश कुमार",
        }),
      );
      await expectNoSideways(page);
      await page.getByTestId("save-payment").click();
      await expect(
        page.getByRole("heading", { name: t("payments.new.saved_title") }),
      ).toBeVisible();
      await expect(page.getByTestId("saved-balance")).toHaveText(
        t("payments.balance.due", { amount: "100" }),
      );
    });

    await test.step("Home, the bill, the history and the due list agree: ₹100 due", async () => {
      await page.goto("/home");
      await expect(page.getByRole("region", { name: t("shell.checklist.title") })).toContainText(
        t("shell.checklist.progress", { done: 2, total: 4 }),
      );
      await expect(page.getByTestId("home-cash-today")).toContainText(
        `${t("home.today.cash")}₹200`,
      );
      await expect(page.getByTestId("home-billed")).toContainText(
        `${t("home.month.billed")}₹300${t("home.month.bill_count", { count: 1 })}`,
      );
      await expect(page.getByTestId("home-collected")).toContainText(
        `${t("home.month.collected")}₹200`,
      );
      await expect(page.getByTestId("home-due")).toContainText(
        `${t("home.due.title")}₹100${t("home.due.customers", { count: 1 })}`,
      );
      await expectNoSideways(page);

      await page.goto(`${customerUrl}/bills`);
      await expect(page.getByTestId("bills-due")).toContainText("₹100");
      // On a phone the bills are a list of cards, not a table.
      await page
        .getByRole("list", { name: t("statements.bills.caption") })
        .getByRole("link", { name: month })
        .click();
      await expect(page.getByTestId("bill-charges")).toHaveText("₹300");
      await expect(page.getByTestId("bill-paid")).toHaveText("₹200");
      await expect(page.getByTestId("bill-outstanding")).toHaveText("₹100");
      await expectNoSideways(page);

      await page.goto(`${customerUrl}/history`);
      await expect(
        page.getByRole("heading", { level: 2, name: t("statements.history.title") }),
      ).toBeVisible();
      await expect(page.getByTestId("statement-closing")).toContainText("₹100");
      await expectNoSideways(page);

      await page.goto("/reports/dues");
      await expect(heading).toHaveText(t("shell.routes.reports_dues"));
      await expect(page.getByTestId("dues-totals-due")).toContainText("₹100");
      await expect(page.getByTestId("bucket-d0_30-amount")).toHaveText("₹100");
      await expectNoSideways(page);
    });
    await context.close();
  });
});
