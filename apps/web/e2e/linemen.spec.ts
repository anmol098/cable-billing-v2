/**
 * The Linemen page and the cash handover review (T-062) against `next start` and a real, migrated
 * database: a lineman's payments (cash + UPI) and handover are seeded through the real core
 * services (as the phone's API will call them); the Owner sees the day's card (cash apart from
 * UPI, "₹50 short"), opens the review screen, accepts; a second lineman's handover is sent back
 * with a note. The page fits a 360px phone.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `shell.spec.ts`.
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
  collectionSessions,
  createDb,
  customers,
  type DbClient,
  devices,
  handoverEvents,
  operators,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { businessDateOf } from "@cb/domain";
import { expect, type Page, test } from "@playwright/test";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e linemen password 4321";

test.describe("linemen: day cards and handover review", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  const run = randomBytes(4).toString("hex");
  const ownerLogin = `e2e-linemen-owner-${run}`;
  let db: DbClient;
  let operatorId: string;
  const linemen: Record<"ravi" | "suresh", { id: string; ctx?: TenantContext }> = {
    ravi: { id: uuidv7() },
    suresh: { id: uuidv7() },
  };

  test.beforeAll(async () => {
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const runtime = createServiceRuntime({ db, logger: silentLogger });
    operatorId = uuidv7();
    const customerId = uuidv7();
    const ownerId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    const deviceIds: Record<string, string> = {};
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Linemen Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      await tx.insert(users).values({
        id: ownerId,
        operatorId,
        role: "owner",
        name: "E2E Owner",
        login: ownerLogin,
        email: `${ownerLogin}@cable.test`,
        language: "en",
      });
      await tx.insert(accounts).values({
        id: uuidv7(),
        userId: ownerId,
        accountId: ownerId,
        providerId: "credential",
        password: hash,
      });
      for (const [key, name, code] of [
        ["ravi", "Ravi Kumar", "R2V"],
        ["suresh", "Suresh Pal", "S2P"],
      ] as const) {
        const id = linemen[key].id;
        await tx.insert(users).values({
          id,
          operatorId,
          role: "lineman",
          name,
          login: `e2e-linemen-${key}-${run}`,
          language: "hi",
        });
        const deviceId = uuidv7();
        deviceIds[key] = deviceId;
        await tx.insert(devices).values({
          id: deviceId,
          operatorId,
          userId: id,
          installId: uuidv7(),
          deviceCode: code,
          lastSeenAt: new Date(),
        });
      }
      await tx.insert(customers).values({
        id: customerId,
        operatorId,
        customerCode: "E2E-1",
        name: "Asha Devi",
      });
    });

    for (const key of ["ravi", "suresh"] as const) {
      const ctx = await resolveTenantContext(runtime, {
        userId: linemen[key].id,
        channel: "mobile",
        deviceId: deviceIds[key],
        requestId: newRequestId(),
      });
      if (!ctx.ok) throw new Error(`lineman context: ${ctx.error.code}`);
      linemen[key].ctx = ctx.value;
    }

    const pay = async (ctx: TenantContext, amountPaise: number, method: "cash" | "upi") => {
      const result = await postPayment.call(runtime, ctx, {
        id: uuidv7(),
        customerId,
        amountPaise,
        method,
        ...(method === "upi" ? { upiReference: "123456789012" } : {}),
        recordedAt: new Date(Date.now() - 5_000).toISOString(),
        provisionalRef: "P-E2E-0001",
      });
      if (!result.ok) throw new Error(`payment: ${result.error.code}`);
    };
    const ravi = linemen.ravi.ctx as TenantContext;
    const suresh = linemen.suresh.ctx as TenantContext;
    // Ravi: ₹500 + ₹300 cash, ₹200 UPI; hands over ₹750 (₹50 short).
    await pay(ravi, 50_000, "cash");
    await pay(ravi, 30_000, "cash");
    await pay(ravi, 20_000, "upi");
    // Suresh: ₹400 cash; hands over ₹400.
    await pay(suresh, 40_000, "cash");
    const today = businessDateOf(new Date(Date.now() - 5_000));
    for (const [ctx, cash, reason] of [
      [ravi, 75_000, "short"],
      [suresh, 40_000, null],
    ] as const) {
      const submitted = await submitHandover.call(runtime, ctx, {
        businessDate: today,
        submissionId: uuidv7(),
        cashHandedOverPaise: cash,
        discrepancyReason: reason,
        note: reason ? "Gave change to a customer" : null,
        unsyncedPaymentCount: 0,
        unsyncedCashPaise: 0,
      });
      if (!submitted.ok) throw new Error(`handover: ${submitted.error.code}`);
    }
  });

  test.afterAll(async () => {
    await db?.end();
  });

  async function signIn(page: Page) {
    await page.goto("/login");
    await page.getByLabel("Mobile no., user name or email").fill(ownerLogin);
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/home$/);
  }

  const card = (page: Page, name: string) =>
    page.getByTestId("lineman-card").filter({ hasText: name });

  const sessionOf = async (linemanId: string) => {
    const rows = await db.withTenant(operatorId, (tx) => tx.select().from(collectionSessions));
    return rows.find((r) => r.collectorId === linemanId);
  };

  test("the Owner accepts a handover from the Linemen page", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.goto("/linemen");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Linemen");
    // Day totals: cash and UPI apart.
    await expect(page.getByTestId("total-cash")).toHaveText("₹1,200");
    await expect(page.getByTestId("total-upi")).toHaveText("₹200");
    await expect(page.getByText("2 handovers to check")).toBeVisible();

    const ravi = card(page, "Ravi Kumar");
    await expect(ravi).toContainText("Waiting for check");
    await expect(ravi).toContainText("₹800");
    await expect(ravi).toContainText("₹200");
    await expect(ravi).toContainText("3 payments");
    await expect(ravi).toContainText("₹50 short");
    await ravi.click();

    await expect(page).toHaveURL(new RegExp(`/linemen/${linemen.ravi.id}\\?date=`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Ravi Kumar");
    await expect(page.getByTestId("cash-expected")).toHaveText("₹800");
    await expect(page.getByTestId("upi-total")).toHaveText("₹200");
    await expect(page.getByTestId("handed")).toHaveText("₹750");
    await expect(page.getByTestId("difference")).toHaveText("₹50 short");
    await expect(page.getByText("Less cash")).toBeVisible();
    await expect(page.getByText("Gave change to a customer").first()).toBeVisible();

    await page.getByRole("button", { name: "Accept" }).click();
    const sheet = page.getByRole("alertdialog", { name: "Accept this cash?" });
    await expect(sheet).toContainText("Ravi Kumar gave ₹750. Expected ₹800. ₹50 short.");
    await sheet.getByRole("button", { name: "Accept" }).click();
    await expect(page.getByText("Cash accepted", { exact: true })).toBeVisible();
    await expect(page.getByText(/Accepted by E2E Owner at/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Accept" })).toHaveCount(0);

    const session = await sessionOf(linemen.ravi.id);
    expect(session?.status).toBe("accepted");
    const events = (
      await db.withTenant(operatorId, (tx) => tx.select().from(handoverEvents))
    ).filter((e) => e.sessionId === session?.id);
    expect(events.map((e) => e.type).sort()).toEqual(["accepted", "submitted"]);

    // Back on the list the card is accepted and one handover is left to check.
    await page.getByRole("link", { name: "All linemen" }).click();
    await expect(card(page, "Ravi Kumar")).toContainText("Accepted");
    await expect(page.getByText("1 handover to check")).toBeVisible();
  });

  test("the Owner sends a handover back with a note; the page fits a phone", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 360, height: 800 });
    await signIn(page);
    await page.goto("/linemen");
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    await card(page, "Suresh Pal").click();
    await expect(page.getByTestId("difference")).toHaveText("Cash matches");
    await page.getByRole("button", { name: "Send back" }).click();
    const dialog = page.getByRole("dialog", { name: "Send this handover back?" });
    await dialog.getByLabel("What should the lineman fix?").fill("Bring the ₹100 notes");
    await dialog.getByRole("button", { name: "Send back" }).click();
    await expect(page.getByText("Sent back to the lineman", { exact: true })).toBeVisible();
    await expect(page.getByText(/Sent back by E2E Owner at/)).toBeVisible();
    expect((await sessionOf(linemen.suresh.id))?.reviewNote).toBe("Bring the ₹100 notes");
  });
});
