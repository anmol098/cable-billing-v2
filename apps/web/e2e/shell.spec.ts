/**
 * Operator app shell smoke tests (T-029) against `next start` and a real, migrated database:
 * sign in, open every section and page, the phone layout at 360px, what Staff can't see, the
 * subscription banner, and signing out.
 *
 * Needs `DATABASE_URL` (migrated) and `BETTER_AUTH_SECRET`, like `auth.spec.ts`. Each run seeds
 * its own operators and users with random names.
 */
import { hashPassword } from "@cb/core";
import {
  accounts,
  createDb,
  customers,
  type DbClient,
  operators,
  type SubscriptionStatus,
  subscriptions,
  users,
  uuidv7,
} from "@cb/db";
import { expect, type Page, test } from "@playwright/test";
import en from "../messages/en.json" with { type: "json" };
import hi from "../messages/hi.json" with { type: "json" };
import { allRoutes, isDynamicPath, NAV } from "../src/lib/nav";
import { newSeedId } from "./_support/unique";

const DATABASE_URL = process.env.DATABASE_URL;
const PASSWORD = "e2e shell password 4321";
const PHONE = { width: 360, height: 800 };
const DESKTOP = { width: 1280, height: 800 };
const SOME_ID = "0190a3b2-0000-7000-8000-000000000001";
const SECTION_NAMES = NAV.map((section) => en.shell.routes[section.id]);

/**
 * A real customer of the "Active" tenant: built customer pages answer 404 for made-up ids (T-033).
 * Its id is made in each beforeAll, with the rest of the seed (see _support/unique.ts).
 */
let customerId = "";
const CUSTOMER_NAME = "E2E Shell Customer";

/** The URL to open for a route (other dynamic segments get a made-up id: placeholders ignore it). */
const urlOf = (path: string) =>
  path.startsWith("/customers/[id]")
    ? path.replace("[id]", customerId)
    : path.replace("[id]", SOME_ID);

/** Customer profile tabs that are built (their title is the customer's name, T-033 / T-034 / T-048 / T-049). */
const BUILT_PROFILE_TABS = new Set<string>([
  "customer_summary",
  "customer_connections",
  "customer_payments",
  "customer_bills",
  "customer_history",
]);

/** The page title of a route: its menu word, or the customer's name on a built profile tab. */
const titleOf = (id: keyof typeof en.shell.routes) =>
  BUILT_PROFILE_TABS.has(id) ? CUSTOMER_NAME : en.shell.routes[id];

test.describe("operator shell", () => {
  test.skip(!DATABASE_URL, "needs DATABASE_URL (a migrated database) and BETTER_AUTH_SECRET");

  // Made fresh in every beforeAll (see _support/unique.ts), so a second seed never collides.
  let run = "";
  const login = (who: string) => `e2e-shell-${who}-${run}`;
  const business = (name: string) => `${name} Cable ${run}`;
  let db: DbClient;

  async function seedTenant(
    name: string,
    status: SubscriptionStatus,
    people: ReadonlyArray<readonly [who: string, role: "owner" | "staff"]>,
  ) {
    const operatorId = uuidv7();
    const hash = await hashPassword(PASSWORD);
    await db.withTenant(operatorId, async (tx) => {
      await tx.insert(operators).values({ id: operatorId, name: business(name) });
      await tx.insert(subscriptions).values({
        operatorId,
        status,
        trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
        // 2026-10-25 12:00 IST, shown as "25 Oct 2026".
        graceEndsAt: status === "grace" ? new Date("2026-10-25T06:30:00Z") : null,
      });
      for (const [who, role] of people) {
        const id = uuidv7();
        await tx.insert(users).values({
          id,
          operatorId,
          role,
          name: `E2E ${who}`,
          login: login(who),
          email: `e2e-shell-${who}-${run}@cable.test`,
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
      if (name === "Active") {
        await tx
          .insert(customers)
          .values({ id: customerId, operatorId, customerCode: "1", name: CUSTOMER_NAME });
      }
    });
  }

  test.beforeAll(async () => {
    run = newSeedId();
    customerId = uuidv7();
    db = createDb({ connectionString: DATABASE_URL ?? "", max: 2 });
    await seedTenant("Active", "active", [
      ["owner", "owner"],
      ["staff", "staff"],
    ]);
    await seedTenant("Grace", "grace", [["grace-owner", "owner"]]);
    await seedTenant("Locked", "read_only", [["locked-staff", "staff"]]);
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

  async function expectNoSideways(page: Page) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `horizontal scroll on ${page.url()}`).toBeLessThanOrEqual(0);
  }

  test("desktop: the Owner opens every section from the sidebar and every page", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(DESKTOP);
    await signIn(page, "owner");

    await expect(page.getByText(business("Active"))).toBeVisible();
    await expect(page.getByRole("status")).toHaveCount(0); // active subscription: no banner
    await expect(page.getByRole("region", { name: "Get started" })).toBeVisible();

    const sidebar = page.getByRole("navigation", { name: "Main menu" });
    await expect(sidebar.getByRole("link")).toHaveText(SECTION_NAMES);
    for (const section of NAV) {
      const name = en.shell.routes[section.id];
      await sidebar.getByRole("link", { name }).click();
      await expect(page).toHaveURL(new RegExp(`${section.path}$`));
      await expect(heading(page)).toHaveText(name);
      await expect(sidebar.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
    }

    // Every page, including the sub-pages and the detail pages (placeholders until built).
    for (const route of allRoutes()) {
      const response = await page.goto(urlOf(route.path));
      // A built detail page doesn't know the made-up id: 404 like any unknown or other tenant's
      // id (T-062 `/linemen/[id]` is the first). Placeholders still answer 200 with their title.
      if (isDynamicPath(route.path) && response?.status() === 404) continue;
      expect(response?.status(), route.path).toBe(200);
      await expect(heading(page), route.path).toHaveText(titleOf(route.id));
    }

    // Section pages link to their sub-pages.
    await page.goto("/settings");
    await page.getByRole("link", { name: "Who changed what" }).click();
    await expect(page).toHaveURL(/\/settings\/audit$/);
    // Built by T-035 (no longer "Coming soon").
    await expect(heading(page)).toHaveText("Who changed what");
  });

  test("phone (360px): bottom bar + More, no sideways scrolling, in English and Hindi", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(PHONE);
    await signIn(page, "owner");

    const bar = page.getByRole("navigation", { name: "Main menu" });
    await expect(bar).toHaveCount(1); // the sidebar is hidden on phones
    await expect(bar.getByRole("link")).toHaveText(SECTION_NAMES.slice(0, 3));
    await expectNoSideways(page);

    for (const name of SECTION_NAMES.slice(0, 3)) {
      await bar.getByRole("link", { name }).click();
      await expect(heading(page)).toHaveText(name);
      await expectNoSideways(page);
    }
    for (const name of SECTION_NAMES.slice(3)) {
      await bar.getByRole("button", { name: "More" }).click();
      const more = page.getByRole("list", { name: "More pages" });
      await expect(more.getByRole("link")).toHaveText(SECTION_NAMES.slice(3));
      await more.getByRole("link", { name }).click();
      await expect(heading(page)).toHaveText(name);
      await expect(more).toBeHidden();
      await expectNoSideways(page);
    }

    // The bar stays at the bottom of the screen, clear of the page content's end.
    const box = await bar.boundingBox();
    expect(box && Math.round(box.y + box.height)).toBe(PHONE.height);

    // Every page fits at 360px.
    for (const route of allRoutes().filter((r) => !isDynamicPath(r.path))) {
      await page.goto(urlOf(route.path));
      await expectNoSideways(page);
    }

    // Hindi: one tap on the header switch; labels change, still no sideways scroll.
    await page.goto("/home");
    await page.getByRole("button", { name: "हिंदी" }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "hi");
    const hiBar = page.getByRole("navigation", { name: hi.shell.main_menu });
    await expect(hiBar.getByRole("link")).toHaveText(
      NAV.slice(0, 3).map((section) => hi.shell.routes[section.id]),
    );
    await expect(heading(page)).toHaveText(hi.shell.routes.home);
    await expectNoSideways(page);
    await hiBar.getByRole("button", { name: hi.shell.more }).click();
    await page.getByRole("link", { name: hi.shell.routes.settings }).click();
    await expect(heading(page)).toHaveText(hi.shell.routes.settings);
    await expectNoSideways(page);
  });

  test("Staff don't see Owner-only pages and can't open them", async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await signIn(page, "staff");
    await expect(page.getByRole("navigation", { name: "Main menu" }).getByRole("link")).toHaveText(
      SECTION_NAMES,
    );

    await page.goto("/settings");
    const settings = page.getByRole("navigation", { name: "Pages in Settings" });
    await expect(settings.getByRole("link")).toHaveText(["Business details", "Areas", "Plans"]);

    await page.goto("/reports");
    await expect(page.getByRole("link", { name: "Download data" })).toHaveCount(0);
    await page.goto("/payments");
    await expect(page.getByRole("link", { name: "Undo payment" })).toHaveCount(0);

    for (const path of [
      "/settings/team",
      "/settings/subscription",
      "/settings/audit",
      "/reports/export",
      "/payments/reversals",
      "/bills/adjustments",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(404);
    }

    // Staff's setup checklist has only their own step ("Add customers"), and this business already
    // has a customer, so it is done and the checklist is gone (T-083: steps tick from real data;
    // home.spec.ts checks Staff's one step on a new business).
    await page.goto("/home");
    await expect(page.getByRole("region", { name: "Get started" })).toHaveCount(0);
  });

  test("subscription banner: grace for the Owner, read-only for Staff", async ({ browser }) => {
    const ownerPage = await browser.newPage({ viewport: PHONE });
    await signIn(ownerPage, "grace-owner");
    const grace = ownerPage.getByRole("status");
    await expect(grace).toContainText("Pay for the app by 25 Oct 2026.");
    await grace.getByRole("link", { name: "Pay now" }).click();
    await expect(ownerPage).toHaveURL(/\/settings\/subscription$/);
    await expectNoSideways(ownerPage);
    await ownerPage.close();

    const staffPage = await browser.newPage({ viewport: DESKTOP });
    await signIn(staffPage, "locked-staff");
    const locked = staffPage.getByRole("status");
    await expect(locked).toContainText("View only. You can still collect money.");
    await expect(locked).toContainText("Ask the owner to pay for the app.");
    await expect(locked.getByRole("link")).toHaveCount(0);
    await staffPage.close();
  });

  test("the account menu signs out", async ({ page }) => {
    await page.setViewportSize(PHONE);
    await signIn(page, "owner");
    await page.getByRole("button", { name: "Account" }).click();
    await expect(page.getByText("E2E owner")).toBeVisible();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?notice=signed_out$/);
    await page.goto("/home");
    await expect(page).toHaveURL(/\/login\?next=%2Fhome$/);
  });
});
