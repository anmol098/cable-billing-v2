/**
 * The Home page (T-083) against `next start` and a real, migrated database.
 *
 * - A **new business** (just signed up, free trial, nothing set up): the Owner sees the 4-step
 *   checklist first, with the Play Store link and its QR code, zeros and the trial; Staff see only
 *   their own step. It fits a 360px phone, in Hindi too.
 * - A **busy business** (bills this month, payments taken today at the counter and in the field,
 *   a flagged payment, a handover waiting, a missed month): the numbers, and every tile and alert
 *   opens the page that shows the same number.
 *
 * Payments and the handover are made through the real core services; the month's bills and runs
 * are written directly (the job worker is shared by every spec, so this file does not run it).
 * Logins and names are unique per run. Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`.
 */
import { randomBytes } from "node:crypto";
import {
  createServiceRuntime,
  hashPassword,
  newRequestId,
  postPayment,
  resolveTenantContext,
  silentLogger,
  submitHandover,
  type TenantContext,
} from "@cb/core";
import {
  accounts,
  billingRuns,
  createDb,
  customerBalances,
  customers,
  type DbClient,
  devices,
  invoices,
  ledgerEntries,
  operators,
  plans,
  subscriptions,
  type Tx,
  users,
  uuidv7,
} from "@cb/db";
import { addPeriods, businessDateOf, periodLabel, periodOfInstant } from "@cb/domain";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e home password 4321";
const PHONE = { width: 360, height: 800 };
const PLAY_URL = "https://play.google.com/store/apps/details?id=com.cablebilling.lineman";

test.describe("home: dashboard and setup checklist", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const login = (who: string) => `e2e-home-${who}-${run}`;
  // "Today" and "this month" as the server will see them (IST), fixed once for the whole file.
  const now = new Date();
  const today = businessDateOf(now);
  const period = periodOfInstant(now);
  const missedPeriod = addPeriods(period, -2);
  let db: DbClient;

  async function addPerson(
    tx: Tx,
    operatorId: string,
    who: string,
    role: "owner" | "staff" | "lineman",
  ): Promise<string> {
    const id = uuidv7();
    await tx.insert(users).values({
      id,
      operatorId,
      role,
      name: `E2E ${who}`,
      login: login(who),
      ...(role === "lineman" ? {} : { email: `${login(who)}@cable.test` }),
      language: "en",
    });
    if (role !== "lineman") {
      await tx.insert(accounts).values({
        id: uuidv7(),
        userId: id,
        accountId: id,
        providerId: "credential",
        password: await hashPassword(PASSWORD),
      });
    }
    return id;
  }

  async function newBusiness(operatorId: string) {
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `New Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "trialing",
        trialEndsAt: new Date(now.getTime() + 30 * 86_400_000),
      });
      await addPerson(tx, operatorId, "new-owner", "owner");
      await addPerson(tx, operatorId, "new-staff", "staff");
    });
  }

  /** Writes a regular bill as the billing run does: invoice, ledger += charges, balance. */
  async function addBill(tx: Tx, operatorId: string, customerId: string, chargesPaise: number) {
    const id = uuidv7();
    await tx.insert(invoices).values({
      id,
      operatorId,
      customerId,
      period,
      invoiceNumber: `E2E-${id.slice(-8)}`,
      openingBalancePaise: 0,
      chargesPaise,
      totalDuePaise: chargesPaise,
    });
    await tx.insert(ledgerEntries).values({
      id: uuidv7(),
      operatorId,
      customerId,
      type: "invoice",
      amountPaise: chargesPaise,
      invoiceId: id,
    });
    await tx
      .insert(customerBalances)
      .values({ customerId, operatorId, balancePaise: chargesPaise });
  }

  async function busyBusiness(operatorId: string) {
    const ids = { owner: "", lineman: "", device: "", asha: uuidv7(), bina: uuidv7() };
    const chandu = uuidv7();
    await db.withTenant(operatorId, async (tx) => {
      // Started six months ago, so the missed month is one the Bills pages can open.
      await tx.insert(operators).values({
        id: operatorId,
        name: `Busy Cable ${run}`,
        createdAt: new Date(now.getTime() - 180 * 86_400_000),
      });
      await tx.insert(subscriptions).values({ operatorId, status: "active" });
      ids.owner = await addPerson(tx, operatorId, "busy-owner", "owner");
      await addPerson(tx, operatorId, "busy-staff", "staff");
      ids.lineman = await addPerson(tx, operatorId, "busy-lineman", "lineman");
      ids.device = uuidv7();
      await tx.insert(devices).values({
        id: ids.device,
        operatorId,
        userId: ids.lineman,
        installId: uuidv7(),
        deviceCode: "H8B",
        lastSeenAt: now,
      });
      await tx
        .insert(plans)
        .values({ id: uuidv7(), operatorId, name: "Basic", monthlyAmountPaise: 30_000 });
      await tx.insert(customers).values([
        { id: ids.asha, operatorId, customerCode: "A-1", name: "Asha Devi" },
        { id: ids.bina, operatorId, customerCode: "B-2", name: "Bina Rao" },
        { id: chandu, operatorId, customerCode: "C-3", name: "Chandu Lal", status: "inactive" },
      ]);
      await addBill(tx, operatorId, ids.asha, 50_000);
      await addBill(tx, operatorId, ids.bina, 30_000);
      await tx.insert(billingRuns).values([
        {
          id: uuidv7(),
          operatorId,
          period,
          trigger: "cron",
          status: "completed",
          customerCount: 2,
          createdCount: 2,
          totalChargesPaise: 80_000,
          startedAt: now,
          finishedAt: now,
        },
        {
          id: uuidv7(),
          operatorId,
          period: missedPeriod,
          trigger: "cron",
          status: "skipped",
          skipReason: "tenant_read_only",
          finishedAt: now,
        },
      ]);
    });

    const runtime = createServiceRuntime({ db, logger: silentLogger });
    const contextOf = async (userId: string, deviceId?: string): Promise<TenantContext> => {
      const ctx = await resolveTenantContext(runtime, {
        userId,
        channel: deviceId ? "mobile" : "web",
        ...(deviceId ? { deviceId } : {}),
        requestId: newRequestId(),
      });
      if (!ctx.ok) throw new Error(`context: ${ctx.error.code}`);
      return ctx.value;
    };
    const owner = await contextOf(ids.owner);
    const lineman = await contextOf(ids.lineman, ids.device);
    const pay = async (
      ctx: TenantContext,
      customerId: string,
      amountPaise: number,
      method: "cash" | "upi",
      field = false,
    ) => {
      const result = await postPayment.call(runtime, ctx, {
        id: uuidv7(),
        customerId,
        amountPaise,
        method,
        ...(method === "upi" ? { upiReference: "123456789012" } : {}),
        ...(field ? { recordedAt: new Date().toISOString(), provisionalRef: "P-H8B-0001" } : {}),
      });
      if (!result.ok) throw new Error(`payment: ${result.error.code}`);
    };
    // Today: ₹100 cash at the counter, ₹200 cash + ₹150 UPI in the field, ₹40 cash from the
    // closed customer (counted, and flagged for the office to check).
    await pay(owner, ids.asha, 10_000, "cash");
    await pay(lineman, ids.bina, 20_000, "cash", true);
    await pay(lineman, ids.asha, 15_000, "upi", true);
    await pay(owner, chandu, 4_000, "cash");
    const handed = await submitHandover.call(runtime, lineman, {
      businessDate: today,
      submissionId: uuidv7(),
      cashHandedOverPaise: 20_000,
      unsyncedPaymentCount: 0,
      unsyncedCashPaise: 0,
    });
    if (!handed.ok) throw new Error(`handover: ${handed.error.code}`);
  }

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    await newBusiness(uuidv7());
    await busyBusiness(uuidv7());
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

  async function expectNoSideways(page: Page) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }

  test("a new business: the checklist first, with the app's link and QR; zeros and the trial", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await signIn(page, "new-owner");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Home");
    const checklist = page.getByRole("region", { name: "Get started" });
    await expect(checklist).toContainText("0 of 4 done");
    await expect(checklist.getByRole("listitem")).toHaveCount(4);
    await expect(checklist.getByRole("link", { name: "Add plans" })).toHaveAttribute(
      "href",
      "/settings/plans",
    );
    const app = checklist.getByRole("link", { name: "Get the app" });
    await expect(app).toHaveAttribute("href", PLAY_URL);
    await expect(app).toHaveAttribute("target", "_blank");
    await expect(
      checklist.getByRole("img", { name: "QR code: the lineman app on Google Play" }),
    ).toBeVisible();

    await expect(page.getByTestId("home-cash-today")).toContainText("₹0");
    await expect(page.getByTestId("home-upi-today")).toContainText("₹0");
    await expect(page.getByTestId("home-due")).toContainText("Nobody owes money");
    await expect(page.getByTestId("home-run")).toContainText("No bills made yet.");
    const trial = page.locator('[data-alert="subscription"] a');
    await expect(trial).toContainText(/Free trial: \d+ days left/);
    await expect(trial).toHaveAttribute("href", "/settings/subscription");
    // No banner during the trial, and nothing on Home claims a status role.
    await expect(page.getByRole("status")).toHaveCount(0);

    // The checklist's first step leads to the Plans page.
    await checklist.getByRole("link", { name: "Add plans" }).click();
    await expect(page).toHaveURL(/\/settings\/plans$/);
  });

  test("a new business on a 360px phone, in English and Hindi; Staff see only their step", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const page = await browser.newPage({ viewport: PHONE });
    await signIn(page, "new-owner");
    await expect(page.getByRole("region", { name: "Get started" })).toBeVisible();
    await expectNoSideways(page);
    await page.getByRole("button", { name: "हिंदी" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    await expect(page.getByRole("img", { name: "QR कोड: Google Play पर लाइनमैन ऐप" })).toBeVisible();
    await expect(page.getByTestId("home-due")).toContainText("कुल बाकी");
    await expectNoSideways(page);
    await page.close();

    const staff = await browser.newPage({ viewport: PHONE });
    await signIn(staff, "new-staff");
    const checklist = staff.getByRole("region", { name: "Get started" });
    await expect(checklist.getByRole("listitem")).toHaveCount(1);
    await expect(checklist.getByRole("link", { name: "Add customers" })).toBeVisible();
    await expect(staff.locator('[data-alert="subscription"]')).toHaveCount(0);
    await expectNoSideways(staff);
    await staff.close();
  });

  test("a busy business: the numbers, and each tile opens the page with the same number", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await signIn(page, "busy-owner");
    const month = periodLabel(period, "en", "long");

    // Set up: no checklist.
    await expect(page.getByRole("region", { name: "Get started" })).toHaveCount(0);
    await expect(page.getByTestId("home-cash-today")).toContainText("Cash today₹340");
    await expect(page.getByTestId("home-upi-today")).toContainText("UPI today₹150");
    await expect(page.getByTestId("home-payments-today")).toHaveText("4 payments");
    await expect(page.getByTestId("home-billed")).toContainText("Bills made₹8002 bills");
    await expect(page.getByTestId("home-collected")).toContainText("Money taken₹490");
    await expect(page.getByTestId("home-due")).toContainText("Total due₹3502 customers owe money");
    await expect(page.getByTestId("home-run")).toContainText(`Bills of ${month}Bills made`);
    const alerts = page.getByRole("region", { name: "To check" });
    await expect(alerts.getByRole("link")).toHaveText([
      "1 cash handover to check",
      "1 payment to check",
      "Bills of 1 month were missed",
    ]);

    // Cash today → the register for today, cash only.
    await page.getByTestId("home-cash-today").click();
    await expect(page).toHaveURL(/\/payments\?method=cash$/);
    await expect(page.getByTestId("total-cash")).toHaveText("₹340");
    await expect(page.getByTestId("total-count")).toHaveText("3 payments");
    await page.goto("/home");
    await page.getByTestId("home-upi-today").click();
    await expect(page).toHaveURL(/\/payments\?method=upi$/);
    await expect(page.getByTestId("total-upi")).toHaveText("₹150");

    // Money taken this month → the register from the 1st to today.
    await page.goto("/home");
    await page.getByTestId("home-collected").click();
    await expect(page).toHaveURL(new RegExp(`/payments\\?from=${period}&to=${today}$`));
    await expect(page.getByTestId("total-cash")).toHaveText("₹340");
    await expect(page.getByTestId("total-upi")).toHaveText("₹150");

    // Bills made → this month's bill register.
    await page.goto("/home");
    await page.getByTestId("home-billed").click();
    await expect(page).toHaveURL(new RegExp(`/bills/register\\?month=${period}$`));
    await expect(page.getByTestId("register-billed")).toHaveText("₹800");
    await expect(page.getByTestId("register-count")).toHaveText("2 bills");

    // Total due → the dues report; the latest run → that month's run page.
    await page.goto("/home");
    await page.getByTestId("home-due").click();
    await expect(page).toHaveURL(/\/reports\/dues$/);
    await page.goto("/home");
    await page.getByTestId("home-run").click();
    await expect(page).toHaveURL(new RegExp(`/bills/runs\\?month=${period}$`));
    await expect(page.getByTestId("run-summary")).toContainText(`Bills for ${month} are made.`);

    // The alerts.
    await page.goto("/home");
    await alerts.getByRole("link", { name: "1 cash handover to check" }).click();
    await expect(page).toHaveURL(new RegExp(`/linemen\\?date=${today}$`));
    await expect(page.getByText("1 handover to check")).toBeVisible();
    await page.goto("/home");
    await alerts.getByRole("link", { name: "1 payment to check" }).click();
    await expect(page).toHaveURL(/\/payments\/review$/);
    await expect(page.getByText("Chandu Lal").first()).toBeVisible();
    await page.goto("/home");
    await alerts.getByRole("link", { name: "Bills of 1 month were missed" }).click();
    await expect(page).toHaveURL(new RegExp(`/bills/runs\\?month=${missedPeriod}&preview=1$`));
  });

  test("a busy business on a 360px phone: Take payment at the bottom, no sideways scroll", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const page = await browser.newPage({ viewport: PHONE });
    await signIn(page, "busy-staff");
    await expect(page.getByTestId("home-cash-today")).toContainText("₹340");
    await expectNoSideways(page);
    await page.getByRole("link", { name: "Take payment" }).click();
    await expect(page).toHaveURL(/\/payments\/new$/);
    await page.goto("/home");
    await page.getByRole("button", { name: "हिंदी" }).click();
    await expect(page.getByTestId("home-cash-today")).toContainText("आज नकद₹340");
    await expectNoSideways(page);
    await page.close();
  });
});
