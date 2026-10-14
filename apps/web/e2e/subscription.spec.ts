/**
 * Settings → App subscription (T-085) against `next start`, a real migrated database and the local
 * Razorpay mock (`e2e/support/razorpay-mock.mjs`; Checkout's script is replaced by a fake in the
 * browser). Nothing reaches Razorpay.
 *
 * - A read-only Owner sees "View only", pays ₹472 a month through (fake) Checkout; the server
 *   verifies the signature, reads the subscription from the mock API and the tenant is active
 *   again (banner gone), at 360px too.
 * - Closing Checkout says the payment was not finished.
 * - The webhook route: bad signature 401, a signed charge 200, the same event again "duplicate".
 * - Staff get 404 on the page.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like the other specs.
 */
import { createHmac, randomBytes } from "node:crypto";
import { hashPassword } from "@cb/core";
import {
  accounts,
  createDb,
  type DbClient,
  operators,
  type SubscriptionStatus,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const MOCK = process.env.E2E_RAZORPAY_MOCK_URL ?? "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? "";
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const PASSWORD = "e2e subscription pass 85";
const PHONE = { width: 360, height: 800 };
const CHECKOUT_JS = "https://checkout.razorpay.com/v1/checkout.js";
/** Stands in for Razorpay Checkout: keeps the options so the test can play the customer. */
const FAKE_CHECKOUT = `window.Razorpay = function (options) {
  this.open = function () { window.__rzp = options; };
};`;

const hmac = (text: string, secret: string) =>
  createHmac("sha256", secret).update(text).digest("hex");

test.describe("app subscription", () => {
  test.skip(!DATABASE_URL || !MOCK, "needs DATABASE_URL and the Razorpay mock (playwright.config)");

  const run = randomBytes(4).toString("hex");
  const login = (who: string) => `e2e-sub-${who}-${run}`;
  let db: DbClient;
  const tenants: Record<string, string> = {};

  async function seedTenant(
    key: string,
    status: SubscriptionStatus,
    roles: ("owner" | "staff")[],
    razorpaySubscriptionId: string | null = null,
  ) {
    const operatorId = uuidv7();
    tenants[key] = operatorId;
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Sub ${key} Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status,
        trialEndsAt: new Date(Date.now() - 40 * 86_400_000),
        graceEndsAt: new Date(Date.now() + 5 * 86_400_000),
        razorpaySubscriptionId,
        razorpayStatus: razorpaySubscriptionId ? "created" : null,
      });
      for (const role of roles) {
        const id = uuidv7();
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${key} ${role}`,
          login: login(`${key}-${role}`),
          email: `e2e-sub-${key}-${role}-${run}@cable.test`,
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
    });
  }

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    await seedTenant("paying", "read_only", ["owner", "staff"]);
    await seedTenant("phone", "read_only", ["owner"]);
    await seedTenant("closing", "grace", ["owner"]);
    await seedTenant("hooked", "grace", ["owner"], `sub_E2eHook${run}`);
  });

  test.afterAll(async () => {
    await db?.end();
  });

  async function signIn(page: Page, who: string) {
    await page.route(CHECKOUT_JS, (route) =>
      route.fulfill({ contentType: "application/javascript", body: FAKE_CHECKOUT }),
    );
    await page.goto("/login");
    await page.getByLabel("Mobile no., user name or email").fill(login(who));
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/home$/);
  }

  const statusOf = async (key: string) => {
    const row = await db.withPlatform((tx) =>
      tx.query.subscriptions.findFirst({
        columns: { status: true, razorpaySubscriptionId: true },
        where: (s, { eq }) => eq(s.operatorId, tenants[key] ?? ""),
      }),
    );
    return row ? { status: row.status, sub: row.razorpaySubscriptionId } : undefined;
  };

  /** Opens the page, presses Pay, and returns the subscription Checkout was opened with. */
  async function openCheckout(page: Page): Promise<string> {
    await page.goto("/settings/subscription");
    await page.getByRole("button", { name: "Pay ₹472 a month" }).click();
    const subscriptionId = await page.waitForFunction(
      () => (window as unknown as { __rzp?: { subscription_id: string } }).__rzp?.subscription_id,
    );
    return String(await subscriptionId.jsonValue());
  }

  async function payAndConfirm(page: Page, subscriptionId: string) {
    // Razorpay charges the mandate (played by the mock), then Checkout calls the page's handler.
    const paidTill = Math.floor(Date.now() / 1000) + 30 * 86_400;
    const charged = await fetch(`${MOCK}/__test/subscriptions/${subscriptionId}`, {
      method: "POST",
      body: JSON.stringify({ status: "active", current_end: paidTill }),
    });
    expect(charged.ok).toBe(true);
    const paymentId = `pay_E2e${run}`;
    await page.evaluate(
      ([payment, subscription, signature]) =>
        (
          window as unknown as {
            __rzp: { handler: (r: Record<string, string>) => void };
          }
        ).__rzp.handler({
          razorpay_payment_id: payment,
          razorpay_subscription_id: subscription,
          razorpay_signature: signature,
        }),
      [paymentId, subscriptionId, hmac(`${paymentId}|${subscriptionId}`, KEY_SECRET)] as const,
    );
  }

  test("a read-only Owner pays ₹472 a month and the app works again", async ({ page }) => {
    await signIn(page, "paying-owner");
    await expect(page.getByRole("status").first()).toContainText("View only.");
    await page.goto("/settings/subscription");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("App subscription");
    await expect(page.getByText("You can look and collect money. Pay to make bills")).toBeVisible();
    await expect(page.getByText("₹472 a month")).toBeVisible();
    await expect(page.getByText("₹400 + ₹72 GST (18%)")).toBeVisible();

    const subscriptionId = await openCheckout(page);
    expect(subscriptionId).toMatch(/^sub_E2eMock/);
    expect(await statusOf("paying")).toEqual({ status: "read_only", sub: subscriptionId });

    // A forged handler call (wrong signature) changes nothing.
    await page.evaluate(
      ([subscription]) =>
        (
          window as unknown as { __rzp: { handler: (r: Record<string, string>) => void } }
        ).__rzp.handler({
          razorpay_payment_id: "pay_Forged",
          razorpay_subscription_id: subscription,
          razorpay_signature: "0".repeat(64),
        }),
      [subscriptionId] as const,
    );
    await expect(page.getByText("Something went wrong. Please try again.")).toBeVisible();
    expect((await statusOf("paying"))?.status).toBe("read_only");

    await payAndConfirm(page, subscriptionId);
    await expect(page.getByText(/Thank you\. Paid till/)).toBeVisible();
    expect((await statusOf("paying"))?.status).toBe("active");
    await page.reload();
    await expect(page.locator("[data-subscription-status]")).toHaveAttribute(
      "data-subscription-status",
      "active",
    );
    await expect(page.getByText(/Autopay is on/)).toBeVisible();
    await expect(page.locator("[data-shell='subscription-banner']")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Pay ₹472/ })).toHaveCount(0);
  });

  test("on a phone (360px): pay from the banner, no sideways scrolling", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page, "phone-owner");
    await page
      .locator("[data-shell='subscription-banner']")
      .getByRole("link", { name: "Pay now" })
      .click();
    await expect(page).toHaveURL(/\/settings\/subscription$/);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const subscriptionId = await openCheckout(page);
    await payAndConfirm(page, subscriptionId);
    await expect(page.getByText(/Thank you\. Paid till/)).toBeVisible();
    expect((await statusOf("phone"))?.status).toBe("active");
  });

  test("closing Checkout: the payment was not finished, nothing changes", async ({ page }) => {
    await signIn(page, "closing-owner");
    await openCheckout(page);
    await page.evaluate(() =>
      (
        window as unknown as { __rzp: { modal: { ondismiss: () => void } } }
      ).__rzp.modal.ondismiss(),
    );
    await expect(page.getByText("Payment was not finished.")).toBeVisible();
    expect((await statusOf("closing"))?.status).toBe("grace");
  });

  test("webhook: 401 without a valid signature; a signed event is stored once", async ({
    request,
  }) => {
    const subscriptionId = `sub_E2eHook${run}`;
    const body = JSON.stringify({
      entity: "event",
      event: "subscription.charged",
      contains: ["subscription"],
      payload: {
        subscription: {
          entity: {
            id: subscriptionId,
            status: "active",
            current_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
          },
        },
      },
      created_at: Math.floor(Date.now() / 1000),
    });
    const eventId = `evt_E2e${run}`;
    const post = (signature: string) =>
      request.post("/api/webhooks/razorpay", {
        data: body,
        headers: {
          "content-type": "application/json",
          "x-razorpay-signature": signature,
          "x-razorpay-event-id": eventId,
        },
      });
    expect((await post("0".repeat(64))).status()).toBe(401);
    const first = await post(hmac(body, WEBHOOK_SECRET));
    expect(first.status()).toBe(200);
    expect(await first.json()).toEqual({ ok: true, outcome: "applied" });
    expect((await statusOf("hooked"))?.status).toBe("active");
    const again = await post(hmac(body, WEBHOOK_SECRET));
    expect(await again.json()).toEqual({ ok: true, outcome: "duplicate" });
  });

  test("Staff can't open the subscription page (404)", async ({ page }) => {
    await signIn(page, "paying-staff");
    const response = await page.goto("/settings/subscription");
    expect(response?.status()).toBe(404);
  });
});
