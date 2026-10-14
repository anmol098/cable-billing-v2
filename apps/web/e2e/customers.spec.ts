/**
 * Customers (T-033) against `next start` and a real, migrated database: add a customer through
 * the 3 steps (automatic code), a duplicate code shows a friendly error under the field, search by
 * name / phone / VC number / code with filters, the profile Summary with its tabs, change details,
 * close, phone layout, and another business's customer answering 404.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `auth.spec.ts`. Each run seeds
 * its own operators with random names.
 */
import { hashPassword } from "@cb/core";
import {
  accounts,
  areas,
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
import { expect, type Page, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e customers password 4321";
const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 800 };

test.describe("customers", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let run = "";
  const login = (who: string) => `e2e-cust-${who}-${run}`;
  let db: DbClient;
  const newIds = () => ({
    ramesh: uuidv7(),
    sunita: uuidv7(),
    closed: uuidv7(),
    karan: uuidv7(),
    otherTenantCustomer: uuidv7(),
  });
  let ids: ReturnType<typeof newIds>;
  const VC = "5550 1234 9876";

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
          email: `e2e-cust-${who}-${run}@cable.test`,
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
    run = newSeedId();
    ids = newIds();
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    await seedTenant(
      "Shiv Cable",
      [
        ["owner", "owner"],
        ["staff", "staff"],
      ],
      async (tx, operatorId) => {
        const north = uuidv7();
        await tx.insert(areas).values([
          { id: north, operatorId, name: "North" },
          { operatorId, name: "South" },
        ]);
        await tx.insert(customers).values([
          {
            id: ids.ramesh,
            operatorId,
            customerCode: "A-101",
            name: "Ramesh Kumar",
            phone: "9876543210",
            areaId: north,
          },
          {
            id: ids.sunita,
            operatorId,
            customerCode: "A-102",
            name: "Sunita Devi",
            phone: "9123456780",
          },
          {
            id: ids.closed,
            operatorId,
            customerCode: "A-103",
            name: "Old Mohan",
            status: "inactive",
          },
          {
            id: ids.karan,
            operatorId,
            customerCode: "B-1",
            name: "Karan Singh",
            phone: "9000000001",
          },
        ]);
        await tx.insert(customerBalances).values([
          {
            operatorId,
            customerId: ids.ramesh,
            balancePaise: 45_000,
            oldestDuePeriod: "2026-09-01",
          },
          {
            operatorId,
            customerId: ids.karan,
            balancePaise: 20_000,
            oldestDuePeriod: "2026-09-01",
          },
        ]);
        const vc = uuidv7();
        await tx.insert(vcAssets).values({ id: vc, operatorId, vcNumber: VC });
        await tx.insert(vcAssignments).values({
          operatorId,
          vcAssetId: vc,
          customerId: ids.sunita,
          startDate: "2026-07-01",
          rentalAmountPaise: 30_000,
        });
      },
    );
    await seedTenant("Other Cable", [["other-owner", "owner"]], async (tx, operatorId) => {
      await tx.insert(customers).values({
        id: ids.otherTenantCustomer,
        operatorId,
        customerCode: "A-101",
        name: "Ramesh Kumar Other",
      });
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
  const table = (page: Page) => page.getByRole("table", { name: "Customers" });

  async function expectNoSideways(page: Page) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal scroll on ${page.url()}`).toBeLessThanOrEqual(0);
  }

  test("Staff add a customer in 3 steps; the code is the next number", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(DESKTOP);
    await signIn(page, "staff");
    await page.goto("/customers");
    await page.getByRole("link", { name: "Add customer" }).click();
    await expect(page).toHaveURL(/\/customers\/new$/);
    await expect(heading(page)).toHaveText("Add customer");

    await expect(page.getByText("Step 1 of 3")).toBeVisible();
    await expect(page.getByLabel("Customer code")).toHaveAccessibleDescription(
      /^Leave it empty to use the next number \(\d+\)\.$/,
    );
    await page.getByLabel("Name").fill("Geeta Sharma");
    await page.getByLabel("Mobile no.", { exact: true }).fill("+91 98111 22233");
    await page.getByLabel("Area").selectOption({ label: "South" });
    await page.getByLabel("Address (optional)").fill("12, Station Road");
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Step 2 of 3")).toBeVisible();
    await page.getByRole("button", { name: "Next" }).click();
    await expect(page.getByText("Step 3 of 3")).toBeVisible();
    const check = page.locator("[data-check=customer]");
    await expect(check).toContainText(/Next number \(\d+\)/);
    await expect(check).toContainText("Geeta Sharma");
    await expect(check).toContainText("South");
    await page.getByRole("button", { name: "Save customer" }).click();

    await expect(page).toHaveURL(/\/customers\/[0-9a-f-]{36}$/);
    await expect(heading(page)).toHaveText("Geeta Sharma");
    await expect(page.getByText("Customer saved.", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Code \d+$/)).toBeVisible();
    await expect(page.getByText("9811122233")).toBeVisible();
    await expect(page.getByText("Nothing due")).toBeVisible();
  });

  test("a code that is already used shows a friendly error under the field", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(DESKTOP);
    await signIn(page, "owner");
    await page.goto("/customers/new");
    await page.getByLabel("Customer code").fill("a-101");
    await page.getByLabel("Name").fill("Someone Else");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Save customer" }).click();

    await expect(page.getByText("Step 1 of 3")).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Please fix" })).toHaveText(
      "Please fix the marked boxes.",
    );
    const code = page.getByLabel("Customer code");
    await expect(code).toHaveValue("a-101");
    await expect(code).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("Code a-101 is already used by another customer.")).toBeVisible();
    await page.getByRole("link", { name: "Open that customer" }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${ids.ramesh}$`));
    await expect(heading(page)).toHaveText("Ramesh Kumar");
  });

  test("search by name, phone, VC number and code; filters; open the profile", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(DESKTOP);
    await signIn(page, "staff");
    await page.goto("/customers");
    await expect(heading(page)).toHaveText("Customers");
    const rows = table(page).locator("tbody tr");
    await expect(table(page).getByRole("columnheader")).toHaveText([
      "Code",
      "Name",
      "Area",
      "Due",
      "Status",
    ]);

    const search = page.getByRole("searchbox", { name: "Find a customer" });
    await search.fill("ramesh");
    await expect(page).toHaveURL(/\?q=ramesh$/);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Ramesh Kumar");
    await expect(rows.first()).toContainText("North");
    await expect(rows.first()).toContainText("₹450");
    // Another business's "Ramesh Kumar" never shows.
    await expect(page.getByText("Ramesh Kumar Other")).toHaveCount(0);

    await search.fill("91234 56780");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Sunita Devi");

    await search.fill("555012349876");
    await expect(rows.first()).toContainText("Sunita Devi");
    await expect(rows.first()).toContainText(`VC ${VC}`);

    await search.fill("A-10");
    await expect(rows).toHaveCount(3);
    await page.getByLabel("Status").selectOption({ label: "Closed" });
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Old Mohan");
    await expect(rows.first()).toContainText("Closed");

    await search.fill("nobody like this");
    await expect(page.getByText(/No customer found/)).toBeVisible();

    await page.goto("/customers?q=sunita");
    await page.getByRole("link", { name: "Sunita Devi" }).click();
    await expect(page).toHaveURL(new RegExp(`/customers/${ids.sunita}$`));
    await expect(heading(page)).toHaveText("Sunita Devi");
    const tabs = page.getByRole("navigation", { name: "Customer pages" });
    await expect(tabs.getByRole("link")).toHaveText([
      "Summary",
      "Connections (VC)",
      "Bills",
      "Payments",
      "History",
    ]);
    await expect(tabs.getByRole("link", { name: "Summary" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.getByText(VC)).toBeVisible();
    await expect(page.getByText("₹300 a month")).toBeVisible();
    await expect(page.getByRole("link", { name: "Take payment" })).toHaveAttribute(
      "href",
      `/payments/new?customer=${ids.sunita}`,
    );
  });

  test("change details and close a customer", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(DESKTOP);
    await signIn(page, "owner");
    await page.goto(`/customers/${ids.karan}`);
    await expect(page.getByText("Unpaid since September 2026")).toBeVisible();
    await page.getByRole("link", { name: "Change details" }).click();
    await page.getByLabel("Mobile no.", { exact: true }).fill("98765 00000");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Changes saved.", { exact: true })).toBeVisible();
    await expect(page.getByText("9876500000")).toBeVisible();

    await page.goto(`/customers/${ids.sunita}`);
    await page.getByRole("button", { name: "Close customer" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, close" }).click();
    // Sunita still has a running connection: closing is refused in words.
    await expect(
      page.getByText("First stop this customer's connections (1) on the Connections tab.", {
        exact: true,
      }),
    ).toBeVisible();

    await page.goto(`/customers/${ids.karan}`);
    await page.getByRole("button", { name: "Close customer" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, close" }).click();
    await expect(page.getByText("Customer closed.", { exact: true })).toBeVisible();
    await expect(page.getByText("This customer is closed.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Make active again" })).toBeVisible();
  });

  test("another business's customer and made-up ids answer 404", async ({ page }) => {
    await signIn(page, "owner");
    for (const path of [
      `/customers/${ids.otherTenantCustomer}`,
      "/customers/0190a3b2-0000-7000-8000-000000000001",
      "/customers/not-an-id",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }
  });

  test("phone (360px): list, add and profile fit without sideways scrolling", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize(PHONE);
    await signIn(page, "staff");
    for (const path of ["/customers", "/customers/new", `/customers/${ids.sunita}`]) {
      await page.goto(path);
      await expectNoSideways(page);
    }
    // Cards on phones: the row's name is the link.
    await page.goto("/customers?q=ramesh");
    await expect(page.getByRole("list", { name: "Customers" }).getByRole("link")).toHaveText(
      "Ramesh Kumar",
    );
  });
});
