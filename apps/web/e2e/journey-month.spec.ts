/**
 * The operator's first month, end to end (T-088), against `next start` and a real, migrated
 * database. One business, made by signing up, does everything through the app's own pages and the
 * lineman app's API; each step checks that the numbers agree with the pages before it.
 *
 * 1. Sign up (email link) → areas, plans and a lineman (Settings).
 * 2. Customers with connections: Asha has two VCs (₹250 + ₹350), Bina's code is also used by
 *    another business (allowed) but not twice in this one, Chandu has a ₹700 old due (brought from
 *    the old records, as the import does).
 * 3. Make the month's bills: preview → run → register → Asha's one bill has both VCs.
 * 4. Counter payments: Chandu's ₹800 pays the old bill first, then part of this month's; Bina's
 *    ₹300 leaves ₹50 credit.
 * 5. The lineman's phone (mobile API): roster balances = the web's, a payment batch (replayed:
 *    no duplicates; another business's customer refused), the day's cash/UPI, a ₹50-short handover,
 *    receipt actions never "sent".
 * 6. The office accepts the handover; the phone's temporary number sits next to the receipt no.
 * 7. Bill, statement, dues report, bill and payment reports, payment register, home and the phone
 *    all show the same numbers (home also in Hindi); another business's pages are 404.
 * 8. A plan change after the bill and a reused VC leave the issued bills alone; making the bills
 *    again makes none.
 * 9. The Owner undoes a payment: every page moves together, and "Who changed what" shows it.
 *
 * PRD §15: #1 (step 5, 7), #2 (2), #3 (2, 3), #4 (8), #5 (8), #6 (8), #7 (4), #8 server side
 * (5: replayed batch), #9 (5, 6), #11 (5, and no "sent"/"delivered" on the receipt pages), #12
 * (5, 6). Needs `DATABASE_URL` (migrated), `BETTER_AUTH_SECRET` and the local server's email
 * outbox, like signup.spec.ts.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CollectionDayResponse,
  CustomerDetailResponse,
  ErrorResponse,
  HandoverResponse,
  LoginResponse,
  PaymentBatchResponse,
  type PostedPayment,
  ReceiptActionsResponse,
  SyncCustomersResponse,
} from "@cb/contracts";
import {
  createServiceRuntime,
  newRequestId,
  postPayment,
  resolveTenantContext,
  silentLogger,
} from "@cb/core";
import {
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
} from "@cb/db";
import {
  addDays,
  addPeriods,
  businessDateOf,
  formatBusinessDate,
  istStartOfDay,
  periodLabel,
  periodOfInstant,
} from "@cb/domain";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  apiHeaders,
  expectNoSideways,
  journeyIp,
  phoneDevice,
  runJobs,
  words,
} from "./_support/journey";
import { mobileFromSeed, newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const OUTBOX = process.env.EMAIL_OUTBOX_DIR;
const OWNER_PASSWORD = "journey owner 4321";
const LINEMAN_PASSWORD = "river 2468";
const OWNER_NAME = "Meera Owner";
const API = "/api/mobile/v1";

/** The newest email to `to` in the local server's outbox (signup.spec.ts reads it the same way). */
async function lastEmailTo(to: string): Promise<{ subject: string; text: string } | undefined> {
  if (!OUTBOX) return undefined;
  let names: string[];
  try {
    names = (await readdir(OUTBOX)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return undefined;
  }
  for (const name of names.reverse()) {
    const email = JSON.parse(await readFile(join(OUTBOX, name), "utf8"));
    if (email.to === to) return email;
  }
  return undefined;
}

test.describe("journey: an operator's first month", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(
    !DATABASE_URL || !OUTBOX || Boolean(process.env.E2E_BASE_URL),
    "needs DATABASE_URL (a migrated database), BETTER_AUTH_SECRET and the local server's outbox",
  );

  const period = periodOfInstant(new Date());
  const today = businessDateOf(new Date());
  const tomorrow = addDays(today, 1);
  const oldPeriod = addPeriods(period, -4);
  const month = periodLabel(period, "en", "long");
  const en = words("en");
  const hi = words("hi");

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let run = "";
  let ownerMobile = "";
  let linemanMobile = "";
  let email = "";
  let ip = "";
  let vc: Record<"a1" | "a2" | "b1" | "c1", string>;
  let db: DbClient;
  let operatorId = "";
  /** The signed-in Owner's cookies (from the sign-up), reused by every step: one sign-in in all. */
  let ownerState: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;
  const ids = { asha: "", bina: "", chandu: "", binaPayment: "", linemanCash: "" };
  let binaReceipt = "";
  let linemanToken = "";
  let lineman: PostedPayment[] = [];
  /** Another business: its customer (code 102, like Bina), bill and payment. */
  const other = { operatorId: "", customerId: "", invoiceId: "", paymentId: "" };

  test.beforeAll(async () => {
    test.setTimeout(60_000);
    run = newSeedId();
    ownerMobile = mobileFromSeed(run);
    linemanMobile = mobileFromSeed(newSeedId());
    email = `e2e-journey-${run}@cable.test`;
    ip = journeyIp(run);
    vc = { a1: `A1-${run}`, a2: `A2-${run}`, b1: `B1-${run}`, c1: `C1-${run}` };
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });

    // The other business, with a customer whose code (102) Bina gets too, a bill and a payment.
    other.operatorId = uuidv7();
    other.customerId = uuidv7();
    other.invoiceId = uuidv7();
    other.paymentId = uuidv7();
    const otherOwner = uuidv7();
    await db.withTenant(other.operatorId, async (tx) => {
      await tx.insert(operators).values({ id: other.operatorId, name: `Other Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId: other.operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      await tx.insert(users).values({
        id: otherOwner,
        operatorId: other.operatorId,
        role: "owner",
        name: "Other Owner",
        login: `e2e-journey-other-${run}`,
        email: `e2e-journey-other-${run}@cable.test`,
        language: "en",
      });
      await tx.insert(customers).values({
        id: other.customerId,
        operatorId: other.operatorId,
        customerCode: "102",
        name: "Other Customer",
      });
      await tx.insert(invoices).values({
        id: other.invoiceId,
        operatorId: other.operatorId,
        customerId: other.customerId,
        period,
        invoiceNumber: `INV-OTHER-${run}`,
        openingBalancePaise: 0,
        chargesPaise: 30_000,
        totalDuePaise: 30_000,
      });
      await tx.insert(ledgerEntries).values({
        id: uuidv7(),
        operatorId: other.operatorId,
        customerId: other.customerId,
        type: "invoice",
        amountPaise: 30_000,
        invoiceId: other.invoiceId,
      });
      await tx.insert(customerBalances).values({
        operatorId: other.operatorId,
        customerId: other.customerId,
        balancePaise: 30_000,
        oldestDuePeriod: period,
      });
    });
    const runtime = createServiceRuntime({ db, logger: silentLogger });
    const ctx = await resolveTenantContext(runtime, {
      userId: otherOwner,
      channel: "web",
      requestId: newRequestId(),
    });
    if (!ctx.ok) throw new Error(`other owner: ${ctx.error.code}`);
    const paid = await postPayment.call(runtime, ctx.value, {
      id: other.paymentId,
      customerId: other.customerId,
      amountPaise: 10_000,
      method: "cash",
    });
    if (!paid.ok) throw new Error(`other payment: ${paid.error.code}`);
  });

  test.afterAll(async () => {
    await db?.end();
  });

  /** A browser for the Owner, signed in with the sign-up's session (no new sign-in). */
  async function ownerPage(browser: Browser): Promise<Page> {
    expect(ownerState, "the sign-up step ran").toBeTruthy();
    const context = await browser.newContext({
      storageState: ownerState,
      extraHTTPHeaders: { "x-real-ip": ip },
    });
    return context.newPage();
  }

  const lineArgs = () => ({ headers: { ...apiHeaders(ip), authorization: `Bearer ${linemanToken}` } });

  async function phone(request: APIRequestContext, path: string) {
    const response = await request.get(`${API}${path}`, lineArgs());
    return response;
  }

  async function rosterBalances(request: APIRequestContext): Promise<Record<string, number>> {
    const response = await phone(request, "/sync/customers");
    expect(response.status()).toBe(200);
    const body = SyncCustomersResponse.parse(await response.json());
    return Object.fromEntries(body.customers.map((c) => [c.name, c.balance_paise]));
  }

  test("1. sign up, then set up areas, plans and a lineman", async ({ browser }) => {
    test.setTimeout(150_000);
    const context = await browser.newContext({ extraHTTPHeaders: { "x-real-ip": ip } });
    const page = await context.newPage();

    await page.goto("/signup");
    await page.getByLabel("Business name").fill(`Journey Cable ${run}`);
    await page.getByLabel("Your name").fill(OWNER_NAME);
    await page.getByLabel("Mobile no.").fill(`+91 ${ownerMobile}`);
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Start 30 days free" }).click();
    // Hashing the password and writing the email can take a while on a cold server.
    await expect(page.getByText(`We sent a link to ${email}.`)).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => lastEmailTo(email), { timeout: 15_000 }).toBeTruthy();
    const link = (await lastEmailTo(email))?.text.match(/\/verify\/([A-Za-z0-9_-]{43})/);
    expect(link).toBeTruthy();
    await page.goto(`/verify/${link?.[1]}`);
    await page.getByLabel("Password (the one you chose)").fill(OWNER_PASSWORD);
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page).toHaveURL(/\/home$/);
    const checklist = page.getByRole("region", { name: "Get started" });
    await expect(checklist).toContainText("0 of 4 done");

    const owner = await db.withPlatform((tx) =>
      tx.query.users.findFirst({ where: (u, { eq }) => eq(u.email, email) }),
    );
    expect(owner).toMatchObject({ login: ownerMobile, role: "owner" });
    operatorId = owner?.operatorId ?? "";

    // Areas.
    await page.goto("/settings/areas");
    for (const name of ["North", "South"]) {
      await page.getByRole("button", { name: "Add area" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Add area" });
      await dialog.getByLabel("Area name").fill(name);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden();
    }

    // Plans.
    await page.goto("/settings/plans");
    for (const [name, rent] of [
      ["Basic", "250"],
      ["Gold", "350"],
    ] as const) {
      await page.getByRole("button", { name: "Add plan" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Add plan" });
      await dialog.getByLabel("Plan name").fill(name);
      await dialog.getByLabel("Rent each month").fill(rent);
      await dialog.getByRole("button", { name: "Save" }).click();
      await expect(dialog).toBeHidden();
    }
    await expect(page.getByRole("list", { name: "Plans" }).getByRole("listitem")).toHaveCount(2);

    // A lineman: the user name is the mobile, the password is shown once.
    await page.goto("/settings/team");
    await page.getByRole("button", { name: "Add lineman" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Name", { exact: true }).fill("Ravi Kumar");
    await dialog.getByLabel("Mobile no.", { exact: true }).fill(`+91 ${linemanMobile}`);
    await expect(dialog.getByLabel("User name", { exact: true })).toHaveValue(linemanMobile);
    await dialog.getByLabel("Password", { exact: true }).fill(LINEMAN_PASSWORD);
    await dialog.getByRole("button", { name: "Add lineman" }).click();
    await expect(dialog.getByText("Ravi Kumar is added")).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();

    // Plans and linemen are done; customers and the app are next.
    await page.goto("/home");
    await expect(checklist).toContainText("2 of 4 done");
    ownerState = await context.storageState();
    await context.close();
  });

  test("2. add customers with connections; a code is unique in the business, not across businesses", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const page = await ownerPage(browser);

    const addCustomer = async (input: {
      code: string;
      name: string;
      area: string;
      vc: string;
      rent: { plan: string } | { own: string };
    }) => {
      await page.goto("/customers/new");
      await page.getByLabel("Customer code").fill(input.code);
      await page.getByLabel("Name").fill(input.name);
      await page.getByLabel("Mobile no.", { exact: true }).fill("+91 98111 22233");
      await page.getByLabel("Area").selectOption({ label: input.area });
      await page.getByRole("button", { name: "Next" }).click();
      await expect(page.getByText("Step 2 of 3")).toBeVisible();
      await page.getByLabel("VC number").fill(input.vc);
      if ("plan" in input.rent) {
        await page.getByLabel("Monthly rent").selectOption({ label: input.rent.plan });
      } else {
        await page.getByLabel("Monthly rent").selectOption({ label: "Own amount" });
        await page.getByLabel("Rent (₹ a month)").fill(input.rent.own);
      }
      // From the 1st, so this month's bill has the full rent.
      await page.getByLabel("Start day").fill(period);
      await page.getByRole("button", { name: "Next" }).click();
      await page.getByRole("button", { name: "Save customer" }).click();
      await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(input.name);
      return page.url().split("/").pop() ?? "";
    };

    ids.asha = await addCustomer({
      code: "101",
      name: "Asha Devi",
      area: "North",
      vc: vc.a1,
      rent: { plan: "Basic · ₹250" },
    });
    // Asha's second box, from the Connections tab.
    await page.goto(`/customers/${ids.asha}/connections`);
    await page.getByRole("link", { name: "Add connection" }).click();
    await page.getByLabel("VC number").fill(vc.a2);
    await page.getByLabel("Monthly rent").selectOption({ label: "Gold · ₹350" });
    await page.getByLabel("Start day").fill(period);
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect(page.getByText("Connection added.", { exact: true })).toBeVisible();

    // 102 is also the other business's customer's code: that's fine (PRD §15 #2).
    ids.bina = await addCustomer({
      code: "102",
      name: "Bina Rao",
      area: "South",
      vc: vc.b1,
      rent: { plan: "Basic · ₹250" },
    });
    ids.chandu = await addCustomer({
      code: "103",
      name: "Chandu Lal",
      area: "North",
      vc: vc.c1,
      rent: { own: "200" },
    });

    // ...but not twice in this business.
    await page.goto("/customers/new");
    await page.getByLabel("Customer code").fill("102");
    await page.getByLabel("Name").fill("Someone Else");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Save customer" }).click();
    await expect(page.getByText("Code 102 is already used by another customer.")).toBeVisible();

    // Chandu's old due of ₹700 from the old records, as the import brings it: a bill four months
    // ago and its ledger line (the balance row now matches the ledger).
    await db.withTenant(operatorId, async (tx) => {
      const madeAt = istStartOfDay(addDays(oldPeriod, 4));
      const oldBill = uuidv7();
      await tx.insert(invoices).values({
        id: oldBill,
        operatorId,
        customerId: ids.chandu,
        period: oldPeriod,
        invoiceNumber: `OLD-${run}`,
        kind: "opening_balance",
        openingBalancePaise: 0,
        chargesPaise: 70_000,
        totalDuePaise: 70_000,
        issuedAt: madeAt,
        legacySource: "legacy",
        legacyId: `c-${run}`,
      });
      await tx.insert(ledgerEntries).values({
        id: uuidv7(),
        operatorId,
        customerId: ids.chandu,
        type: "opening_balance",
        amountPaise: 70_000,
        invoiceId: oldBill,
        at: madeAt,
      });
      await tx
        .insert(customerBalances)
        .values({
          operatorId,
          customerId: ids.chandu,
          balancePaise: 70_000,
          oldestDuePeriod: oldPeriod,
        })
        .onConflictDoUpdate({
          target: [customerBalances.operatorId, customerBalances.customerId],
          set: { balancePaise: 70_000, oldestDuePeriod: oldPeriod },
        });
    });

    // The list: three customers, two in North.
    await page.goto("/customers");
    await expect(page.getByRole("table", { name: "Customers" }).getByRole("row")).toHaveCount(4);
    await page.goto(`/customers/${ids.asha}`);
    await expect(page.getByText("₹250 a month")).toBeVisible();
    await expect(page.getByText("₹350 a month")).toBeVisible();
    await page.goto("/home");
    await expect(page.getByRole("region", { name: "Get started" })).toContainText("3 of 4 done");
    await page.context().close();
  });

  test("3. make the month's bills: one bill per customer, two connections on one bill", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const page = await ownerPage(browser);
    await page.goto("/bills");
    await page.getByRole("link", { name: "Preview this month" }).click();
    await expect(page.getByTestId("preview-will-bill")).toHaveText("3 customers will get a bill.");
    await expect(page.getByTestId("preview-total")).toHaveText("₹1,050");
    await expect(page.getByTestId("preview-problem-count")).toHaveText("No problems.");

    await page.getByRole("button", { name: "Make bills now" }).click();
    const sheet = page.getByRole("alertdialog", { name: `Make bills for ${month}?` });
    await expect(sheet).toContainText("3 customers get a bill, total ₹1,050.");
    await sheet.getByRole("button", { name: "Make bills" }).click();
    await expect(page.getByTestId("run-summary")).toContainText(`Making bills for ${month}.`);
    await runJobs(db);
    await expect(page.getByTestId("run-summary")).toContainText(`Bills for ${month} are made.`, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("run-created")).toHaveText("3");
    await expect(page.getByTestId("run-total")).toHaveText("₹1,050");
    await expect(page.getByTestId("run-failed")).toHaveText("0");

    await page.getByRole("link", { name: `See bills of ${month}` }).click();
    await expect(page.getByTestId("register-count")).toHaveText("3 bills");
    await expect(page.getByTestId("register-billed")).toHaveText("₹1,050");
    await expect(page.getByTestId("register-due")).toHaveText("₹1,050");

    // Asha: one bill, both boxes (PRD §15 #3).
    await page.getByRole("link", { name: /Asha Devi/ }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Bill INV-\d{4}-\d{5}$/);
    await expect(page.getByTestId("bill-connection")).toHaveCount(2);
    await expect(page.getByTestId("bill-connection").filter({ hasText: vc.a1 })).toContainText(
      "₹250",
    );
    await expect(page.getByTestId("bill-connection").filter({ hasText: vc.a2 })).toContainText(
      "₹350",
    );
    await expect(page.getByTestId("bill-charges")).toHaveText("₹600");
    await expect(page.getByTestId("bill-outstanding")).toHaveText("₹600");

    // Chandu: this month's ₹200 on top of the old ₹700.
    await page.goto(`/customers/${ids.chandu}/bills`);
    await expect(page.getByTestId("bills-due")).toContainText("₹900");
    await page.context().close();
  });

  test("4. counter payments: the old bill is paid first, extra money is credit", async ({
    browser,
  }) => {
    test.setTimeout(150_000);
    const page = await ownerPage(browser);

    // Chandu pays ₹800 cash: the ₹700 old bill first, then ₹100 of this month's ₹200 (#7).
    await page.goto("/payments/new");
    await page.getByRole("combobox", { name: "Find customer" }).fill("Chandu");
    await page.getByRole("option", { name: /Chandu Lal/ }).click();
    await expect(page.getByTestId("due-now")).toHaveText("₹900");
    await page.getByRole("textbox", { name: "Amount (₹)" }).fill("800");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Cash" }).click();
    await expect(page.getByTestId("confirm-summary")).toHaveText("₹800 Cash from Chandu Lal");
    await page.getByTestId("save-payment").click();
    await expect(page.getByRole("heading", { name: "Money saved" })).toBeVisible();
    await expect(page.getByTestId("saved-balance")).toHaveText("₹100 due");

    await page.goto(`/customers/${ids.chandu}/bills`);
    const bills = page.getByRole("table", { name: "Bills of this customer" });
    await expect(bills.getByRole("row")).toHaveCount(3);
    await expect(bills.getByRole("row").filter({ hasText: month })).toContainText(
      /₹200\s*₹100\s*Part paid/,
    );
    await expect(bills.getByRole("row").filter({ hasText: "Old dues" })).toContainText(
      /₹700\s*₹700\s*Paid/,
    );
    await expect(page.getByTestId("bills-due")).toContainText("₹100");

    // Bina pays ₹300 by UPI for a ₹250 bill: ₹50 is credit, shown as credit.
    await page.goto(`/payments/new?customer=${ids.bina}`);
    await expect(page.getByTestId("chosen-customer")).toHaveText("Bina Rao");
    await page.getByRole("textbox", { name: "Amount (₹)" }).fill("300");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "UPI" }).click();
    await page.getByRole("textbox", { name: "UPI ref no. (if you have it)" }).fill("412345678901");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByTestId("save-payment").click();
    await expect(page.getByRole("heading", { name: "Money saved" })).toBeVisible();
    await expect(page.getByTestId("saved-balance")).toHaveText("₹50 credit");
    binaReceipt = (await page.getByTestId("saved-receipt").textContent()) ?? "";
    expect(binaReceipt).toMatch(/^R-\d{4}-\d{5}$/);
    await page.getByRole("link", { name: "Open payment" }).click();
    await expect(page).toHaveURL(/\/payments\/[0-9a-f-]{36}$/);
    ids.binaPayment = page.url().split("/").pop() ?? "";

    await page.goto(`/customers/${ids.bina}`);
    const due = page.locator("[data-summary-part=due]");
    await expect(due).toContainText("Credit");
    await expect(due).toContainText("₹50");
    await page.context().close();
  });

  test("5. the lineman's phone: roster, a payment batch replayed, the day's cash and UPI, a short handover", async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const login = await request.post(`${API}/auth/login`, {
      headers: apiHeaders(ip),
      data: { login: linemanMobile, password: LINEMAN_PASSWORD, device: phoneDevice() },
    });
    expect(login.status()).toBe(200);
    const signedIn = LoginResponse.parse(await login.json());
    linemanToken = signedIn.tokens.access_token;

    // The phone sees the same balances as the office (₹ in paise; credit is negative).
    expect(await rosterBalances(request)).toEqual({
      "Asha Devi": 60_000,
      "Bina Rao": -5_000,
      "Chandu Lal": 10_000,
    });

    // Asha pays ₹400 cash and ₹100 UPI; one more is for the other business's customer.
    const recordedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const code = signedIn.device.device_code;
    const payments = [
      { customer: ids.asha, amount: 40_000, method: "cash" },
      { customer: ids.asha, amount: 10_000, method: "upi" },
      { customer: other.customerId, amount: 5_000, method: "cash" },
    ].map((p, i) => ({
      id: uuidv7(),
      customer_id: p.customer,
      amount_paise: p.amount,
      method: p.method,
      recorded_at: recordedAt,
      provisional_ref: `P-${code}-${String(i + 1).padStart(4, "0")}`,
      collector_id: signedIn.user.id,
      device_id: signedIn.device.id,
    }));
    const push = () =>
      request.post(`${API}/payments:batch`, { ...lineArgs(), data: { payments } });
    const first = PaymentBatchResponse.parse(await (await push()).json());
    expect(first.results.map((r) => r.outcome)).toEqual(["posted", "posted", "rejected"]);
    expect(first.results[2]?.error?.code).toBe("CUSTOMER_NOT_FOUND");
    lineman = first.results.slice(0, 2).map((r) => r.payment as PostedPayment);
    ids.linemanCash = lineman[0]?.id ?? "";
    // The permanent receipt number replaces the phone's temporary one (#9).
    expect(lineman.map((p) => p.provisional_ref)).toEqual(
      payments.slice(0, 2).map((p) => p.provisional_ref),
    );
    for (const posted of lineman) expect(posted.receipt_number).toMatch(/^R-\d{4}-\d{5}$/);
    expect(lineman[0]?.allocations).toEqual([
      expect.objectContaining({ period, amount_paise: 40_000, outstanding_after_paise: 20_000 }),
    ]);
    expect(lineman[1]?.balance_after_paise).toBe(10_000);

    // The phone sends it again, three times at once (a bad network): nothing is saved twice (#8).
    const replays = await Promise.all([push(), push(), push()]);
    for (const replay of replays) {
      const body = PaymentBatchResponse.parse(await replay.json());
      expect(body.results.map((r) => r.outcome)).toEqual(["duplicate", "duplicate", "rejected"]);
      expect(body.results.slice(0, 2).map((r) => r.payment)).toEqual(lineman);
    }
    const otherDetail = await phone(request, `/customers/${other.customerId}`);
    expect(otherDetail.status()).toBe(404);
    expect(ErrorResponse.parse(await otherDetail.json()).error.code).toBe("CUSTOMER_NOT_FOUND");
    const asha = CustomerDetailResponse.parse(
      await (await phone(request, `/customers/${ids.asha}`)).json(),
    );
    expect(asha.customer.balance_paise).toBe(10_000);
    expect(asha.open_bills.map((b) => b.outstanding_paise)).toEqual([10_000]);

    // The day: cash apart from UPI (#12).
    const businessDate = lineman[0]?.business_date ?? today;
    const day = CollectionDayResponse.parse(
      await (await phone(request, `/collections/${businessDate}`)).json(),
    ).session;
    expect(day).toMatchObject({ cash_total_paise: 40_000, upi_total_paise: 10_000, payment_count: 2 });

    // ₹350 handed over for ₹400 of cash: ₹50 short, with the reason.
    const handover = await request.post(`${API}/collections/${businessDate}/handover`, {
      ...lineArgs(),
      data: {
        submission_id: uuidv7(),
        cash_handed_over_paise: 35_000,
        discrepancy_reason: "short",
        note: "Gave change to a customer",
        unsynced_payment_count: 0,
        unsynced_cash_paise: 0,
      },
    });
    expect(handover.status()).toBe(200);
    expect(HandoverResponse.parse(await handover.json()).session).toMatchObject({
      status: "submitted",
      handover: { cash_expected_paise: 40_000, cash_handed_over_paise: 35_000 },
    });

    // Printing is recorded; "sent" is refused: the app never claims a message was sent (#11).
    const actions = await request.post(`${API}/receipts/actions:batch`, {
      ...lineArgs(),
      data: {
        actions: ["printed", "whatsapp_opened", "sent"].map((action) => ({
          id: uuidv7(),
          payment_id: ids.linemanCash,
          action,
          at: new Date().toISOString(),
        })),
      },
    });
    expect(
      ReceiptActionsResponse.parse(await actions.json()).results.map((r) => r.outcome),
    ).toEqual(["recorded", "recorded", "rejected"]);
  });

  test("6. the office accepts the lineman's cash and sees the phone's numbers on the payment", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const page = await ownerPage(browser);
    await page.goto("/home");
    // The phone signed in: the checklist is done and gone.
    await expect(page.getByRole("region", { name: "Get started" })).toHaveCount(0);
    const alerts = page.getByRole("region", { name: "To check" });
    await alerts.getByRole("link", { name: "1 cash handover to check" }).click();
    await expect(page).toHaveURL(/\/linemen\?date=/);
    await expect(page.getByTestId("total-cash")).toHaveText("₹400");
    await expect(page.getByTestId("total-upi")).toHaveText("₹100");
    const card = page.getByTestId("lineman-card").filter({ hasText: "Ravi Kumar" });
    await expect(card).toContainText("₹50 short");
    await card.click();
    await expect(page.getByTestId("cash-expected")).toHaveText("₹400");
    await expect(page.getByTestId("upi-total")).toHaveText("₹100");
    await expect(page.getByTestId("handed")).toHaveText("₹350");
    await expect(page.getByTestId("difference")).toHaveText("₹50 short");
    await page.getByRole("button", { name: "Accept" }).click();
    const sheet = page.getByRole("alertdialog", { name: "Accept this cash?" });
    await expect(sheet).toContainText("Ravi Kumar gave ₹350. Expected ₹400. ₹50 short.");
    await sheet.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText(`Accepted by ${OWNER_NAME} at`, { exact: false })).toBeVisible();

    // The lineman's cash payment on the web: permanent receipt no. and the phone's temporary no.
    const cash = lineman[0] as PostedPayment;
    await page.goto(`/payments/${cash.id}`);
    await expect(page.getByTestId("receipt-number")).toHaveText(cash.receipt_number);
    await expect(page.getByText(cash.provisional_ref, { exact: true })).toBeVisible();
    await expect(page.getByText("By a lineman")).toBeVisible();
    await expect(page.locator("main")).not.toContainText(/\bsent\b|delivered/i);
    await page.context().close();
  });

  test("7. the numbers agree on every page and on the phone; another business's pages are 404", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const page = await ownerPage(browser);
    // Owed: Asha ₹600 − ₹500 = ₹100; Chandu ₹900 − ₹800 = ₹100; Bina ₹50 credit.
    // Taken today: cash ₹800 + ₹400 = ₹1,200; UPI ₹300 + ₹100 = ₹400.
    await page.goto("/home");
    await expect(page.getByTestId("home-cash-today")).toContainText("Cash today₹1,200");
    await expect(page.getByTestId("home-upi-today")).toContainText("UPI today₹400");
    await expect(page.getByTestId("home-payments-today")).toHaveText("4 payments");
    await expect(page.getByTestId("home-billed")).toContainText("Bills made₹1,0503 bills");
    await expect(page.getByTestId("home-collected")).toContainText("Money taken₹1,600");
    await expect(page.getByTestId("home-due")).toContainText("Total due₹2002 customers owe money");

    await page.getByTestId("home-cash-today").click();
    await expect(page.getByTestId("total-cash")).toHaveText("₹1,200");
    await page.goto("/payments");
    await expect(page.getByTestId("total-cash")).toHaveText("₹1,200");
    await expect(page.getByTestId("total-upi")).toHaveText("₹400");
    await expect(page.getByTestId("total-count")).toHaveText("4 payments");

    await page.goto("/home");
    await page.getByTestId("home-billed").click();
    await expect(page.getByTestId("register-count")).toHaveText("3 bills");
    await expect(page.getByTestId("register-billed")).toHaveText("₹1,050");
    await expect(page.getByTestId("register-paid")).toHaveText("₹850");
    await expect(page.getByTestId("register-due")).toHaveText("₹200");

    await page.goto("/home");
    await page.getByTestId("home-due").click();
    await expect(page).toHaveURL(/\/reports\/dues$/);
    await expect(page.getByTestId("dues-totals-due")).toContainText("₹200");
    await expect(page.getByTestId("dues-totals-due")).toContainText("2 customers");
    await expect(page.getByTestId("dues-totals-credit")).toContainText("₹50");
    await expect(page.getByTestId("dues-totals-net")).toContainText("₹150");
    await expect(page.getByTestId("bucket-d0_30-amount")).toHaveText("₹200");
    await expect(page.getByTestId("bucket-d90_plus-amount")).toHaveText("₹0");
    const owe = page.getByRole("table", { name: "Customers who owe" });
    await expect(owe.getByRole("row").filter({ hasText: "Asha Devi" })).toContainText("₹100");
    await expect(owe.getByRole("row").filter({ hasText: "Chandu Lal" })).toContainText("₹100");
    const byArea = page.getByRole("table", { name: "Due by area" });
    await expect(byArea.getByRole("row").filter({ hasText: "North" })).toContainText(
      "₹200 due · 2 customers",
    );

    await page.goto("/reports/bills");
    await expect(page.getByTestId("bills-totals-count")).toContainText("3 bills");
    await expect(page.getByTestId("bills-totals-billed")).toContainText("₹1,050");
    await expect(page.getByTestId("bills-totals-paid")).toContainText("₹850");
    await expect(page.getByTestId("bills-totals-due")).toContainText("₹200");
    await page.goto("/reports/payments");
    await expect(page.getByTestId("payments-totals-count")).toContainText("4 payments");
    await expect(page.getByTestId("payments-totals-cash")).toContainText("₹1,200");
    await expect(page.getByTestId("payments-totals-upi")).toContainText("₹400");
    await expect(page.getByTestId("payments-totals-all")).toContainText("₹1,600");

    // Each customer's bill, Bills tab and History end on the same number.
    for (const [id, name, outstanding, closing] of [
      [ids.asha, "Asha Devi", "₹100", "₹100"],
      [ids.chandu, "Chandu Lal", "₹100", "₹100"],
      [ids.bina, "Bina Rao", "₹0", "₹50"],
    ] as const) {
      await page.goto(`/customers/${id}/history`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(name);
      await expect(page.getByTestId("statement-closing")).toContainText(closing);
      await page.goto(`/customers/${id}/bills`);
      const thisMonth = page
        .getByRole("table", { name: "Bills of this customer" })
        .getByRole("row")
        .filter({ hasText: month });
      await thisMonth.getByRole("link").first().click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(/^Bill /);
      await expect(page.getByTestId("bill-outstanding")).toHaveText(outstanding);
    }

    // The phone agrees.
    expect(await rosterBalances(request)).toEqual({
      "Asha Devi": 10_000,
      "Bina Rao": -5_000,
      "Chandu Lal": 10_000,
    });

    // Home in Hindi: the same numbers.
    await page.goto("/home");
    await page.getByRole("button", { name: "हिंदी" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    await expect(page.getByTestId("home-cash-today")).toContainText(
      `${hi("home.today.cash")}₹1,200`,
    );
    await expect(page.getByTestId("home-due")).toContainText(
      `${hi("home.due.title")}₹200${hi("home.due.customers", { count: 2 })}`,
    );
    await expectNoSideways(page);
    await page.getByRole("button", { name: "English" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    expect(en("home.today.cash")).toBe("Cash today");

    // Another business's customer, bill, payment and receipt: 404, like a made-up id (#1).
    for (const path of [
      `/customers/${other.customerId}`,
      `/customers/${other.customerId}/history`,
      `/bills/${other.invoiceId}`,
      `/payments/${other.paymentId}`,
      `/payments/${other.paymentId}/receipt`,
    ]) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(404);
    }
    await page.context().close();
  });

  test("8. a plan change after the bill and a reused VC leave the issued bills alone; no bill twice", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const page = await ownerPage(browser);

    // Bina moves to Gold today: ₹100 more goes on the next bill; this bill stays ₹250 (#5).
    await page.goto(`/customers/${ids.bina}/connections`);
    await page
      .locator(`[data-connection][data-vc="${vc.b1}"]`)
      .getByRole("link", { name: "Change plan" })
      .click();
    const form = page.locator("[data-change-form]");
    await form.getByLabel("New plan").selectOption({ label: "Gold · ₹350" });
    await expect(form).toContainText(`${month}: ₹100 extra will be added to the next bill.`);
    await form.getByRole("button", { name: "Save new plan" }).click();
    await expect(page.getByText("New plan saved.").first()).toBeVisible();
    await expect(page.locator(`[data-connection][data-vc="${vc.b1}"]`)).toContainText(
      "₹350 a month",
    );
    await page.goto("/bills/adjustments");
    await expect(page.getByTestId("adjustments-pending")).toContainText("₹100");

    // Chandu's box is removed and goes to Bina from tomorrow (#6).
    await page.goto(`/customers/${ids.chandu}/connections`);
    const chanduBox = page.locator(`[data-connection][data-vc="${vc.c1}"]`);
    await chanduBox.getByRole("button", { name: "Remove" }).click();
    const sheet = page.getByRole("alertdialog", { name: `Remove set-top box ${vc.c1} for good?` });
    await sheet.getByLabel("Why?", { exact: true }).selectOption({ label: "Moved away" });
    await sheet.getByRole("button", { name: "Remove" }).click();
    await expect(page.getByText("Connection removed.", { exact: true })).toBeVisible();
    await page.goto(`/customers/${ids.bina}/connections?add=1`);
    await page.getByLabel("VC number").fill(vc.c1);
    await page.getByLabel("Monthly rent").selectOption({ label: "Basic · ₹250" });
    await page.getByLabel("Start day").fill(tomorrow);
    await page.getByRole("button", { name: "Save connection" }).click();
    await expect(page.getByText("Connection added.", { exact: true })).toBeVisible();
    await expect(page.locator(`[data-connection][data-vc="${vc.c1}"]`)).toContainText(
      `Starts on ${formatBusinessDate(tomorrow, "en")}.`,
    );

    // Make this month's bills again: the preview has nobody to bill, the run makes no new bill and
    // the month still has its three (#4).
    await page.goto(`/bills/runs?month=${period}&preview=1`);
    await expect(page.getByTestId("preview-will-bill")).toHaveText(
      "No customer will get a new bill.",
    );
    await expect(page.getByTestId("preview")).toContainText(
      "3 customers already have a bill for this month.",
    );
    await page.getByRole("button", { name: "Make bills now" }).click();
    await page
      .getByRole("alertdialog", { name: `Make bills for ${month}?` })
      .getByRole("button", { name: "Make bills" })
      .click();
    await expect(page.getByTestId("run-summary")).toContainText(`Making bills for ${month}.`);
    await runJobs(db);
    await expect(page.getByTestId("run-summary")).toContainText(`Bills for ${month} are made.`, {
      timeout: 20_000,
    });
    // The run's numbers are the month's: still the same three bills.
    await expect(page.getByTestId("run-created")).toHaveText("3");
    await expect(page.getByTestId("run-total")).toHaveText("₹1,050");
    const monthBills = await db.withTenant(operatorId, (tx) =>
      tx.query.invoices.findMany({ where: (i, { eq }) => eq(i.period, period) }),
    );
    expect(monthBills).toHaveLength(3);
    await page.goto(`/bills/register?month=${period}`);
    await expect(page.getByTestId("register-count")).toHaveText("3 bills");
    await expect(page.getByTestId("register-billed")).toHaveText("₹1,050");

    // The issued bills: Bina's is still ₹250; Chandu's still lists the box he had this month.
    await page.goto(`/customers/${ids.bina}/bills`);
    await page
      .getByRole("table", { name: "Bills of this customer" })
      .getByRole("row")
      .filter({ hasText: month })
      .getByRole("link")
      .first()
      .click();
    await expect(page.getByTestId("bill-charges")).toHaveText("₹250");
    await expect(page.getByTestId("bill-connection")).toHaveCount(1);
    await page.goto(`/customers/${ids.chandu}/bills`);
    await page
      .getByRole("table", { name: "Bills of this customer" })
      .getByRole("row")
      .filter({ hasText: month })
      .getByRole("link")
      .first()
      .click();
    await expect(page.getByTestId("bill-connection")).toContainText(vc.c1);
    await expect(page.getByTestId("bill-charges")).toHaveText("₹200");

    // What the customers owe has not moved.
    await page.goto("/reports/dues");
    await expect(page.getByTestId("dues-totals-due")).toContainText("₹200");
    await expect(page.getByTestId("dues-totals-credit")).toContainText("₹50");
    await page.context().close();
  });

  test("9. the Owner undoes a payment: every page moves together, and the audit log shows it", async ({
    browser,
    request,
  }) => {
    test.setTimeout(180_000);
    const page = await ownerPage(browser);
    await page.goto(`/payments/${ids.binaPayment}`);
    await page.getByRole("link", { name: "Undo payment" }).click();
    await expect(page.getByTestId("undo-balance")).toHaveText(
      "Balance now: ₹50 credit. After: ₹250 due.",
    );
    await page.getByRole("radio", { name: "Wrong customer" }).click();
    await page.getByRole("textbox", { name: "Note" }).fill("It was Asha's son");
    await page.getByRole("button", { name: "Undo payment" }).click();
    await page
      .getByRole("alertdialog", { name: "Cancel this payment?" })
      .getByRole("button", { name: "Undo payment" })
      .click();
    await expect(page.getByTestId("payment-status")).toContainText("Cancelled");
    await expect(page.getByTestId("balance-now")).toHaveText("₹250 due");

    // Owed now: ₹100 + ₹100 + ₹250 = ₹450, no credit; UPI today is only the lineman's ₹100.
    await page.goto("/home");
    await expect(page.getByTestId("home-upi-today")).toContainText("UPI today₹100");
    await expect(page.getByTestId("home-payments-today")).toHaveText("3 payments");
    await expect(page.getByTestId("home-collected")).toContainText("Money taken₹1,300");
    await expect(page.getByTestId("home-due")).toContainText("Total due₹4503 customers owe money");
    await page.goto("/payments");
    await expect(page.getByTestId("total-upi")).toHaveText("₹100");
    // The register lists every payment and says which one is not counted.
    await expect(page.getByTestId("total-count")).toHaveText("4 payments");
    await expect(page.getByText("1 cancelled, not counted")).toBeVisible();
    await page.goto("/reports/dues");
    await expect(page.getByTestId("dues-totals-due")).toContainText("₹450");
    await expect(page.getByTestId("dues-totals-due")).toContainText("3 customers");
    await expect(page.getByTestId("dues-totals-credit")).toContainText("₹0");
    await page.goto("/reports/payments");
    await expect(page.getByTestId("payments-totals-all")).toContainText("₹1,300");
    await page.goto(`/bills/register?month=${period}`);
    await expect(page.getByTestId("register-paid")).toHaveText("₹600");
    await expect(page.getByTestId("register-due")).toHaveText("₹450");
    await page.goto(`/customers/${ids.bina}/history`);
    await expect(page.getByTestId("statement-closing")).toContainText("₹250");
    await expect(page.getByTestId("cancelled-later")).toHaveCount(1);
    expect((await rosterBalances(request))["Bina Rao"]).toBe(25_000);

    // Who changed what: the undo, in words, with the receipt number and Bina's code.
    await page.goto("/settings/audit");
    await expect(
      page
        .getByTestId("audit-event")
        .filter({
          hasText: `${OWNER_NAME} (Owner) cancelled payment ${binaReceipt} of ₹300 (customer 102)`,
        }),
    ).toHaveCount(1);
    await expect(
      page
        .getByTestId("audit-event")
        .filter({ hasText: `${OWNER_NAME} (Owner) accepted the cash of Ravi Kumar` }),
    ).toContainText("₹350");
    await page.context().close();
  });
});
