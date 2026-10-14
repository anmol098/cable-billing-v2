/**
 * CSV exports (T-082) against `next start` and a real, migrated database. One tenant:
 *
 * - आशा देवी (A-1, North): this month's ₹300 bill, ₹200 paid by UPI → owes ₹100.
 * - "=1+2 Rao" (B-2, South; a name that is also a spreadsheet formula): this month's ₹400 bill,
 *   ₹1,000 cash → ₹600 advance.
 *
 * This month's bills are made by the real billing run and job worker; payments by T-046's service.
 * The Owner downloads from "Download data" and from a report page; the files open as UTF-8 CSV with
 * Hindi intact, the formula neutralised and cash and UPI in separate columns, and every download is
 * in the audit log. Staff get 404 for the page and 403 for the files, and see no download link.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `reports.spec.ts`.
 */
import { readFile } from "node:fs/promises";
import {
  billingRunJob,
  createJobRegistry,
  createServiceRuntime,
  hashPassword,
  newRequestId,
  postPayment,
  resolveTenantContext,
  runJobWorker,
  silentLogger,
  startBillingRun,
} from "@cb/core";
import {
  accounts,
  areas,
  assignmentEvents,
  auditEvents,
  createDb,
  customers,
  type DbClient,
  operators,
  subscriptions,
  users,
  uuidv7,
  vcAssets,
  vcAssignments,
} from "@cb/db";
import { periodOfInstant } from "@cb/domain";
import { type Download, expect, type Page, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e exports password 4321";
const BOM = "﻿";

async function csvOf(download: Download): Promise<string> {
  return readFile((await download.path()) ?? "", "utf8");
}

test.describe("exports: Owner-only CSV downloads, audited", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  let run = "";
  let ownerLogin = "";
  let staffLogin = "";
  let ownerId = "";
  let staffId = "";
  let db: DbClient;
  let operatorId: string;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    run = newSeedId();
    ownerLogin = `e2e-exports-owner-${run}`;
    staffLogin = `e2e-exports-staff-${run}`;
    const period = periodOfInstant(new Date());
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const runtime = createServiceRuntime({ db, logger: silentLogger });
    operatorId = uuidv7();
    ownerId = uuidv7();
    staffId = uuidv7();
    const asha = uuidv7();
    const rao = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Exports Cable ${run}` });
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
      const north = uuidv7();
      const south = uuidv7();
      await tx.insert(areas).values([
        { id: north, operatorId, name: "North" },
        { id: south, operatorId, name: "South" },
      ]);
      for (const [id, code, name, areaId, rent] of [
        [asha, "A-1", "आशा देवी", north, 30_000],
        [rao, "B-2", "=1+2 Rao", south, 40_000],
      ] as const) {
        await tx
          .insert(customers)
          .values({ id, operatorId, customerCode: code, name, areaId, phone: "9876543210" });
        const assetId = uuidv7();
        await tx.insert(vcAssets).values({ id: assetId, operatorId, vcNumber: `VC-${code}` });
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
    });

    const owner = await resolveTenantContext(runtime, {
      userId: ownerId,
      channel: "web",
      requestId: newRequestId(),
    });
    if (!owner.ok) throw new Error(`owner context: ${owner.error.code}`);
    const started = await startBillingRun.call(runtime, owner.value, { period });
    if (!started.ok) throw new Error(`billing run: ${started.error.code}`);
    const report = await runJobWorker({
      db,
      registry: createJobRegistry([billingRunJob]),
      logger: silentLogger,
    });
    expect(report.failed).toBe(0);
    for (const [customerId, amountPaise, method] of [
      [asha, 20_000, "upi"],
      [rao, 100_000, "cash"],
    ] as const) {
      const paid = await postPayment.call(runtime, owner.value, {
        id: uuidv7(),
        customerId,
        amountPaise,
        method,
        ...(method === "upi" ? { upiReference: "123456789012" } : {}),
      });
      if (!paid.ok) throw new Error(`payment: ${paid.error.code}`);
    }
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

  /** The `after` of the person's `exports.download` events, oldest first (RLS: this tenant). */
  async function downloads(actor: string): Promise<unknown[]> {
    const rows = await db.withTenant(operatorId, (tx) =>
      tx
        .select({
          id: auditEvents.id,
          action: auditEvents.action,
          actorId: auditEvents.actorId,
          after: auditEvents.after,
        })
        .from(auditEvents),
    );
    return rows
      .filter((r) => r.action === "exports.download" && r.actorId === actor)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((r) => r.after);
  }

  test("the Owner downloads customers and payments from Download data", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, ownerLogin);
    await page.goto("/reports");
    await page.getByRole("link", { name: "Download data" }).click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Download data");
    await expect(page.getByRole("button", { name: "Download" })).toHaveCount(8);

    const customersCard = page.getByRole("form", { name: "Choose for Customers" });
    const customersFile = page.waitForEvent("download");
    await customersCard.getByRole("button", { name: "Download" }).click();
    const customersDownload = await customersFile;
    expect(customersDownload.suggestedFilename()).toMatch(
      /^customers-\d{4}-\d{2}-\d{2}-\d{4}\.csv$/,
    );
    const customersCsv = await csvOf(customersDownload);
    expect(customersCsv.startsWith(BOM)).toBe(true);
    const lines = customersCsv.slice(1).trimEnd().split("\r\n");
    expect(lines).toEqual([
      "Customer code,Customer name,Phone,Area,Customer,Due (₹),Advance (₹)",
      "A-1,आशा देवी,9876543210,North,Active,100,0",
      "B-2,'=1+2 Rao,9876543210,South,Active,0,600",
    ]);

    const paymentsCard = page.getByRole("form", { name: "Choose for Payments" });
    const paymentsFile = page.waitForEvent("download");
    await paymentsCard.getByRole("button", { name: "Download" }).click();
    const paymentsCsv = await csvOf(await paymentsFile);
    const [header, ...rows] = paymentsCsv.slice(1).trimEnd().split("\r\n");
    const columns = (header ?? "").split(",");
    const cash = columns.indexOf("Cash (₹)");
    const upi = columns.indexOf("UPI (₹)");
    expect(cash).toBeGreaterThan(-1);
    expect(upi).toBe(cash + 1);
    expect(rows).toHaveLength(2);
    const byCode = Object.fromEntries(
      rows.map((row) => {
        const cells = row.split(",");
        return [cells[columns.indexOf("Customer code")], [cells[cash], cells[upi]]];
      }),
    );
    expect(byCode).toEqual({ "A-1": ["", "200"], "B-2": ["1000", ""] });

    expect(await downloads(ownerId)).toEqual([
      expect.objectContaining({ report: "customers" }),
      expect.objectContaining({ report: "payments" }),
    ]);

    // The audit log says it in words.
    await page.goto("/settings/audit");
    await expect(page.getByRole("main")).toContainText("downloaded the customer list as a file");
    await expect(page.getByRole("main")).toContainText("downloaded the payment register as a file");
  });

  test("the Owner downloads a report with its filters from the report page", async ({ page }) => {
    await signIn(page, ownerLogin);
    await page.goto("/reports/dues?show=advance");
    const link = page.getByRole("link", { name: "Download this list" });
    await expect(link).toHaveAttribute("href", "/api/exports/dues?show=advance");
    const file = page.waitForEvent("download");
    await link.click();
    const download = await file;
    expect(download.suggestedFilename()).toMatch(/^dues-/);
    const lines = (await csvOf(download)).slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^B-2,'=1\+2 Rao,9876543210,South,0,600,0,0,0,0,,Active$/);
  });

  test("Staff can't download: no page, no file, no link, nothing audited", async ({ page }) => {
    await signIn(page, staffLogin);
    const response = await page.goto("/reports/export");
    expect(response?.status()).toBe(404);
    const file = await page.request.get("/api/exports/customers");
    expect(file.status()).toBe(403);
    expect(await file.text()).toBe("Only the owner can download data.");
    await page.goto("/reports/dues");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Due list");
    await expect(page.getByRole("link", { name: "Download this list" })).toHaveCount(0);
    expect(await downloads(staffId)).toEqual([]);
  });

  test("works in Hindi on a 360 px phone", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await signIn(page, ownerLogin);
    await page.goto("/reports/export");
    await page.getByRole("button", { name: "हिंदी" }).click();
    await expect(page.getByRole("button", { name: "डाउनलोड करें" })).toHaveCount(8);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const file = page.waitForEvent("download");
    await page
      .getByRole("form", { name: "ग्राहक के लिए चुनें" })
      .getByRole("button", { name: "डाउनलोड करें" })
      .click();
    const csv = await csvOf(await file);
    expect(csv.slice(1).split("\r\n")[0]).toBe(
      "ग्राहक कोड,ग्राहक का नाम,फ़ोन,एरिया,ग्राहक,बाकी (₹),एडवांस (₹)",
    );
    expect(csv).toContain("आशा देवी");
  });
});
