/**
 * Settings → Who changed what (T-035) against `next start` and a real, migrated database: Staff get
 * a 404; the Owner sees changes as plain sentences (a seeded staff phone change, the Owner's own
 * sign-in, and an area the Owner adds in the app right before), opens "See what changed" (phones
 * masked to the last four digits, a new password "Hidden", the full values nowhere in the page),
 * filters by person, kind and change, pages to older changes and back, and reads it in Hindi.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `shell.spec.ts`.
 */
import { hashPassword, writeAuditEvent } from "@cb/core";
import {
  accounts,
  auditEvents,
  createDb,
  customers,
  type DbClient,
  operators,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { expect, type Page, test } from "@playwright/test";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e audit owner 2468";
const OLD_PHONE = "9700011122";
const NEW_PHONE = "9600022211";
const NEW_SECRET = "s3cret-should-never-show";
/** Older events, so the list has a second page (50 per page). */
const OLDER_EVENTS = 60;

test.describe("audit: who changed what", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let run = "";
  const login = (who: string) => `e2e-audit-${who}-${run}`;
  let db: DbClient;

  test.beforeAll(async () => {
    run = newSeedId();
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    const operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    const ids: Record<string, string> = {};
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: `Audit Cable ${run}` });
      await tx.insert(subscriptions).values({
        operatorId,
        status: "active",
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
      });
      for (const [who, role, name] of [
        ["owner", "owner", "Anil"],
        ["staff", "staff", "Ramesh"],
        ["lineman", "lineman", "Suresh"],
      ] as const) {
        const id = uuidv7();
        ids[who] = id;
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name,
          login: login(who),
          email: `${login(who)}@cable.test`,
          language: "en",
        });
        if (role !== "lineman") {
          await tx.insert(accounts).values({
            id: uuidv7(),
            userId: id,
            accountId: id,
            providerId: "credential",
            password: hash,
          });
        }
      }
      const customerId = uuidv7();
      await tx.insert(customers).values({
        id: customerId,
        operatorId,
        customerCode: "1045",
        name: "Sita Devi",
        phone: NEW_PHONE,
      });
      // Older events first (explicit times), then the two this test reads closely.
      const start = Date.now() - 10 * 86_400_000;
      await tx.insert(auditEvents).values(
        Array.from({ length: OLDER_EVENTS }, (_, i) => ({
          id: uuidv7(),
          operatorId,
          actorId: null,
          actorRole: null,
          action: "billing.run_scheduled",
          entityType: "billing_run",
          after: { period: "2026-09-01", trigger: "cron", status: "pending" },
          at: new Date(start + i * 60_000),
        })),
      );
      await writeAuditEvent(tx, {
        operatorId,
        actorId: ids.staff ?? null,
        actorRole: "staff",
        action: "customers.update_phone",
        entityType: "customer",
        entityId: customerId,
        before: { phone: OLD_PHONE },
        after: { phone: NEW_PHONE },
      });
      await writeAuditEvent(tx, {
        operatorId,
        actorId: ids.owner ?? null,
        actorRole: "owner",
        action: "team.reset_password",
        entityType: "user",
        entityId: ids.lineman ?? null,
        // The writer redacts the password before it reaches the table.
        after: { role: "lineman", password: NEW_SECRET, revoked_count: 1 },
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

  const events = (page: Page) => page.getByTestId("audit-event");

  test("Staff can't open it", async ({ page }) => {
    await signIn(page, "staff");
    const response = await page.goto("/settings/audit");
    expect(response?.status()).toBe(404);
  });

  test("the Owner reads, opens, filters and pages the changes", async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, "owner");

    // A real change made in the app shows up first.
    await page.goto("/settings/areas");
    // (With no areas yet, the empty state offers "Add area" too.)
    await page.getByRole("button", { name: "Add area" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add area" });
    await dialog.getByLabel("Area name").fill("Station road");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(dialog).toBeHidden();

    await page.goto("/settings/audit");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Who changed what");
    await expect(events(page).first()).toHaveText(/Anil \(Owner\) added area Station road/);
    await expect(
      events(page).filter({ hasText: "Anil (Owner) signed in on the website" }).first(),
    ).toBeVisible();

    // The staff phone change: masked numbers only.
    const phone = events(page).filter({
      hasText: "Ramesh (Staff) changed the phone of customer 1045",
    });
    await expect(phone).toHaveCount(1);
    await phone.getByText("See what changed").click();
    await expect(phone.getByRole("cell", { name: "XXXXXX1122" })).toBeVisible();
    await expect(phone.getByRole("cell", { name: "XXXXXX2211" })).toBeVisible();

    // The new password: "Hidden", never the value.
    const reset = events(page).filter({ hasText: "Anil (Owner) set a new password for Suresh" });
    await reset.getByText("See what changed").click();
    await expect(reset.getByText("Hidden")).toBeVisible();
    const html = await page.content();
    for (const secret of [OLD_PHONE, NEW_PHONE, NEW_SECRET]) expect(html).not.toContain(secret);

    // Filters: person, then kind + change.
    await page.locator("select[name=who]").selectOption({ label: "Ramesh (Staff)" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/who=/);
    // Only Ramesh's changes (his phone change, and his sign-in from the Staff test).
    await expect(
      events(page).filter({ hasText: "changed the phone of customer 1045" }),
    ).toHaveCount(1);
    await expect(events(page).filter({ hasNotText: "Ramesh (Staff)" })).toHaveCount(0);

    await page.goto("/settings/audit");
    await page.locator("select[name=what]").selectOption({ label: "Bills" });
    await page.locator("select[name=change]").selectOption({ label: "Bills set to be made" });
    await page.getByRole("button", { name: "Show" }).click();
    await expect(events(page)).toHaveCount(50);
    await expect(events(page).first()).toContainText("The app set the bills for September 2026");

    // Keyset pages: the remaining 10, then back to the newest.
    await page.getByRole("link", { name: "Older changes" }).click();
    await expect(page).toHaveURL(/after=/);
    await expect(events(page)).toHaveCount(OLDER_EVENTS - 50);
    await expect(page.getByRole("link", { name: "Older changes" })).toHaveCount(0);
    await page.getByRole("link", { name: "Back to the newest" }).click();
    await expect(page).not.toHaveURL(/after=/);
    await expect(events(page)).toHaveCount(50);

    // A hand-edited page link starts again from the newest instead of failing.
    const response = await page.goto("/settings/audit?after=not-a-real-cursor");
    expect(response?.status()).toBe(200);
    await expect(events(page).first()).toContainText("Anil (Owner) added area Station road");
  });

  test("reads in Hindi on a phone, without sideways scrolling", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 640 });
    await signIn(page, "owner");
    await page.context().addCookies([{ name: "NEXT_LOCALE", value: "hi", url: page.url() }]);
    await page.goto("/settings/audit");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("किसने क्या बदला");
    const phone = events(page).filter({
      hasText: "Ramesh (स्टाफ़) ने ग्राहक 1045 का मोबाइल नंबर बदला",
    });
    await expect(phone).toHaveCount(1);
    await phone.getByText("क्या बदला, देखें").click();
    await expect(phone.getByRole("cell", { name: "XXXXXX1122" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
