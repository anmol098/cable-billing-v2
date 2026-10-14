/**
 * The operations reports (T-081) against `next start` and a real, migrated database. One tenant:
 *
 * - Connections (from the 1st of last month): Asha (North, Basic ₹300), Bina (South, own amount
 *   ₹250, stopped effective that same day, so "Stopped" from the 2nd), Chandu (North, own amount
 *   ₹100, his account total drifted, so this month's bill run fails him).
 * - This month's bills are made by the real billing run and job worker: 1 new bill (₹300),
 *   nothing to bill for Bina, 1 problem.
 * - Today, Ravi's phone: Asha ₹300 cash, Bina ₹100 UPI, Asha ₹50 cash (undone by the Owner).
 *   Ravi hands over ₹250 (₹50 short). Staff take ₹200 cash from Asha at the counter.
 *
 * The Owner opens each report from the Reports menu and uses its filters; Staff open them with
 * filters on a 360 px phone. Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`.
 */
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
  submitHandover,
  type TenantContext,
} from "@cb/core";
import {
  accounts,
  areas,
  assignmentEvents,
  createDb,
  customerBalances,
  customers,
  type DbClient,
  devices,
  operators,
  plans,
  subscriptions,
  users,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { addDays, addPeriods, businessDateOf, periodOfInstant } from "@cb/domain";
import { type Browser, expect, type Page, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e operations password 4321";

test.describe("reports: daily collection, cash handover, connections, monthly bills", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let ownerLogin = "";
  let staffLogin = "";
  let raviId = "";
  let db: DbClient;
  const today = businessDateOf(new Date());
  const yesterday = addDays(today, -1);
  /** The connections' first day: the 1st of last month. */
  const start = addPeriods(periodOfInstant(new Date()), -1);

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    const run = newSeedId();
    ownerLogin = `e2e-ops-owner-${run}`;
    staffLogin = `e2e-ops-staff-${run}`;
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const runtime = createServiceRuntime({ db, logger: silentLogger });
    const operatorId = uuidv7();
    const ownerId = uuidv7();
    const staffId = uuidv7();
    raviId = uuidv7();
    const deviceId = uuidv7();
    const period = periodOfInstant(new Date());
    const hash = await hashPassword(PASSWORD);
    const ids = { asha: uuidv7(), bina: uuidv7(), chandu: uuidv7() };

    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Ops Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const [id, login, role, name] of [
        [ownerId, ownerLogin, "owner", "E2E Owner"],
        [staffId, staffLogin, "staff", "E2E Staff"],
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
      await tx.insert(users).values({
        id: raviId,
        operatorId,
        role: "lineman",
        name: "Ravi Kumar",
        login: `e2e-ops-ravi-${run}`,
        language: "hi",
      });
      await tx.insert(devices).values({
        id: deviceId,
        operatorId,
        userId: raviId,
        installId: uuidv7(),
        deviceCode: "R8V",
        lastSeenAt: new Date(),
      });
      const north = uuidv7();
      const south = uuidv7();
      await tx.insert(areas).values([
        { id: north, operatorId, name: "North" },
        { id: south, operatorId, name: "South" },
      ]);
      const basic = uuidv7();
      await tx
        .insert(plans)
        .values({ id: basic, operatorId, name: "Basic", monthlyAmountPaise: 30_000 });
      for (const [id, code, name, areaId, planId, rent, stopped] of [
        [ids.asha, "A-1", "Asha Devi", north, basic, 30_000, false],
        [ids.bina, "B-2", "Bina Rao", south, null, 25_000, true],
        [ids.chandu, "C-3", "Chandu", north, null, 10_000, false],
      ] as const) {
        await tx.insert(customers).values({ id, operatorId, customerCode: code, name, areaId });
        const assetId = uuidv7();
        await tx.insert(vcAssets).values({ id: assetId, operatorId, vcNumber: `VC${run}${code}` });
        const assignmentId = uuidv7();
        await tx.insert(vcAssignments).values({
          id: assignmentId,
          operatorId,
          vcAssetId: assetId,
          customerId: id,
          startDate: start,
          status: stopped ? "suspended" : "active",
          planId,
          rentalAmountPaise: rent,
        });
        const at = Date.now() - 60_000;
        await tx.insert(assignmentEvents).values({
          id: uuidv7(),
          operatorId,
          assignmentId,
          type: "activated",
          effectiveDate: start,
          at: new Date(at),
        });
        if (stopped) {
          await tx.insert(assignmentEvents).values({
            id: uuidv7(),
            operatorId,
            assignmentId,
            type: "suspended",
            effectiveDate: start,
            at: new Date(at + 1_000),
          });
        }
      }
      // Chandu's account total has drifted (as T-047's tests do): the run refuses to bill him.
      await tx
        .insert(customerBalances)
        .values({ customerId: ids.chandu, operatorId, balancePaise: 123 });
    });

    const context = async (userId: string, channel: "web" | "mobile") => {
      const ctx = await resolveTenantContext(runtime, {
        userId,
        channel,
        ...(channel === "mobile" ? { deviceId } : {}),
        requestId: newRequestId(),
      });
      if (!ctx.ok) throw new Error(`context: ${ctx.error.code}`);
      return ctx.value;
    };
    const owner = await context(ownerId, "web");
    const staff = await context(staffId, "web");
    const ravi = await context(raviId, "mobile");

    const started = await startBillingRun.call(runtime, owner, { period });
    if (!started.ok) throw new Error(`billing run: ${started.error.code}`);
    const report = await runJobWorker({
      db,
      registry: createJobRegistry([billingRunJob]),
      logger: silentLogger,
    });
    expect(report.failed).toBe(0);

    let ref = 0;
    const field = async (
      ctx: TenantContext,
      customerId: string,
      amountPaise: number,
      method: "cash" | "upi",
    ) => {
      ref += 1;
      const id = uuidv7();
      const result = await postPayment.call(runtime, ctx, {
        id,
        customerId,
        amountPaise,
        method,
        ...(method === "upi" ? { upiReference: "123456789012" } : {}),
        recordedAt: new Date(Date.now() - 5_000).toISOString(),
        provisionalRef: `P-R8V-000${ref}`,
      });
      if (!result.ok) throw new Error(`payment: ${result.error.code}`);
      return id;
    };
    await field(ravi, ids.asha, 30_000, "cash");
    await field(ravi, ids.bina, 10_000, "upi");
    const undone = await field(ravi, ids.asha, 5_000, "cash");
    const reversed = await reversePayment.call(runtime, owner, {
      paymentId: undone,
      reason: "saved_twice: same money",
    });
    if (!reversed.ok) throw new Error(`reverse: ${reversed.error.code}`);
    const counter = await postPayment.call(runtime, staff, {
      id: uuidv7(),
      customerId: ids.asha,
      amountPaise: 20_000,
      method: "cash",
    });
    if (!counter.ok) throw new Error(`counter: ${counter.error.code}`);
    const handed = await submitHandover.call(runtime, ravi, {
      businessDate: businessDateOf(new Date(Date.now() - 5_000)),
      submissionId: uuidv7(),
      cashHandedOverPaise: 25_000,
      discrepancyReason: "short",
      note: "Gave change to a customer",
      unsyncedPaymentCount: 0,
      unsyncedCashPaise: 0,
    });
    if (!handed.ok) throw new Error(`handover: ${handed.error.code}`);
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

  test("the Owner reads the daily collection: cash and UPI apart, by person and day", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signIn(page, ownerLogin);
    await page.goto("/reports");
    await page.getByRole("link", { name: "Daily collection" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Daily collection");
    await expect(page.getByTestId("as-of")).toContainText("Numbers as of");
    await expect(page.getByTestId("collections-totals-cash")).toContainText("₹500");
    await expect(page.getByTestId("collections-totals-upi")).toContainText("₹100");
    await expect(page.getByTestId("collections-totals-count")).toContainText("3 payments");
    await expect(page.getByTestId("collections-totals-count")).toContainText(
      "1 cancelled (₹50), not counted",
    );

    const people = page.getByRole("table", { name: "Who took how much" });
    await expect(people.getByRole("columnheader")).toHaveText(["Who", "Cash", "UPI", "Payments"]);
    await expect(people.getByRole("row").nth(1)).toContainText("E2E Staff");
    await expect(people.getByRole("row").nth(1)).toContainText("₹200");
    await expect(people.getByRole("row").nth(2)).toContainText("Ravi Kumar");
    await expect(people.getByRole("row").nth(2)).toContainText("₹300₹1002");

    // Only Ravi.
    await page.getByRole("combobox", { name: /^Taken by/ }).selectOption({ label: "Ravi Kumar" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/collector=/);
    await expect(page.getByTestId("collections-totals-cash")).toContainText("₹300");
    await expect(page.getByTestId("collections-totals-upi")).toContainText("₹100");

    // A day row opens that day's payments of that person.
    await page.getByRole("table", { name: "Day by day" }).getByRole("link").first().click();
    await expect(page).toHaveURL(/\/reports\/payments\?from=.*collector=/);
    await expect(page.getByTestId("payments-totals-cash")).toContainText("₹300");
  });

  test("the Owner reads the cash handover: expected, handed over, short, what happened", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signIn(page, ownerLogin);
    await page.goto("/reports");
    await page.getByRole("link", { name: "Cash handover" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Cash handover");
    await expect(page.getByTestId("as-of")).toContainText("Numbers as of");
    await expect(page.getByTestId("handover-totals-expected")).toContainText("₹300");
    await expect(page.getByTestId("handover-totals-expected")).toContainText(
      "UPI ₹100 is not cash",
    );
    await expect(page.getByTestId("handover-totals-handed")).toContainText("₹250");
    await expect(page.getByTestId("handover-totals-difference")).toContainText("₹50 short");
    await expect(page.getByTestId("handover-status-line")).toContainText("Waiting for check: 1");

    const table = page.getByRole("table", { name: "Linemen's days" });
    const row = table.getByRole("row").nth(1);
    await expect(row).toContainText("Ravi Kumar");
    await expect(row).toContainText("₹50 short");
    await expect(row).toContainText("Lineman's reason: Less cash");
    await expect(row).toContainText("Waiting for check");
    await row.getByText("What happened (1 step)").click();
    await expect(row).toContainText("Ravi Kumar handed over ₹250 (expected ₹300)");
    await expect(row).toContainText("Lineman's note: Gave change to a customer");

    // Accepted days only: none yet.
    await page.getByRole("combobox", { name: /^Status/ }).selectOption({ label: "Accepted" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/status=accepted/);
    await expect(page.getByText("No cash to hand over on these days.")).toBeVisible();

    // A row opens the lineman's day on the Linemen page.
    await page.goto("/reports/handover");
    await page.getByRole("table", { name: "Linemen's days" }).getByRole("link").first().click();
    await expect(page).toHaveURL(new RegExp(`/linemen/${raviId}\\?date=`));
  });

  test("the Owner reads the connections on a day, with their rent", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, ownerLogin);
    await page.goto("/reports");
    await page.getByRole("link", { name: "Connections report" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections report");
    await expect(page.getByTestId("as-of")).toContainText("Numbers as of");
    await expect(page.getByTestId("connections-totals-active")).toContainText("2 connections");
    await expect(page.getByTestId("connections-totals-rent")).toContainText("₹400");
    await expect(page.getByTestId("connections-totals-suspended")).toContainText("1 connection");
    const table = page.getByRole("table", { name: "Connections" });
    await expect(table.getByRole("row")).toHaveCount(4);
    await expect(table.getByRole("row").nth(1)).toContainText("Asha Devi");
    await expect(table.getByRole("row").nth(1)).toContainText("Active");
    await expect(table.getByRole("row").nth(1)).toContainText("₹300Basic");
    await expect(table.getByRole("row").nth(2)).toContainText("Bina Rao");
    await expect(table.getByRole("row").nth(2)).toContainText("Stopped");
    await expect(table.getByRole("row").nth(2)).toContainText("₹250Own amount");

    await page.getByRole("combobox", { name: /^Status/ }).selectOption({ label: "Stopped" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/status=suspended/);
    await expect(page.getByRole("table", { name: "Connections" }).getByRole("row")).toHaveCount(2);

    // On its first day Bina's connection was still on (a stop counts from the next day).
    await page.goto(`/reports/connections?date=${start}`);
    await expect(page.getByTestId("connections-totals-active")).toContainText("3 connections");
    await expect(page.getByTestId("connections-totals-rent")).toContainText("₹650");

    // A row opens the customer's Connections tab.
    await page.getByRole("table", { name: "Connections" }).getByRole("link").first().click();
    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}\/connections$/);
  });

  test("the Owner reads this month's bill run: a new bill, nothing to bill, a problem and why", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signIn(page, ownerLogin);
    await page.goto("/reports");
    await page.getByRole("link", { name: "Monthly bills made" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Monthly bills made");
    await expect(page.getByTestId("as-of")).toContainText("Numbers as of");
    await expect(page.getByTestId("run-summary")).toContainText("Some problems");
    await expect(page.getByTestId("run-summary")).toContainText("Made by E2E Owner");
    await expect(page.getByTestId("runs-totals-customers")).toContainText("3 customers");
    await expect(page.getByTestId("runs-totals-created")).toContainText("1");
    await expect(page.getByTestId("runs-totals-created")).toContainText("Total ₹300");
    await expect(page.getByTestId("runs-totals-skipped")).toContainText("1");
    await expect(page.getByTestId("runs-totals-failed")).toContainText("1");
    const table = page.getByRole("table", { name: "Customers in this bill run" });
    await expect(table.getByRole("row").nth(1)).toContainText("Chandu");
    await expect(table.getByRole("row").nth(1)).toContainText("Problem");
    await expect(table.getByRole("row").nth(1)).toContainText(
      "Account total does not match. Call support.",
    );
    await expect(table.getByRole("row").nth(2)).toContainText("Bina Rao");
    await expect(table.getByRole("row").nth(2)).toContainText("No connection was on on the 1st.");
    await expect(table.getByRole("row").nth(3)).toContainText("Asha Devi");
    await expect(table.getByRole("row").nth(3)).toContainText("New bill₹300");

    await page.getByRole("combobox", { name: /^Result/ }).selectOption({ label: "New bill" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/outcome=created/);
    const created = page.getByRole("table", { name: "Customers in this bill run" });
    await expect(created.getByRole("row")).toHaveCount(2);
    await created.getByRole("link").first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Bill /);
  });

  test("Staff open each report with filters; they fit a phone", async ({ browser }) => {
    test.setTimeout(90_000);
    const staff = await signedIn(browser, staffLogin);
    await staff.setViewportSize({ width: 360, height: 800 });
    for (const [path, title, check] of [
      [
        `/reports/collections?from=${yesterday}&to=${today}&collector=${raviId}`,
        "Daily collection",
        "₹300",
      ],
      ["/reports/handover?status=submitted&difference=short", "Cash handover", "₹50 short"],
      ["/reports/connections?status=suspended", "Connections report", "Bina Rao"],
      ["/reports/billing-runs?outcome=failed", "Monthly bills made", "Chandu"],
    ] as const) {
      await staff.goto(path);
      await expect(staff.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(staff.getByRole("main")).toContainText(check);
      const overflow = await staff.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
    await staff.context().close();
  });
});
