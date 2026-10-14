/**
 * The Bills pages (T-047) against `next start` and a real, migrated database. One tenant with three
 * customers whose connections start on the 1st of the current IST month; one of them has a drifted
 * balance row, so the run can't bill them (a "problem").
 *
 * 1. Staff: sees the month's preview, but no "Make bills now" / "Try problems again"; and when Staff
 *    post the Owner's own Server Action by hand, the server refuses and no run is created.
 * 2. Owner: preview → Make bills now → the `billing.run` job (run here with the real worker) →
 *    the page refreshes itself to "made, some problems" → register → open the bill → printable
 *    A5 bill in the operator's language (Hindi).
 * 3. Staff after the run: sees the problems, still no Retry.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `shell.spec.ts`.
 */
import {
  billingRunJob,
  createJobRegistry,
  hashPassword,
  runJobWorker,
  silentLogger,
} from "@cb/core";
import {
  accounts,
  areas,
  assignmentEvents,
  billingRuns,
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
import { type DisplayLocale, periodLabel, periodOfInstant } from "@cb/domain";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e bills password 4321";

test.describe("bills: preview, run, register, bill", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let run = "";
  let ownerLogin = "";
  let staffLogin = "";
  const period = periodOfInstant(new Date());
  const month = (locale: DisplayLocale = "en") => periodLabel(period, locale, "long");
  let db: DbClient;
  let operatorId: string;

  test.beforeAll(async () => {
    run = newSeedId();
    ownerLogin = `e2e-bills-owner-${run}`;
    staffLogin = `e2e-bills-staff-${run}`;
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    const drifted = uuidv7();
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Bills Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const [login, role, name] of [
        [ownerLogin, "owner", "E2E Owner"],
        [staffLogin, "staff", "E2E Staff"],
      ] as const) {
        const id = uuidv7();
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
      const areaId = uuidv7();
      await tx.insert(areas).values({ id: areaId, operatorId, name: "North" });
      const addCustomer = async (id: string, code: string, name: string, rents: number[]) => {
        await tx.insert(customers).values({
          id,
          operatorId,
          customerCode: code,
          name,
          areaId,
          phone: "9876543210",
        });
        for (const [index, rent] of rents.entries()) {
          const assetId = uuidv7();
          await tx
            .insert(vcAssets)
            .values({ id: assetId, operatorId, vcNumber: `VC-${code}-${index + 1}` });
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
      };
      await addCustomer(uuidv7(), "A-1", "Asha Devi", [30_000, 20_000]);
      await addCustomer(uuidv7(), "B-2", "Bina Rao", [25_000]);
      await addCustomer(drifted, "C-3", "Chandu Lal", [10_000]);
      // A balance row that doesn't match the ledger: the run refuses to bill this customer.
      await tx
        .insert(customerBalances)
        .values({ customerId: drifted, operatorId, balancePaise: 123 });
    });
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

  const runsOf = () => db.withTenant(operatorId, (tx) => tx.select().from(billingRuns));

  test("Staff can preview but not make bills; the server refuses Staff too", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    // Capture the Owner's "Make bills now" Server Action request without letting it through.
    const owner = await signedIn(browser, ownerLogin);
    await owner.goto("/bills/runs");
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    await owner.route("**/bills/runs**", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        captured = {
          url: request.url(),
          headers: request.headers(),
          body: request.postData() ?? "",
        };
        await route.abort();
        return;
      }
      await route.continue();
    });
    await owner.getByRole("button", { name: "Make bills now" }).click();
    await owner
      .getByRole("alertdialog", { name: `Make bills for ${month()}?` })
      .getByRole("button", { name: "Make bills" })
      .click();
    await expect.poll(() => captured !== null).toBe(true);
    expect(await runsOf()).toEqual([]);

    // Staff see the preview, and no Run / Retry buttons.
    const staff = await signedIn(browser, staffLogin);
    await staff.goto("/bills");
    await staff.getByRole("link", { name: "Preview this month" }).click();
    await expect(staff).toHaveURL(/\/bills\/runs\?month=.*&preview=1$/);
    await expect(staff.getByTestId("preview-will-bill")).toHaveText("2 customers will get a bill.");
    await expect(staff.getByTestId("preview-total")).toHaveText("₹750");
    await expect(staff.getByTestId("preview-problem-count")).toHaveText("1 problem");
    await expect(staff.getByTestId("preview-problems")).toContainText("Chandu Lal");
    await expect(staff.getByTestId("preview-problems")).toContainText(
      "Account total does not match. Call support.",
    );
    await expect(staff.getByRole("button", { name: "Make bills now" })).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "Try problems again" })).toHaveCount(0);

    // Staff post the Owner's action by hand: refused, nothing created.
    const request = captured as unknown as {
      url: string;
      headers: Record<string, string>;
      body: string;
    };
    const origin = new URL(request.url).origin;
    const response = await staff.request.post(request.url, {
      headers: {
        "next-action": request.headers["next-action"] ?? "",
        "next-router-state-tree": request.headers["next-router-state-tree"] ?? "",
        "content-type": request.headers["content-type"] ?? "text/plain;charset=UTF-8",
        accept: "text/x-component",
        origin,
      },
      data: request.body,
    });
    expect(await response.text()).toContain('"error":"forbidden"');
    expect(await runsOf()).toEqual([]);
    await owner.context().close();
    await staff.context().close();
  });

  test("the Owner previews, makes the bills, opens a bill and prints it", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, ownerLogin);
    await page.goto("/bills");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bills");
    const thisMonth = page.getByTestId("month-calendar").locator(`[data-period="${period}"]`);
    await expect(thisMonth).toContainText("Not made");

    await page.getByRole("link", { name: "Preview this month" }).click();
    await expect(page.getByTestId("preview-will-bill")).toHaveText("2 customers will get a bill.");
    await page.getByRole("button", { name: "Make bills now" }).click();
    const sheet = page.getByRole("alertdialog", { name: `Make bills for ${month()}?` });
    await expect(sheet).toContainText("2 customers get a bill, total ₹750.");
    await sheet.getByRole("button", { name: "Make bills" }).click();
    await expect(page.getByText("Making bills now", { exact: true })).toBeVisible();
    await expect(page.getByTestId("run-summary")).toContainText(
      `Making bills for ${month()}. This page updates by itself.`,
    );
    const [started] = await runsOf();
    expect(started).toMatchObject({ trigger: "manual", status: "pending" });

    // The job-worker cron, run here with the real worker.
    const report = await runJobWorker({
      db,
      registry: createJobRegistry([billingRunJob]),
      logger: silentLogger,
    });
    expect(report.failed).toBe(0);

    // The page refreshes itself.
    await expect(page.getByTestId("run-summary")).toContainText(
      `Bills for ${month()} are made, but some customers have a problem.`,
      { timeout: 20_000 },
    );
    await expect(page.getByTestId("run-created")).toHaveText("2");
    await expect(page.getByTestId("run-total")).toHaveText("₹750");
    await expect(page.getByTestId("run-failed")).toHaveText("1");
    await expect(page.getByTestId("run-problems")).toContainText("Chandu Lal");
    await expect(page.getByRole("button", { name: "Try problems again" })).toBeVisible();

    await page.getByRole("link", { name: `See bills of ${month()}` }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("All bills");
    await expect(page.getByTestId("register-count")).toHaveText("2 bills");
    await expect(page.getByTestId("register-billed")).toHaveText("₹750");
    await expect(page.getByTestId("register-due")).toHaveText("₹750");
    await page
      .getByRole("link", { name: /Asha Devi/ })
      .first()
      .click();

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Bill INV-\d{4}-\d{5}$/);
    await expect(page.getByTestId("bill-connection")).toHaveCount(2);
    await expect(page.getByTestId("bill-charges")).toHaveText("₹500");
    await expect(page.getByTestId("bill-outstanding")).toHaveText("₹500");
    await expect(page.getByTestId("bill-pay-state")).toHaveText("Not paid");

    // The printable bill: A5, in the operator's language (Hindi by default).
    const printHref = await page.getByRole("link", { name: "Print bill" }).getAttribute("href");
    expect(printHref).toMatch(/\/print\?auto=1$/);
    const print = await page.request.get(String(printHref).replace("?auto=1", ""));
    expect(print.status()).toBe(200);
    const html = await print.text();
    expect(html).toContain('<html lang="hi">');
    expect(html).toContain("@page{size:A5 portrait");
    expect(html).toContain("Asha Devi");
    expect(html).toContain("महीने का किराया");
    expect(html).toContain(month("hi"));
    expect(html).toContain("₹500");

    // A made-up bill id is a 404, like another tenant's.
    const missing = await page.goto(`/bills/${uuidv7()}`);
    expect(missing?.status()).toBe(404);
  });

  test("Staff see the run's problems but no Retry; the pages fit a phone", async ({ browser }) => {
    test.setTimeout(90_000);
    const staff = await signedIn(browser, staffLogin);
    await staff.setViewportSize({ width: 360, height: 800 });
    await staff.goto("/bills/runs");
    await expect(staff.getByTestId("run-problems")).toContainText("Chandu Lal");
    await expect(staff.getByRole("button", { name: "Try problems again" })).toHaveCount(0);
    await expect(staff.getByRole("button", { name: "Make bills now" })).toHaveCount(0);
    for (const path of ["/bills", "/bills/runs", "/bills/register"]) {
      await staff.goto(path);
      const overflow = await staff.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await staff.context().close();
  });
});
