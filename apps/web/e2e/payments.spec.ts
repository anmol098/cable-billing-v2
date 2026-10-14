/**
 * Counter payments, the payment register and the Owner's undo (T-048) against `next start` and a
 * real, migrated database. A customer with a ₹450 bill (issued the way the billing run does it):
 * Staff take ₹450 cash at the counter (amount pre-filled with the due, Save double-clicked → one
 * payment), print/copy the receipt, see it in the register and on the customer's Payments tab;
 * Staff cannot open the undo screen; the Owner undoes it with a reason → "Cancelled", the totals
 * leave it out and the customer's due is back to ₹450. A flagged payment is marked as checked.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `shell.spec.ts`.
 */
import { randomBytes } from "node:crypto";
import { hashPassword } from "@cb/core";
import {
  accounts,
  createDb,
  customerBalances,
  customers,
  type DbClient,
  invoices,
  ledgerEntries,
  operators,
  paymentReversals,
  payments,
  receipts,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { businessDateOf } from "@cb/domain";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e payments password 4321";

test.describe("payments: counter, register, undo", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const ownerLogin = `e2e-pay-owner-${run}`;
  const staffLogin = `e2e-pay-staff-${run}`;
  let db: DbClient;
  let operatorId: string;
  const customerId = uuidv7();
  const closedCustomerId = uuidv7();
  let paymentId = "";

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    const today = businessDateOf(new Date());
    const period = `${today.slice(0, 8)}01`;
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Payments Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const [login, role, name] of [
        [ownerLogin, "owner", "E2E Owner"],
        [staffLogin, "staff", "E2E Staff"],
      ] as const) {
        const userId = uuidv7();
        await tx.insert(users).values({
          id: userId,
          operatorId,
          role,
          name,
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
      await tx.insert(customers).values([
        {
          id: customerId,
          operatorId,
          customerCode: `P${run}`,
          name: "Asha Devi",
          phone: "9876543210",
        },
        {
          id: closedCustomerId,
          operatorId,
          customerCode: `Q${run}`,
          name: "Mohan Lal",
          status: "inactive",
        },
      ]);
      // A ₹450 bill for this month, as the billing run issues it (invoice + ledger + balance).
      const invoiceId = uuidv7();
      await tx.insert(invoices).values({
        id: invoiceId,
        operatorId,
        customerId,
        period,
        invoiceNumber: `INV-E2E-${run}`,
        openingBalancePaise: 0,
        chargesPaise: 45_000,
        totalDuePaise: 45_000,
      });
      await tx.insert(ledgerEntries).values({
        id: uuidv7(),
        operatorId,
        customerId,
        type: "invoice",
        amountPaise: 45_000,
        invoiceId,
      });
      await tx
        .insert(customerBalances)
        .values({ operatorId, customerId, balancePaise: 45_000, oldestDuePeriod: period });
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

  const balanceOf = async (id: string) => {
    const rows = await db.withTenant(operatorId, (tx) => tx.select().from(customerBalances));
    return rows.find((row) => row.customerId === id)?.balancePaise;
  };

  test("Staff take a counter payment: due pre-filled, double-click saves once, receipt actions", async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page, staffLogin);
    await page.goto("/payments");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments");
    await page.getByRole("link", { name: "Take payment" }).first().click();
    await expect(page).toHaveURL(/\/payments\/new$/);

    // 1. Who is paying?
    await page.getByRole("combobox", { name: "Find customer" }).fill("Asha");
    await page.getByRole("option", { name: /Asha Devi/ }).click();
    // 2. How much money? (the due is already there)
    await expect(page.getByTestId("due-now")).toHaveText("₹450");
    await expect(page.getByRole("textbox", { name: "Amount (₹)" })).toHaveValue("450");
    await page.getByRole("button", { name: "Next" }).click();
    // 3. Cash
    await page.getByRole("button", { name: "Cash" }).click();
    // 4. Check and save; a double click.
    await expect(page.getByTestId("confirm-summary")).toHaveText("₹450 Cash from Asha Devi");
    await page.getByTestId("save-payment").dblclick();
    await expect(page.getByRole("heading", { name: "Money saved" })).toBeVisible();
    const receiptNumber = (await page.getByTestId("saved-receipt").textContent()) ?? "";
    expect(receiptNumber).toMatch(/^R-\d{4}-\d{5}$/);
    await expect(page.getByTestId("saved-balance")).toHaveText("Nothing due");

    // Exactly one payment and one receipt, whatever the double click did.
    const stored = (await db.withTenant(operatorId, (tx) => tx.select().from(payments))).filter(
      (p) => p.customerId === customerId,
    );
    expect(stored).toHaveLength(1);
    paymentId = stored[0]?.id ?? "";
    expect(stored[0]).toMatchObject({ amountPaise: 45_000, method: "cash", source: "web" });
    const storedReceipts = (
      await db.withTenant(operatorId, (tx) => tx.select().from(receipts))
    ).filter((r) => r.paymentId === paymentId);
    expect(storedReceipts.map((r) => r.receiptNumber)).toEqual([receiptNumber]);
    expect(await balanceOf(customerId)).toBe(0);

    // Receipt: the A5 PDF opens (inline), and a link is copied (never "sent").
    const pdf = await page.request.get(`/payments/${paymentId}/receipt`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect(pdf.headers()["content-disposition"]).toMatch(/^inline;/);
    expect((await pdf.body()).subarray(0, 5).toString()).toBe("%PDF-");
    await page.getByRole("button", { name: "Copy receipt link" }).click();
    await expect(
      page.getByText("Link copied. Paste it in WhatsApp or SMS.", { exact: true }),
    ).toBeVisible();
    const link = await page.getByTestId("receipt-link").inputValue();
    expect(link).toMatch(/\/r\/[A-Za-z0-9_-]{43}$/);
    await expect(page.locator("body")).not.toContainText(/\bsent\b|delivered/i);
    const publicPage = await page.request.get(new URL(link).pathname);
    expect(publicPage.status()).toBe(200);
    expect(await publicPage.text()).toContain(receiptNumber);

    // The register shows it, with the cash total.
    await page.goto("/payments");
    await expect(page.getByTestId("total-cash")).toHaveText("₹450");
    await expect(page.getByTestId("total-count")).toHaveText("1 payment");
    const row = page.getByRole("link", { name: "Asha Devi" });
    await expect(row).toBeVisible();
    // The list renders as a table on wide screens and as cards on narrow ones (one is hidden).
    await expect(
      page.getByText(`Receipt ${receiptNumber}`).filter({ visible: true }),
    ).toBeVisible();

    // The customer's Payments tab shows it too.
    await page.goto(`/customers/${customerId}/payments`);
    await expect(page.getByRole("link", { name: "Asha Devi" })).toBeVisible();

    // Staff cannot undo: no button, and the undo screen is 404.
    await page.goto(`/payments/${paymentId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Payment ${receiptNumber}`);
    await expect(page.getByRole("link", { name: "Undo payment" })).toHaveCount(0);
    const undoPage = await page.goto(`/payments/${paymentId}/undo`);
    expect(undoPage?.status()).toBe(404);
  });

  test("the Owner undoes it with a reason: Cancelled, out of the totals, due restored", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    expect(paymentId).not.toBe("");
    await signIn(page, ownerLogin);
    await page.goto(`/payments/${paymentId}`);
    await page.getByRole("link", { name: "Undo payment" }).click();
    await expect(page).toHaveURL(new RegExp(`/payments/${paymentId}/undo$`));
    await expect(page.getByTestId("undo-balance")).toHaveText(
      "Balance now: Nothing due. After: ₹450 due.",
    );
    await page.getByRole("radio", { name: "Wrong amount" }).click();
    await page.getByRole("textbox", { name: "Note" }).fill("Customer paid only half");
    await page.getByRole("button", { name: "Undo payment" }).click();
    const sheet = page.getByRole("alertdialog", { name: "Cancel this payment?" });
    await expect(sheet).toContainText(
      "₹450 from Asha Devi will not count any more. Balance after: ₹450 due.",
    );
    await sheet.getByRole("button", { name: "Undo payment" }).click();

    await expect(page).toHaveURL(new RegExp(`/payments/${paymentId}\\?undone=1$`));
    await expect(page.getByText("Payment cancelled.", { exact: false })).toBeVisible();
    await expect(page.getByTestId("payment-status")).toContainText("Cancelled");
    await expect(page.getByTestId("cancellation")).toContainText(
      "Reason: Wrong amount: Customer paid only half",
    );
    await expect(page.getByTestId("balance-now")).toHaveText("₹450 due");
    await expect(page.getByRole("link", { name: "Undo payment" })).toHaveCount(0);

    // Append-only: the payment row is unchanged, one reversal row, the due is back.
    const [reversal, ...more] = (
      await db.withTenant(operatorId, (tx) => tx.select().from(paymentReversals))
    ).filter((r) => r.paymentId === paymentId);
    expect(more).toHaveLength(0);
    expect(reversal?.reason).toBe("wrong_amount: Customer paid only half");
    expect(await balanceOf(customerId)).toBe(45_000);

    // Register: cancelled, not in the cash total.
    await page.goto("/payments");
    await expect(page.getByTestId("total-cash")).toHaveText("₹0");
    await expect(page.getByText("1 cancelled, not counted")).toBeVisible();
    // Undo page lists it; the public receipt says Cancelled.
    await page.goto("/payments/reversals");
    await expect(page.getByRole("link", { name: "Asha Devi" })).toBeVisible();
    const again = await page.goto(`/payments/${paymentId}/undo`);
    expect(again?.status()).toBe(200);
    await expect(page.getByText("This payment is already cancelled.")).toBeVisible();
  });

  test("a payment for a closed customer is flagged and the office marks it checked (360px)", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await signIn(page, staffLogin);
    await page.goto(`/payments/new?customer=${closedCustomerId}`);
    await expect(page.getByTestId("chosen-customer")).toHaveText("Mohan Lal");
    await expect(page.getByText("This customer is closed.", { exact: false })).toBeVisible();
    await page.getByRole("textbox", { name: "Amount (₹)" }).fill("150");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "UPI" }).click();
    await page.getByRole("textbox", { name: "UPI ref no. (if you have it)" }).fill("412345678901");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByTestId("save-payment").click();
    await expect(page.getByRole("heading", { name: "Money saved" })).toBeVisible();
    await expect(
      page.getByText("The office will check this payment because: The customer is closed."),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await page.goto("/payments/review");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Payments to check");
    await page.getByRole("link", { name: "Mohan Lal" }).click();
    await expect(page.getByTestId("office-check")).toContainText("Why: The customer is closed");
    await page.getByRole("button", { name: "Mark as checked" }).click();
    const dialog = page.getByRole("dialog", { name: "Mark this payment as checked?" });
    await dialog.getByRole("textbox", { name: "Note (optional)" }).fill("Customer is moving back");
    await dialog.getByRole("button", { name: "Mark as checked" }).click();
    await expect(page.getByTestId("office-check")).toContainText("Checked by E2E Staff");
    await expect(page.getByTestId("office-check")).toContainText(
      "Office note: Customer is moving back",
    );
    await page.goto("/payments/review");
    await expect(page.getByText("Nothing to check. All payments look fine.")).toBeVisible();
    for (const path of [
      "/payments",
      "/payments/review",
      `/customers/${closedCustomerId}/payments`,
    ]) {
      await page.goto(path);
      const sideways = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(sideways, path).toBeLessThanOrEqual(0);
    }
  });
});
