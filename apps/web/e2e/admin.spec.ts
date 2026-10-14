/**
 * Platform admin console (T-086) against `next start` and a real, migrated database:
 * - every admin route refuses anonymous visitors (→ sign in), tenant owners (→ /home) and an
 *   admin without 2-step sign-in (→ TOTP enrolment), server-side;
 * - the admin flow: overview metrics, operators list and detail, extend, offline payment,
 *   support access (reason, 2 hours, visible in the operator's own audit log, ended early →
 *   refused), job retry, Razorpay log, admin log, and adding an operator.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET` for both the runner and the server.
 */
import { createHmac } from "node:crypto";
import { hashPassword } from "@cb/core";
import {
  accounts,
  auditEvents,
  createDb,
  customers,
  type DbClient,
  jobs,
  operators,
  subscriptionEvents,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { expect, type Page, test } from "@playwright/test";
import { mobileFromSeed, newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e admin password 8642";
const ADMIN_ROUTES = [
  "/admin",
  "/admin/tenants",
  "/admin/tenants/new",
  "/admin/jobs",
  "/admin/razorpay",
  "/admin/audit",
];

test.describe("platform admin console", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");
  test.describe.configure({ mode: "serial" });

  let run = "";
  let db: DbClient;
  let operatorId = "";
  let failedJobId = "";
  let totpSecret = "";
  const login = (who: string) => `e2e-adm-${who}-${run}`;
  const business = () => `E2E Admin Cable ${run}`;
  const customerName = () => `E2E Secret Customer ${run}`;

  test.beforeAll(async () => {
    run = newSeedId();
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    const ownerId = uuidv7();
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: business() });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "trialing",
        trialEndsAt: new Date(Date.now() + 10 * 86_400_000),
      });
      await tx.insert(users).values({
        id: ownerId,
        operatorId,
        role: "owner",
        name: `E2E Owner ${run}`,
        login: login("owner"),
        email: `${login("owner")}@cable.test`,
        language: "en",
      });
      await tx.insert(accounts).values({
        id: uuidv7(),
        userId: ownerId,
        accountId: ownerId,
        providerId: "credential",
        password: hash,
      });
      await tx.insert(customers).values({
        id: uuidv7(),
        operatorId,
        customerCode: `E2E-${run}`,
        name: customerName(),
        phone: mobileFromSeed(run),
      });
    });
    const adminId = uuidv7();
    failedJobId = uuidv7();
    await db.withPlatform(async (tx) => {
      await tx.insert(users).values({
        id: adminId,
        operatorId: null,
        role: "platform_admin",
        name: `E2E Admin ${run}`,
        login: login("admin"),
        email: `${login("admin")}@cable.test`,
        language: "en",
      });
      await tx.insert(accounts).values({
        id: uuidv7(),
        userId: adminId,
        accountId: adminId,
        providerId: "credential",
        password: hash,
      });
      await tx.insert(jobs).values({
        id: failedJobId,
        operatorId,
        type: "e2e.admin_retry",
        payload: { run },
        status: "failed",
        attempts: 5,
        maxAttempts: 5,
        lastError: "Error: e2e failure",
        finishedAt: new Date(),
      });
      await tx.insert(subscriptionEvents).values({
        operatorId,
        razorpayEventId: `evt_e2e_${run}`,
        type: "subscription.charged",
        payload: { e2e: run },
        processingError: "unmatched_subscription",
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
    const answered = page.waitForResponse((r) => r.request().method() === "POST");
    await page.getByRole("button", { name: "Sign in" }).click();
    await answered;
  }

  test("anonymous visitors are sent to sign in from every admin route", async ({ page }) => {
    for (const route of [...ADMIN_ROUTES, `/admin/tenants/${operatorId}/support`]) {
      await page.goto(route);
      await expect(page, route).toHaveURL(/\/login\?next=%2Fadmin/);
    }
  });

  test("an operator's owner never reaches the console", async ({ page }) => {
    await signIn(page, "owner");
    await expect(page).toHaveURL(/\/home$/);
    for (const route of [...ADMIN_ROUTES, `/admin/tenants/${operatorId}`]) {
      await page.goto(route);
      await expect(page, route).toHaveURL(/\/home$/);
    }
  });

  test("an admin must turn on 2-step sign-in before any admin page", async ({ page }) => {
    await signIn(page, "admin");
    await expect(page).toHaveURL(/\/login\/2fa\/setup$/);
    for (const route of ADMIN_ROUTES) {
      await page.goto(route);
      await expect(page, route).toHaveURL(/\/login\/2fa\/setup$/);
    }
    await page.getByLabel("Your password").fill(PASSWORD);
    await page.getByRole("button", { name: "Next" }).click();
    totpSecret = (await page.getByTestId("totp-secret").textContent())?.trim() ?? "";
    await page.getByLabel("6-digit code from the app").fill(totp(totpSecret));
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
  });

  test("admin flow: operators, subscription, support access, jobs, logs", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, "admin");
    await expect(page).toHaveURL(/\/login\/2fa$/);
    await page.getByLabel("6-digit code").fill(totp(totpSecret));
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.locator('[data-metrics="billing"]')).toBeVisible();

    // Operators list → detail. Counts only, never a customer's name.
    await page.goto(`/admin/tenants?q=${encodeURIComponent(business())}`);
    const row = page.locator('table[data-view="table"] tr', { hasText: business() });
    await expect(row).toContainText("Free trial");
    await row.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/admin/tenants/${operatorId}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(business());
    await expect(page.locator('[data-tenant="counts"]')).toContainText("1");
    await expect(page.locator("body")).not.toContainText(customerName());

    // Extend the subscription through a date: trial → paid.
    const year = new Date().getUTCFullYear() + 1;
    await page.getByLabel("Paid till (last day)").fill(`${year}-01-31`);
    await page.getByLabel("Why?").fill("Migrated operator, paid by cheque");
    await page.getByRole("button", { name: "Extend" }).click();
    await expect(page.locator('[data-outcome="success"]')).toHaveText("Subscription extended.");
    await expect(page.locator('[data-tenant="subscription"]')).toContainText("Paid");

    // Record an offline payment (whole rupees; idempotent form).
    await page.getByLabel("Amount received (₹)").fill("472");
    await page.getByLabel("Reference (UTR, cheque no.)").fill(`UTR${run}`);
    await page.getByRole("button", { name: "Save payment" }).click();
    await expect(page.locator('[data-outcome="success"]')).toHaveText(
      "Payment saved and subscription extended.",
    );
    await expect(page.locator('[data-tenant="offline-payments"]')).toContainText("₹472");

    // Support access: refused without a grant, reason required, 2 hours, then ended early.
    await page.goto(`/admin/tenants/${operatorId}/support`);
    await expect(page.locator('[data-outcome="danger"]')).toContainText(
      "You don't have support access",
    );
    await page.goto(`/admin/tenants/${operatorId}`);
    await page.getByLabel("Why do you need access?").fill("Owner called: lineman cannot sign in");
    await page.getByRole("button", { name: "Open support access for 2 hours" }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/tenants/${operatorId}/support$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Support view: ${business()}`);
    await expect(page.locator('[data-support="team"]')).toContainText(`E2E Owner ${run}`);
    await expect(page.locator("body")).not.toContainText(customerName());
    await expect(page.locator("body")).not.toContainText(mobileFromSeed(run));
    await page.getByRole("link", { name: "Back to operator" }).click();
    await page.getByRole("button", { name: "End support access" }).click();
    await expect(page.locator('[data-outcome="success"]')).toHaveText("Support access ended.");
    await page.goto(`/admin/tenants/${operatorId}/support`);
    await expect(page.locator('[data-outcome="danger"]')).toContainText(
      "You don't have support access",
    );

    // The operator sees all of it in their own audit log.
    const tenantActions = await db.withTenant(operatorId, async (tx) =>
      (
        await tx
          .select({ action: auditEvents.action, role: auditEvents.actorRole })
          .from(auditEvents)
      )
        .filter((e) => e.role === "platform_admin")
        .map((e) => e.action),
    );
    expect(tenantActions).toEqual(
      expect.arrayContaining([
        "support.access_granted",
        "support.data_viewed",
        "support.access_ended",
        "subscription.state_changed",
        "subscription.offline_payment_recorded",
      ]),
    );

    // Jobs: try a failed job again, once.
    await page.goto("/admin/jobs?status=failed");
    const jobRow = page.locator('table[data-view="table"] tr', { hasText: business() }).filter({
      hasText: "e2e.admin_retry",
    });
    await jobRow.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator('[data-outcome="success"]')).toHaveText(
      "The job will run again in a few minutes.",
    );
    const copies = await db.withPlatform((tx) =>
      tx.query.jobs.findMany({
        where: (j, { and, eq }) => and(eq(j.type, "e2e.admin_retry"), eq(j.operatorId, operatorId)),
      }),
    );
    // The failed row stays as history; the copy waits (no handler claims this e2e type).
    expect(copies.map((c) => c.status).sort()).toEqual(["failed", "queued"]);

    // Razorpay log: the event, never its payload.
    await page.goto("/admin/razorpay?filter=problems");
    const event = page.locator('table[data-view="table"] tr', { hasText: `evt_e2e_${run}` });
    await expect(event).toContainText("unmatched_subscription");
    await expect(page.locator("body")).not.toContainText(`"e2e"`);

    // Admin log: what was done, by whom.
    await page.goto("/admin/audit");
    await expect(page.locator('table[data-view="table"]')).toContainText("admin.job_retried");
    await expect(page.locator('table[data-view="table"]')).toContainText(
      "admin.support_access_granted",
    );
    await expect(page.locator('table[data-view="table"]')).not.toContainText("admin.tenant_viewed");
    await page.getByRole("link", { name: "Also show page views" }).click();
    await expect(page.locator('table[data-view="table"]')).toContainText("admin.tenant_viewed");

    // Add an operator: the owner gets a "set your password" email; the trial starts.
    await page.goto("/admin/tenants/new");
    await page.getByLabel("Business name").fill(`E2E New Cable ${run}`);
    await page.getByLabel("Owner's name").fill(`E2E New Owner ${run}`);
    await page.getByLabel("Owner's email").fill(`e2e-new-${run}@cable.test`);
    await page.getByLabel("Owner's mobile number").fill(mobileFromSeed(`${run}1`));
    await page.getByRole("button", { name: "Add operator" }).click();
    await expect(page.locator('[data-outcome="success"]')).toHaveText(
      "Operator added. The owner got an email to set a password.",
    );
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`E2E New Cable ${run}`);
    await expect(page.locator('[data-tenant="subscription"]')).toContainText("Free trial");

    // The console reads in Hindi too (the language cookie, D-06).
    await page
      .context()
      .addCookies([{ name: "NEXT_LOCALE", value: "hi", url: new URL(page.url()).origin }]);
    await page.goto("/admin/tenants");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("ऑपरेटर");
    await expect(page.getByRole("link", { name: "ऑपरेटर जोड़ें" })).toBeVisible();
  });
});

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) from a base32 secret. */
function totp(base32Secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32Secret.replace(/=+$/, "")) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
