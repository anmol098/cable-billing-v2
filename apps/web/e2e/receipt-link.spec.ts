/**
 * Public receipt preview page and PDF (T-050) against `next start`.
 *
 * Without a database the page must still answer with the generic, noindex error page. With
 * `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET` in the environment of both the runner and the
 * server (the CI "Web e2e" job sets them), each run seeds its own operator, customer and payments
 * through the real services and checks the page with JavaScript disabled, the language switch,
 * the PDF download, revocation and a cancelled (reversed) payment.
 */
import { randomBytes } from "node:crypto";
import {
  createReceiptLink,
  createServiceRuntime,
  newRequestId,
  postPayment,
  resolveTenantContext,
  reversePayment,
  revokeReceiptLinks,
  type ServiceRuntime,
  silentLogger,
  type TenantContext,
} from "@cb/core";
import {
  createDb,
  customers,
  type DbClient,
  DEFAULT_OPERATOR_SETTINGS,
  operators,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { expect, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const UNKNOWN = randomBytes(32).toString("base64url");

function expectPrivateHeaders(response: { headers(): Record<string, string> }) {
  const headers = response.headers();
  expect(headers["x-robots-tag"]).toBe("noindex, nofollow, noarchive");
  expect(headers["cache-control"]).toContain("no-store");
  expect(headers["referrer-policy"]).toBe("no-referrer");
}

test("an unknown link gets the generic, bilingual, noindex page without JavaScript", async ({
  request,
}) => {
  const response = await request.get(`/r/${UNKNOWN}`);
  // 404 with a database; 503 (same kind of generic page) when the server has none configured.
  expect(response.status()).toBe(DATABASE_URL ? 404 : 503);
  expectPrivateHeaders(response);
  const html = await response.text();
  expect(html).not.toMatch(/<script/i);
  expect(html).toContain('<meta name="robots" content="noindex,nofollow,noarchive">');
  expect(html).toContain('lang="hi"');
  expect(html).toContain('lang="en"');
});

test.describe("receipt preview with a database", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");
  // One seed (beforeAll) for the whole group, in one worker.
  test.describe.configure({ mode: "serial" });

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let run = "";
  let db: DbClient;
  let runtime: ServiceRuntime;
  let owner: TenantContext;
  const tokens: Record<"paid" | "revoked" | "cancelled", string> = {
    paid: "",
    revoked: "",
    cancelled: "",
  };

  async function pay(customerId: string, amountPaise: number) {
    const posted = await postPayment.call(runtime, owner, {
      id: uuidv7(),
      customerId,
      amountPaise,
      method: "cash",
    });
    if (!posted.ok) throw new Error(`post payment: ${posted.error.code}`);
    const link = await createReceiptLink.call(runtime, owner, {
      paymentId: posted.value.payment.id,
    });
    if (!link.ok) throw new Error(`receipt link: ${link.error.code}`);
    return { paymentId: posted.value.payment.id, token: link.value.token };
  }

  test.beforeAll(async () => {
    run = newSeedId(8);
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    runtime = createServiceRuntime({ db, logger: silentLogger });
    const operatorId = uuidv7();
    const ownerId = uuidv7();
    const customerId = uuidv7();
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({
        id: operatorId,
        name: `E2E Receipt Cable ${run}`,
        phone: "9811122233",
        settings: {
          ...DEFAULT_OPERATOR_SETTINGS,
          receipt_footer: "Thank you",
          default_language: "en",
        },
      });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      await tx.insert(users).values({
        id: ownerId,
        operatorId,
        role: "owner",
        name: "E2E owner",
        login: `e2e-receipt-owner-${run}`,
        email: `e2e-receipt-owner-${run}@cable.test`,
        language: "en",
      });
      await tx.insert(customers).values({
        id: customerId,
        operatorId,
        customerCode: `E2E-${run}`,
        name: "Ramesh Kumar Verma",
        phone: "9876543210",
      });
    });
    const ctx = await resolveTenantContext(runtime, {
      userId: ownerId,
      channel: "web",
      requestId: newRequestId(),
    });
    if (!ctx.ok) throw new Error(`context: ${ctx.error.code}`);
    owner = ctx.value;

    tokens.paid = (await pay(customerId, 50_000)).token;
    const revoked = await pay(customerId, 10_000);
    tokens.revoked = revoked.token;
    const cancelled = await pay(customerId, 20_000);
    tokens.cancelled = cancelled.token;
    const revoke = await revokeReceiptLinks.call(runtime, owner, { paymentId: revoked.paymentId });
    if (!revoke.ok) throw new Error(`revoke: ${revoke.error.code}`);
    const reversal = await reversePayment.call(runtime, owner, {
      paymentId: cancelled.paymentId,
      reason: "E2E entered twice",
    });
    if (!reversal.ok) throw new Error(`reverse: ${reversal.error.code}`);
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("the receipt page works with JavaScript disabled and shows minimal personal data", async ({
    browser,
  }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    const response = await page.goto(`/r/${tokens.paid}`);
    expect(response?.status()).toBe(200);
    expectPrivateHeaders(response as NonNullable<typeof response>);
    await expect(page).toHaveTitle(/^Receipt R-\d{4}-\d{5}$/);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`E2E Receipt Cable ${run}`);
    await expect(page.locator(".amount")).toHaveText("₹500");
    // No bills yet, so the whole payment is credit.
    await expect(page.getByText("Credit", { exact: true })).toBeVisible();
    await expect(page.getByText("Cash", { exact: true })).toBeVisible();
    await expect(page.getByText("Ramesh", { exact: true })).toBeVisible();
    await expect(page.getByText("XXXXXX3210")).toBeVisible();
    await expect(page.getByText("Thank you")).toBeVisible();
    const body = await page.locator("body").innerText();
    for (const hidden of ["Kumar", "Verma", "9876543210", `E2E-${run}`, "E2E owner"]) {
      expect(body).not.toContain(hidden);
    }
    expect(await page.locator("script").count()).toBe(0);

    // The language switch is a plain link.
    await page.getByRole("link", { name: "हिंदी" }).click();
    await expect(page).toHaveURL(/\?lang=hi$/);
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("रसीद");
    await expect(page.getByText("नकद", { exact: true })).toBeVisible();
    await context.close();
  });

  test("the page fits a 360px phone, and the PDF downloads from it", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto(`/r/${tokens.paid}?lang=hi`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.goto(`/r/${tokens.paid}?lang=en`);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download PDF" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^receipt-R-\d{4}-\d{5}\.pdf$/);
    const path = await download.path();
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("NotoSansDevanagari");
  });

  test("the PDF has the private headers", async ({ request }) => {
    const response = await request.get(`/r/${tokens.paid}/pdf?lang=hi`);
    expect(response.status()).toBe(200);
    expectPrivateHeaders(response);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    expect(response.headers()["content-disposition"]).toMatch(/^attachment; filename="receipt-R-/);
  });

  test("a revoked link looks exactly like an unknown one", async ({ request }) => {
    const unknown = await request.get(`/r/${UNKNOWN}`);
    const revoked = await request.get(`/r/${tokens.revoked}`);
    const revokedPdf = await request.get(`/r/${tokens.revoked}/pdf`);
    expect(revoked.status()).toBe(404);
    expect(revokedPdf.status()).toBe(404);
    expect(await revoked.text()).toBe(await unknown.text());
    expect(await revokedPdf.text()).toBe(await unknown.text());
  });

  test("a reversed payment shows the Cancelled stamp", async ({ page }) => {
    await page.goto(`/r/${tokens.cancelled}`);
    await expect(page.getByRole("status")).toHaveText("Cancelled");
    await expect(page.getByText("The office cancelled this payment.")).toBeVisible();
  });
});
