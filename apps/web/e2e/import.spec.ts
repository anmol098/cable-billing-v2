/**
 * Add customers from Excel/CSV (T-084) against `next start` and a real, migrated database: the
 * template downloads (Excel, Hindi CSV), upload → preview with every line's status and what to
 * fix → add → result → the "lines with problems" file (CSV, formula cells escaped), the customers
 * really saved with their connections, and uploading the same file again changing nothing. Also
 * the 360px phone layout and Staff access / no access for others.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `customers.spec.ts`. Every seed
 * makes its own operators (see _support/unique.ts).
 */
import { readFile } from "node:fs/promises";
import { hashPassword, readImportFile } from "@cb/core";
import {
  accounts,
  areas,
  createDb,
  customers,
  type DbClient,
  operators,
  plans,
  subscriptions,
  users,
  uuidv7,
  vcAssignments,
} from "@cb/db";
import { expect, type Page, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e import password 4321";
const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 900 };

/** The uploaded file: 2 boxes for 101, a bad phone, an existing code, an unknown area, a formula. */
const CSV = [
  "Customer code,Name,Mobile no.,Area,VC number,Plan,Rent (₹ per month),Start day",
  "101,Ramesh Kumar,+91 98765 43210,ward 5,E2E-VC-1,basic,,",
  "101,,,,E2E-VC-2,,300,",
  "",
  "102,Bad Phone,12,,,,,",
  "EX-1,Already Here,,,,,,",
  "103,Lost Area,,Nowhere,,,,",
  '104,"=HYPERLINK(""http://x"")",12,,,,,',
].join("\r\n");

test.describe("import customers", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  let run = "";
  const login = (who: string) => `e2e-import-${who}-${run}`;
  let db: DbClient;
  let operatorId = "";

  test.beforeAll(async () => {
    run = newSeedId();
    operatorId = uuidv7();
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Import Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const role of ["owner", "staff"] as const) {
        const id = uuidv7();
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${role}`,
          login: login(role),
          email: `e2e-import-${role}-${run}@cable.test`,
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
      await tx.insert(plans).values({ operatorId, name: "Basic", monthlyAmountPaise: 25_000 });
      await tx.insert(areas).values({ operatorId, name: "Ward 5" });
      await tx.insert(customers).values({ operatorId, customerCode: "EX-1", name: "Old Friend" });
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

  async function uploadFile(page: Page) {
    await page.getByLabel("The filled form (.xlsx or .csv)").setInputFiles({
      name: "my-customers.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`﻿${CSV}`, "utf8"),
    });
    await page.getByRole("button", { name: "Check the file" }).click();
    await expect(page.getByText("Step 3 of 3")).toBeVisible();
  }

  test("template → upload → preview with problems → add → problem file → upload again", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize(DESKTOP);
    await signIn(page, "owner");
    await page.goto("/customers/import");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Add from Excel");

    // 1. The forms download; the Excel form is a real workbook with our columns.
    const excel = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download Excel form" }).click();
    const template = await excel;
    expect(template.suggestedFilename()).toBe("customers-form.xlsx");
    const bytes = new Uint8Array(await readFile((await template.path()) ?? ""));
    expect(readImportFile(bytes)).toEqual({ ok: false, error: { code: "empty" } });
    const hindi = page.waitForEvent("download");
    await page.getByRole("link", { name: "CSV", exact: true }).click();
    const hindiCsv = await readFile((await (await hindi).path()) ?? "", "utf8");
    expect(hindiCsv).toContain("ग्राहक कोड,नाम,मोबाइल नंबर");

    // 2. Upload: a file without our columns stays on the step with the reason.
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("The filled form (.xlsx or .csv)").setInputFiles({
      name: "wrong.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Phone,Remarks\n1,2\n"),
    });
    await page.getByRole("button", { name: "Check the file" }).click();
    await expect(page.locator("#import-file-error")).toHaveText(
      "These columns are missing: Customer code, Name.",
    );
    await uploadFile(page);

    // 3. Preview: counts, then the problem lines with what to fix.
    await expect(page.getByText("1 customer ready to add")).toBeVisible();
    await expect(page.getByText("with 2 connections (VC)")).toBeVisible();
    await expect(page.getByText("1 already in the app: not changed")).toBeVisible();
    await expect(page.getByText("3 customers have a problem: not added")).toBeVisible();
    const table = page.locator("[data-view=table]");
    await expect(table.getByText("Mobile no. is not a phone number.").first()).toBeVisible();
    await expect(
      table.getByText('There is no area "Nowhere". Add it in Settings → Areas, or leave it empty.'),
    ).toBeVisible();
    await page.getByRole("button", { name: /All lines/ }).click();
    await expect(table.locator("tbody tr")).toHaveCount(6);

    // 4. Add: the ready customer with both boxes; the result says what happened.
    await page.getByRole("button", { name: "Add 1 customer" }).click();
    await expect(page.getByRole("heading", { name: "Done" })).toBeVisible();
    await expect(page.getByText("1 customer added")).toBeVisible();
    await expect(page.getByText("with 2 connections (VC)")).toBeVisible();
    // (RLS limits both reads to this seed's operator.)
    const saved = await db.withTenant(operatorId, (tx) => tx.select().from(customers));
    const ramesh = saved.find((row) => row.customerCode === "101");
    expect(ramesh?.phone).toBe("9876543210");
    expect(ramesh?.areaId).not.toBeNull();
    expect(saved.map((row) => row.customerCode).sort()).toEqual(["101", "EX-1"]);
    const boxes = await db.withTenant(operatorId, (tx) => tx.select().from(vcAssignments));
    expect(
      boxes
        .filter((box) => box.customerId === ramesh?.id)
        .map((box) => box.rentalAmountPaise)
        .sort(),
    ).toEqual([25_000, 30_000]);

    // 5. The problem file: the lines to fix, the reason, formulas made harmless.
    const csvDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download as CSV" }).click();
    const problems = await csvDownload;
    expect(problems.suggestedFilename()).toBe("customers-problems.csv");
    const problemCsv = await readFile((await problems.path()) ?? "", "utf8");
    const lines = problemCsv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe(
      "Line,Problem,Customer code,Name,Mobile no.,Other mobile no.,Address,Area,VC number,Plan,Rent (₹ per month),Start day",
    );
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^5,Mobile no\. is not a phone number\.,102,Bad Phone,12,/);
    expect(problemCsv).toContain(`"'=HYPERLINK(""http://x"")"`);

    // 6. Customer list has Ramesh; uploading the same file again adds nobody.
    await page.getByRole("button", { name: "Add another file" }).click();
    await uploadFile(page);
    await expect(page.getByText("0 customers ready to add")).toBeVisible();
    await expect(page.getByText("2 already in the app: not changed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Choose another file" })).toBeVisible();
    await page.goto("/customers?q=Ramesh");
    await expect(page.getByText("Ramesh Kumar").first()).toBeVisible();
  });

  test("fits a 360px phone, and Staff can use it", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page, "staff");
    await page.goto("/customers/import");
    await expect(page.getByRole("link", { name: "Download Excel form" })).toBeVisible();
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Next" }).click();
    await uploadFile(page);
    await expect(page.getByText("3 customers have a problem: not added")).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
